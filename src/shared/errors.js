export class ExternalServiceError extends Error {
  constructor(message, { service, status, retryable, ambiguous = false, cause } = {}) {
    super(message, { cause });
    this.name = 'ExternalServiceError';
    this.service = service;
    this.status = status;
    this.retryable = Boolean(retryable);
    this.ambiguous = Boolean(ambiguous);
  }
}

export const isRetryableStatus = (status) =>
  status === 408 || status === 425 || status === 429 || Number(status) >= 500;

export function timeoutSignal(timeoutMs) {
  return AbortSignal.timeout(Number(timeoutMs));
}

export function serializeError(error) {
  return {
    name: error?.name ?? 'Error',
    message: error?.message ?? String(error),
    service: error?.service ?? null,
    status: error?.status ?? null,
    retryable: error?.retryable !== false,
    ambiguous: Boolean(error?.ambiguous)
  };
}
