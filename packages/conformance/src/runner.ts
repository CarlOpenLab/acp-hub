import type { AgentAdapter, AgentSession, SessionEvent } from '@cc-heart/acp-hub-core';
import type { Scenario } from './scenarios.js';

export interface ScenarioResult {
  scenarioId: string;
  ok: boolean;
  skipped: boolean;
  error?: string;
}

export interface ConformanceReport {
  label: string;
  results: ScenarioResult[];
  passed: number;
  failed: number;
  skipped: number;
  allPassed: boolean;
}

export interface RunConformanceOptions {
  label: string;
  adapter: AgentAdapter;
  scenarios: Scenario[];
  cwd?: string;
  /** ms to let trailing events drain after each scenario. Default 150. */
  drainGraceMs?: number;
  logger?: (line: string) => void;
  /**
   * Auto-answer surfaced permission requests: return the optionId to select
   * (or null to leave the request open). Required for scenarios that must
   * complete a turn through a permission gate; omit for manual agents.
   */
  onPermissionRequest?: (
    event: Extract<SessionEvent, { type: 'permission_request' }>,
    session: AgentSession
  ) => string | null | Promise<string | null>;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Run scenarios against one adapter. Each scenario gets a fresh session;
 * events are collected concurrently so scenarios can prompt and assert on
 * the full event stream afterwards.
 */
export async function runConformance(options: RunConformanceOptions): Promise<ConformanceReport> {
  const { label, adapter, scenarios, logger = () => {} } = options;
  const drainGraceMs = options.drainGraceMs ?? 150;
  const capabilities = await adapter.connect();
  const results: ScenarioResult[] = [];

  for (const scenario of scenarios) {
    if (scenario.applies && !scenario.applies(capabilities)) {
      results.push({ scenarioId: scenario.id, ok: true, skipped: true });
      logger(`SKIP ${scenario.id} — not applicable`);
      continue;
    }
    let result: ScenarioResult;
    const session = await adapter.createSession({ cwd: options.cwd ?? process.cwd() });
    const events: SessionEvent[] = [];
    const collector = (async () => {
      try {
        for await (const event of session.events) {
          events.push(event);
        }
      } catch {
        /* queue failed after a dead process — collection simply ends */
      }
    })();

    // Auto-answer surfaced permission requests while the scenario runs.
    const answered = new Set<string>();
    let scenarioFinished = false;
    const responder = options.onPermissionRequest
      ? (async () => {
          while (!scenarioFinished) {
            for (const event of events) {
              if (event.type !== 'permission_request' || answered.has(event.requestId)) continue;
              answered.add(event.requestId);
              const decision = await options.onPermissionRequest?.(event, session);
              if (decision !== null && decision !== undefined) {
                await session.respondPermission(event.requestId, decision).catch(() => {});
              }
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        })()
      : undefined;

    try {
      await scenario.run({
        adapter,
        capabilities,
        session,
        events,
        assert(condition, message) {
          if (!condition) throw new Error(message);
        },
      });
      result = { scenarioId: scenario.id, ok: true, skipped: false };
      logger(`PASS ${scenario.id}`);
    } catch (error) {
      result = { scenarioId: scenario.id, ok: false, skipped: false, error: messageOf(error) };
      logger(`FAIL ${scenario.id} — ${messageOf(error)}`);
    }
    results.push(result);
    scenarioFinished = true;
    await responder;
    // Let trailing events drain, then close the session and wait for the collector.
    await new Promise((resolve) => setTimeout(resolve, drainGraceMs));
    await session.dispose().catch(() => {});
    await collector;
  }

  const passed = results.filter((result) => result.ok && !result.skipped).length;
  const failed = results.filter((result) => !result.ok).length;
  const skipped = results.filter((result) => result.skipped).length;
  return { label, results, passed, failed, skipped, allPassed: failed === 0 };
}

export function formatReport(report: ConformanceReport): string {
  const lines = [
    `Conformance: ${report.label} — ${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped`,
  ];
  for (const result of report.results) {
    lines.push(
      `  ${result.skipped ? 'SKIP' : result.ok ? 'PASS' : 'FAIL'} ${result.scenarioId}${result.error ? ` — ${result.error}` : ''}`
    );
  }
  return lines.join('\n');
}
