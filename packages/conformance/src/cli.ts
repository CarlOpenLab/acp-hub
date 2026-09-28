#!/usr/bin/env node
/**
 * Conformance CLI: run the scenario suite against any ACP-speaking agent.
 *
 *   @cc-heart/acp-hub-conformance --command npx --args "-y,@agentclientprotocol/codex-acp" --label codex
 *   @cc-heart/acp-hub-conformance --command node --args "/abs/path/fake-agent/agent.mjs" --set fake
 *
 * Exits non-zero when any scenario fails.
 */
import { createAcpAgentAdapter, type AgentLaunchSpec } from '@cc-heart/acp-hub-core';
import { runConformance, formatReport } from './runner.js';
import { BASELINE_SCENARIOS, FAKE_AGENT_SCENARIOS } from './scenarios.js';

interface CliArgs {
  command?: string;
  args?: string[];
  cwd?: string;
  label?: string;
  set: 'baseline' | 'fake';
}

function parseArgs(argv: string[]): CliArgs {
  const parsed: CliArgs = { set: 'baseline' };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    switch (key) {
      case '--command':
        parsed.command = value;
        index += 1;
        break;
      case '--args':
        parsed.args = (value ?? '').split(',').map((part) => part.trim()).filter(Boolean);
        index += 1;
        break;
      case '--cwd':
        parsed.cwd = value;
        index += 1;
        break;
      case '--label':
        parsed.label = value;
        index += 1;
        break;
      case '--set':
        if (value !== 'baseline' && value !== 'fake') {
          throw new Error(`--set must be 'baseline' or 'fake' (got ${value})`);
        }
        parsed.set = value;
        index += 1;
        break;
      default:
        throw new Error(`Unknown option: ${key} (supported: --command --args --cwd --label --set)`);
    }
  }
  return parsed;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args.command;
  if (!command) {
    console.error('Usage: @cc-heart/acp-hub-conformance --command <cmd> [--args a,b] [--cwd dir] [--label name] [--set baseline|fake]');
    process.exitCode = 2;
    return;
  }
  const launch: AgentLaunchSpec = {
    command,
    ...(args.args !== undefined ? { args: args.args } : {}),
  };
  const adapter = createAcpAgentAdapter(args.label ?? 'agent', launch);
  try {
    const report = await runConformance({
      label: args.label ?? command,
      adapter,
      scenarios: args.set === 'fake' ? FAKE_AGENT_SCENARIOS : BASELINE_SCENARIOS,
      ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
      logger: (line) => console.log(line),
    });
    console.log(formatReport(report));
    if (!report.allPassed) process.exitCode = 1;
  } finally {
    await adapter.dispose();
  }
}

await main();
