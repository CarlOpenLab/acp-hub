import type { AuthMethod, InitializeResponse } from '@agentclientprotocol/sdk';

/** Result of the ACP `initialize` handshake, plus convenience getters. */
export interface AgentCapabilities {
  /**
   * Raw initialize response — full fidelity, including `_meta` extension
   * capabilities advertised by the agent.
   */
  raw: InitializeResponse;
  protocolVersion: number;
  authMethods: AuthMethod[];
  /** Agent accepts `session/load` (resume). */
  supportsLoad: boolean;
}

/** Read an extension capability advertised under `agentCapabilities._meta.<key>`. */
export function readExtensionCapability<T = unknown>(
  capabilities: AgentCapabilities,
  key: string
): T | undefined {
  const agentCaps = capabilities.raw.agentCapabilities as
    | (Record<string, unknown> & { _meta?: Record<string, unknown> })
    | undefined
    | null;
  return agentCaps?._meta?.[key] as T | undefined;
}
