import type {
  AdapterOptions,
  AgentAdapter,
  AgentLaunchSpec,
  AgentSessionSummary,
  CreateSessionOptions,
  AgentSession,
} from '../adapter.js';
import type {
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
} from '@agentclientprotocol/sdk';
import type { AgentCapabilities } from '../capabilities.js';
import { AcpAgentConnection } from './connection.js';

/**
 * Ready-made AgentAdapter backed by an ACP-speaking subprocess. Per-agent
 * packages are thin: they pick a launch spec and hand back one of these.
 */
export class AcpAgentAdapter implements AgentAdapter {
  #connection?: AcpAgentConnection;

  constructor(
    readonly agentId: string,
    private readonly launch: AgentLaunchSpec,
    private readonly options: AdapterOptions = {}
  ) {}

  /** Raw connection — escape hatch for brand extension methods. */
  get rawConnection(): AcpAgentConnection | undefined {
    return this.#connection;
  }

  async connect(): Promise<AgentCapabilities> {
    this.#connection ??= new AcpAgentConnection(this.launch, this.options);
    return this.#connection.connect();
  }

  async createSession(options: CreateSessionOptions): Promise<AgentSession> {
    this.#connection ??= new AcpAgentConnection(this.launch, this.options);
    const connection = this.#connection;
    if (!connection.isConnected) await connection.connect();
    return connection.createSession(options);
  }

  async authenticate(methodId: string): Promise<void> {
    this.#connection ??= new AcpAgentConnection(this.launch, this.options);
    await this.#connection.authenticate(methodId);
  }

  /** ACP `session/set_config_option` through the live connection. */
  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest
  ): Promise<SetSessionConfigOptionResponse> {
    const connection = this.#connection;
    if (!connection) throw new Error('Adapter is not connected');
    return connection.setSessionConfigOption(params);
  }

  async listSessions(options?: { cwd?: string }): Promise<AgentSessionSummary[]> {
    this.#connection ??= new AcpAgentConnection(this.launch, this.options);
    const connection = this.#connection;
    if (!connection.isConnected) await connection.connect();
    return connection.listSessions(options);
  }

  /** Generic extension request (`_brand/...` JSON-RPC) through the live connection. */
  requestExtension<Response = unknown, Params = unknown>(
    method: string,
    params?: Params
  ): Promise<Response> {
    const connection = this.#connection;
    if (!connection) return Promise.reject(new Error('Adapter is not connected'));
    return connection.requestExtension<Response, Params>(method, params);
  }

  async dispose(): Promise<void> {
    await this.#connection?.dispose();
    this.#connection = undefined;
  }
}

export function createAcpAgentAdapter(
  agentId: string,
  launch: AgentLaunchSpec,
  options?: AdapterOptions
): AcpAgentAdapter {
  return new AcpAgentAdapter(agentId, launch, options);
}
