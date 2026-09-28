/**
 * A minimal fake ACP agent used to exercise the acp-hub harness end to end
 * without any real agent installed. Speaks ACP over stdio:
 * initialize → newSession/loadSession → prompt(streams text chunks, a
 * commands update, a tool call, one permission round-trip, a plan) → end_turn.
 */
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';

class FakeAgent {
  #connection;
  #loadCounts = new Map();

  constructor(connection) {
    this.#connection = connection;
  }

  async initialize() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        _meta: { 'fake-agent': { version: 1 } },
      },
      authMethods: [{ id: 'fake-key', name: 'Fake Key', description: 'test-only auth method' }],
    };
  }

  async authenticate() {
    return {};
  }

  async newSession() {
    return { sessionId: `fake-${Math.random().toString(36).slice(2, 8)}` };
  }

  async loadSession(params) {
    const count = (this.#loadCounts.get(params.sessionId) ?? 0) + 1;
    this.#loadCounts.set(params.sessionId, count);
    return {};
  }

  async prompt(params) {
    const { sessionId } = params;
    await this.#connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hello ' },
      },
    });
    await this.#connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'from fake agent' },
      },
    });
    await this.#connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: '/fake-help', description: 'Show fake help' }],
      },
    });
    await this.#connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        kind: 'execute',
        title: 'echo hi',
        rawInput: { command: 'echo hi' },
      },
    });
    const permission = await this.#connection.requestPermission({
      sessionId,
      toolCall: { toolCallId: 't1', title: 'echo hi' },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    });
    if (permission.outcome.outcome !== 'selected' || permission.outcome.optionId !== 'allow') {
      await this.#connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 't1',
          status: 'failed',
        },
      });
      return { stopReason: 'refusal' };
    }
    await this.#connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'completed',
        rawOutput: { output: 'hi' },
      },
    });
    await this.#connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'plan',
        entries: [{ content: 'say hi', priority: 'medium', status: 'completed' }],
      },
    });
    return { stopReason: 'end_turn' };
  }

  async cancel() {
    return {};
  }
}

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
new AgentSideConnection((connection) => new FakeAgent(connection), stream);
