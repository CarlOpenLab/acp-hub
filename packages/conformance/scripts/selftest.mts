/**
 * Self-test: run the strict fake-agent scenario set against the bundled
 * fake ACP agent. Verifies the conformance runner AND the harness
 * translation layer without any real agent installed.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAcpAgentAdapter } from 'acp-hub-core';
import { runConformance, formatReport } from '../src/runner.js';
import { FAKE_AGENT_SCENARIOS } from '../src/scenarios.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeAgentPath = path.join(here, '..', '..', '..', 'examples', 'fake-agent', 'agent.mjs');

const adapter = createAcpAgentAdapter(
  'fake-agent',
  { command: process.execPath, args: [fakeAgentPath] },
  { initializeTimeoutMs: 15_000 }
);

try {
  const report = await runConformance({
    label: 'fake-agent (selftest)',
    adapter,
    scenarios: FAKE_AGENT_SCENARIOS,
    onPermissionRequest: (event) => {
      const allow = event.options.find((option) => option.kind === 'allow_once');
      return allow ? allow.optionId : null;
    },
    logger: (line) => console.log(line),
  });
  console.log(formatReport(report));
  if (!report.allPassed) process.exitCode = 1;
} finally {
  await adapter.dispose();
}
