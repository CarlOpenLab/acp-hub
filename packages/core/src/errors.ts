/** Error codes thrown by adapters and the ACP harness. */
export type AdapterErrorCode =
  /** Agent binary/command could not be launched (ENOENT and friends). */
  | 'agent_not_found'
  | 'initialize_timeout'
  | 'initialize_failed'
  /** The agent subprocess died. */
  | 'connection_closed'
  | 'prompt_active'
  | 'prompt_failed'
  /** respondPermission/cancelPermission called with an unknown requestId. */
  | 'permission_unknown'
  | 'disposed'
  | 'unsupported'
  | 'unknown';

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  readonly detail?: unknown;

  constructor(
    code: AdapterErrorCode,
    message: string,
    options?: { cause?: unknown; detail?: unknown }
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AdapterError';
    this.code = code;
    this.detail = options?.detail;
  }
}

export function isAdapterError(value: unknown): value is AdapterError {
  return value instanceof AdapterError;
}
