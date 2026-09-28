/**
 * HTTP + SSE gateway in front of acp-hub adapters.
 *
 * Downstream consumers (web frontends, mobile apps, scripts) speak plain
 * HTTP — no ACP, no Node SDK required:
 *
 *   POST   /api/agents/:agentId/sessions        { cwd, resumeSessionId? } → { sessionId }
 *   GET    /api/sessions/:sessionId/events      SSE: hello | events(batch) | turn_completed | error | closed
 *   POST   /api/sessions/:sessionId/prompt      { text } → 202 (stream arrives via SSE)
 *   POST   /api/sessions/:sessionId/permission  { requestId, optionId }
 *   POST   /api/sessions/:sessionId/interrupt
 *   DELETE /api/sessions/:sessionId
 *   GET    /api/health
 *
 * Streaming chunks are coalesced with the 10ms/100ms window scheme before
 * they hit the wire (see core batchEvents).
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import {
  AcpAgentAdapter,
  batchEvents,
  type AdapterLogger,
  type AdapterOptions,
  type AgentLaunchSpec,
  type AgentSession,
  type SessionEvent,
} from '@cc-heart/acp-hub-core';

export type PermissionPolicy = 'manual' | 'allow-once';

export interface GatewayAgentConfig {
  launch: AgentLaunchSpec;
  adapterOptions?: AdapterOptions;
  /** 'allow-once' auto-answers permission requests with the first allow_once option. Default 'manual'. */
  permissionPolicy?: PermissionPolicy;
}

export interface GatewayOptions {
  agents: Record<string, GatewayAgentConfig>;
  batching?: { firstWindowMs?: number; windowMs?: number };
  logger?: AdapterLogger;
}

export interface GatewayServer {
  /** Bind and resolve the actual port (pass 0 for ephemeral). */
  listen(port?: number): Promise<number>;
  port(): number | undefined;
  close(): Promise<void>;
}

interface SessionEntry {
  sessionId: string;
  agentId: string;
  policy: PermissionPolicy;
  session: AgentSession;
  subscribers: Set<(chunk: string) => void>;
  turn: Promise<unknown> | null;
  /** Monotonic seq for SSE frames + the in-memory log backing `?lastSeq=` replay. */
  nextSeq: number;
  log: { seq: number; frame: string }[];
}

type SseMessage =
  | { kind: 'hello'; sessionId: string }
  | { kind: 'events'; events: SessionEvent[] }
  | { kind: 'turn_completed'; stopReason: string }
  | { kind: 'closed' }
  | { kind: 'error'; message: string };

export function createGatewayServer(options: GatewayOptions): GatewayServer {
  const logger = options.logger ?? (() => {});
  const adapters = new Map<string, { adapter: AcpAgentAdapter; policy: PermissionPolicy }>();
  const sessions = new Map<string, SessionEntry>();
  let server: Server | undefined;
  let boundPort: number | undefined;
  let closing = false;

  function agentConfig(agentId: string): { adapter: AcpAgentAdapter; policy: PermissionPolicy } {
    const config = options.agents[agentId];
    if (!config) throw new HttpError(404, `Unknown agent: ${agentId}`);
    let entry = adapters.get(agentId);
    if (!entry) {
      entry = {
        adapter: new AcpAgentAdapter(agentId, config.launch, config.adapterOptions),
        policy: config.permissionPolicy ?? 'manual',
      };
      adapters.set(agentId, entry);
    }
    return entry;
  }

  function broadcast(entry: SessionEntry, message: SseMessage): void {
    // Every content frame gets a per-session monotonic seq and is appended to
    // the in-memory log before reaching subscribers. A reconnecting client
    // sends `?lastSeq=N` and receives exactly frames N+1..head, then live —
    // a single-writer catch-up that needs no version vectors.
    const seq = entry.nextSeq;
    entry.nextSeq += 1;
    const frame = `id: ${seq}\ndata: ${JSON.stringify({ ...message, seq })}\n\n`;
    entry.log.push({ seq, frame });
    for (const subscriber of entry.subscribers) subscriber(frame);
  }

  function pumpEvents(entry: SessionEntry): void {
    void (async () => {
      try {
        for await (const batch of batchEvents(entry.session.events, options.batching)) {
          for (const event of batch) {
            if (
              event.type === 'permission_request' &&
              entry.policy === 'allow-once'
            ) {
              const allow = event.options.find((option) => option.kind === 'allow_once');
              if (allow) {
                await entry.session.respondPermission(event.requestId, allow.optionId).catch(() => {});
              }
            }
          }
          broadcast(entry, { kind: 'events', events: batch });
        }
      } catch (error) {
        broadcast(entry, { kind: 'error', message: error instanceof Error ? error.message : String(error) });
      }
      if (sessions.get(entry.sessionId) === entry) sessions.delete(entry.sessionId);
      broadcast(entry, { kind: 'closed' });
    })();
  }

  async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > 1_000_000) throw new HttpError(413, 'Body too large');
      chunks.push(chunk as Buffer);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (raw.length === 0) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
      return parsed as Record<string, unknown>;
    } catch {
      throw new HttpError(400, 'Body must be a JSON object');
    }
  }

  function sendJson(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  }

  function sseSubscribe(response: ServerResponse, entry: SessionEntry, lastSeq: number | null): void {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const subscriber = (chunk: string): void => {
      response.write(chunk);
    };
    // Subscribe BEFORE replaying: the replay below is synchronous (no awaits),
    // so no broadcast can interleave — no gaps, no duplicates.
    entry.subscribers.add(subscriber);
    // hello is per-subscriber and intentionally unsequenced/unlogged.
    response.write(`data: ${JSON.stringify({ kind: 'hello', sessionId: entry.sessionId })}\n\n`);
    if (lastSeq !== null) {
      for (const logged of entry.log) {
        if (logged.seq > lastSeq) response.write(logged.frame);
      }
    }
    response.on('close', () => {
      entry.subscribers.delete(subscriber);
    });
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    const method = request.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/api/health') {
      sendJson(response, 200, { ok: true, agents: Object.keys(options.agents), sessions: sessions.size });
      return;
    }

    if (method === 'POST' && parts[0] === 'api' && parts[1] === 'agents' && parts[3] === 'sessions') {
      const agentId = parts[2];
      if (agentId === undefined) throw new HttpError(404, 'Missing agent id');
      const body = await readBody(request);
      const cwd = body.cwd;
      if (typeof cwd !== 'string') throw new HttpError(400, 'body.cwd is required');
      const { adapter, policy } = agentConfig(agentId);
      const session = await adapter.createSession({
        cwd,
        ...(typeof body.resumeSessionId === 'string' ? { resumeSessionId: body.resumeSessionId } : {}),
        ...(body.meta !== undefined ? { meta: body.meta as Record<string, unknown> } : {}),
      });
      const entry: SessionEntry = {
        sessionId: session.id,
        agentId,
        policy,
        session,
        subscribers: new Set(),
        turn: null,
        nextSeq: 1,
        log: [],
      };
      sessions.set(entry.sessionId, entry);
      pumpEvents(entry);
      logger('info', `[gateway] session ${entry.sessionId} opened on agent ${entry.agentId}`);
      sendJson(response, 200, { sessionId: entry.sessionId });
      return;
    }

    if (parts[0] === 'api' && parts[1] === 'sessions' && parts[2] !== undefined) {
      const entry = sessions.get(parts[2]);
      if (!entry) throw new HttpError(404, `Unknown session: ${parts[2]}`);
      const tail = parts[3];

      if (method === 'GET' && tail === undefined && url.pathname === `/api/sessions/${entry.sessionId}`) {
        sendJson(response, 200, { sessionId: entry.sessionId, agentId: entry.agentId, busy: entry.turn !== null });
        return;
      }
      if (method === 'GET' && tail === 'events') {
        // lastSeq contract: omit the param → live-only from head; lastSeq=0 →
        // replay the whole log then live; lastSeq=N → replay N+1..head then live.
        const lastSeqParam = url.searchParams.get('lastSeq');
        let lastSeq: number | null = null;
        if (lastSeqParam !== null) {
          const parsed = Number.parseInt(lastSeqParam, 10);
          if (!Number.isInteger(parsed) || parsed < 0) {
            throw new HttpError(400, `lastSeq must be a non-negative integer (got ${lastSeqParam})`);
          }
          if (parsed >= entry.nextSeq) {
            throw new HttpError(400, `lastSeq ${parsed} is ahead of the session log (head ${entry.nextSeq - 1})`);
          }
          lastSeq = parsed;
        }
        sseSubscribe(response, entry, lastSeq);
        return;
      }
      if (method === 'POST' && tail === 'prompt') {
        if (entry.turn) throw new HttpError(409, 'A turn is already in progress on this session');
        const body = await readBody(request);
        const text = body.text;
        if (typeof text !== 'string') throw new HttpError(400, 'body.text is required');
        const turn = entry.session
          .prompt(text)
          .then((result) => {
            broadcast(entry, { kind: 'turn_completed', stopReason: result.stopReason });
          })
          .catch((error: unknown) => {
            broadcast(entry, { kind: 'error', message: error instanceof Error ? error.message : String(error) });
          })
          .finally(() => {
            if (entry.turn === turn) entry.turn = null;
          });
        entry.turn = turn;
        sendJson(response, 202, { accepted: true });
        return;
      }
      if (method === 'POST' && tail === 'permission') {
        const body = await readBody(request);
        if (typeof body.requestId !== 'string' || typeof body.optionId !== 'string') {
          throw new HttpError(400, 'body.requestId and body.optionId are required');
        }
        await entry.session.respondPermission(body.requestId, body.optionId);
        sendJson(response, 200, { ok: true });
        return;
      }
      if (method === 'POST' && tail === 'interrupt') {
        await entry.session.interrupt();
        sendJson(response, 200, { ok: true });
        return;
      }
      if (method === 'DELETE' && tail === undefined) {
        await entry.session.dispose();
        sendJson(response, 200, { ok: true });
        return;
      }
    }

    throw new HttpError(404, `No route: ${method} ${url.pathname}`);
  }

  server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : String(error);
      if (status >= 500) logger('error', `[gateway] ${message}`);
      if (!response.headersSent) sendJson(response, status, { error: message });
      else response.end();
    });
  });

  return {
    async listen(port = 0): Promise<number> {
      await new Promise<void>((resolve, reject) => {
        server?.once('error', reject);
        server?.listen(port, '127.0.0.1', resolve);
      });
      const address = server?.address();
      boundPort = typeof address === 'object' && address !== null ? address.port : port;
      logger('info', `[gateway] listening on 127.0.0.1:${boundPort}`);
      return boundPort;
    },
    port(): number | undefined {
      return boundPort;
    },
    async close(): Promise<void> {
      if (closing) return;
      closing = true;
      for (const entry of [...sessions.values()]) {
        await entry.session.dispose().catch(() => {});
      }
      sessions.clear();
      for (const { adapter } of adapters.values()) {
        await adapter.dispose().catch(() => {});
      }
      adapters.clear();
      await new Promise<void>((resolve) => {
        if (!server || boundPort === undefined) return resolve();
        server.close(() => resolve());
      });
      boundPort = undefined;
    },
  };
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
