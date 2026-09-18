import type { AgentCapabilities } from '../capabilities.js';
import { readExtensionCapability } from '../capabilities.js';

/**
 * Steering (mid-turn interjection) capability contract, mirroring Lody's
 * `steering` extension so Lody-compatible adapters work unmodified.
 */
export interface SteeringCapability {
  version: number;
  transport: 'request' | 'prompt';
  /** 'same' = injected into the live turn; 'handoff' = becomes the next turn. */
  upstreamTurn?: 'same' | 'handoff';
  configPolicy?: 'active' | 'apply';
  /** Custom wire method for hub-namespace adapters. Defaults to `_hub/session/steer`. */
  requestMethod?: string;
}

export interface ResolvedRequestSteering {
  method: string;
  source: 'lody' | 'hub';
  upstreamTurn: 'same' | 'handoff';
}

export function readSteeringCapability(
  capabilities: AgentCapabilities,
  namespace: 'lody' | 'hub'
): SteeringCapability | null {
  const meta = readExtensionCapability<Record<string, unknown>>(capabilities, namespace);
  const steering = meta?.['steering'] as SteeringCapability | undefined;
  return steering ?? null;
}

/**
 * Resolve how (and whether) mid-turn steering can be delivered.
 *
 * - `_meta.lody.steering` with transport 'request' → `_lody/session/steer`
 *   (Lody-compatible adapters such as acp-extension-codex).
 * - `_meta.hub.steering` with transport 'request' → the adapter's declared
 *   `requestMethod`, defaulting to `_hub/session/steer`.
 *
 * Prompt-transport steering is not automated in 0.1: consumers can send a
 * follow-up prompt themselves; Lody models that as a handoff turn.
 */
export function resolveRequestSteering(capabilities: AgentCapabilities): ResolvedRequestSteering | null {
  const lody = readSteeringCapability(capabilities, 'lody');
  if (lody && lody.transport === 'request') {
    return { method: '_lody/session/steer', source: 'lody', upstreamTurn: lody.upstreamTurn ?? 'same' };
  }
  const hub = readSteeringCapability(capabilities, 'hub');
  if (hub && hub.transport === 'request') {
    return {
      method: hub.requestMethod ?? '_hub/session/steer',
      source: 'hub',
      upstreamTurn: hub.upstreamTurn ?? 'same',
    };
  }
  return null;
}
