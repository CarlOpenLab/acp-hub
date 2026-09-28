/**
 * Quickstart: the whole point of acp-hub in ~80 lines.
 *
 * Downstream code imports an adapter, calls the SAME interface for every
 * agent, and consumes a typed event stream. Swap `codex` for `claude` /
 * `pi` / `oh-my-pi` on the command line — nothing else changes.
 *
 *   pnpm codex   "帮我写一个 hello world"
 */
import {
  createClaudeAdapter,
  createCodexAdapter,
  createDeepSeekAdapter,
  createOhMyPiAdapter,
  createPiAdapter,
  type AgentAdapter,
} from './factory.js';

const agentId = process.argv[2] ?? 'codex';
const userPrompt = process.argv.slice(3).join(' ') || '用一句话介绍你自己';

function createAdapter(id: string): AgentAdapter {
  switch (id) {
    case 'claude':
      return createClaudeAdapter();
    case 'codex':
      return createCodexAdapter();
    case 'pi':
      return createPiAdapter();
    case 'oh-my-pi':
      return createOhMyPiAdapter();
    case 'deepseek':
      return createDeepSeekAdapter();
    default:
      throw new Error(`Unknown agent: ${id} (expected claude|codex|pi|oh-my-pi|deepseek)`);
  }
}

const adapter = createAdapter(agentId);

try {
  const capabilities = await adapter.connect();
  console.log(`[hub] ${agentId} connected. protocol=${capabilities.protocolVersion} load=${capabilities.supportsLoad}`);
  for (const method of capabilities.authMethods) console.log(`[hub] auth method: ${method.id}`);

  const session = await adapter.createSession({ cwd: process.cwd() });
  console.log(`[hub] session ${session.id}`);

  const turn = session.prompt(userPrompt).catch((error: unknown) => {
    console.error(`[hub] prompt failed:`, error);
    return { stopReason: 'end_turn' as const };
  });
  // When the turn ends, give trailing events a moment to flush, then close
  // the event stream so the for-await below can exit.
  turn.then(() => {
    setTimeout(() => void session.dispose(), 100);
  });

  for await (const event of session.events) {
    switch (event.type) {
      case 'message_delta':
        process.stdout.write(event.text);
        break;
      case 'thought_delta':
        process.stdout.write(`\x1b[2m${event.text}\x1b[0m`);
        break;
      case 'tool_call':
        console.log(`\n[tool] ${event.toolCall.status} ${event.toolCall.title ?? event.toolCall.toolCallId}`);
        break;
      case 'tool_call_update':
        console.log(`[tool] ${event.toolCall.toolCallId} -> ${event.toolCall.status}`);
        break;
      case 'plan':
        console.log(`\n[plan] ${event.entries.map((entry) => `${entry.status} ${entry.content}`).join(' | ')}`);
        break;
      case 'usage':
        console.log(`\n[usage]`, event.usage);
        break;
      case 'permission_request': {
        console.log(`\n[permission] ${event.toolCall?.title ?? 'unknown tool'}`);
        // Demo policy: auto-allow once. Real downstream decides via UI.
        const allow = event.options.find((option) => option.kind === 'allow_once') ?? event.options[0];
        if (allow) await session.respondPermission(event.requestId, allow.optionId);
        else await session.cancelPermission(event.requestId);
        break;
      }
      case 'agent_error':
        console.error(`[agent error] ${event.message}`);
        break;
      case 'session_info':
      case 'mode_update':
      case 'raw':
        break;
    }
  }

  const result = await turn;
  console.log(`\n[hub] turn finished: ${result.stopReason}`);
  await adapter.dispose();
} catch (error) {
  console.error('[hub] fatal:', error);
  await adapter.dispose();
  process.exitCode = 1;
}
