/**
 * Error codes shared by every Ledgerline service.
 *
 * The code is the public contract: HTTP clients and the CLI branch on it.
 * The message is for humans and may change.
 */
export const ERROR_CODES = Object.freeze({
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
  ORDER_NOT_CAPTURABLE: 'ORDER_NOT_CAPTURABLE',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',
  ORDER_NOT_CAPTURED: 'ORDER_NOT_CAPTURED',
  REFUND_EXCEEDS_CAPTURED: 'REFUND_EXCEEDS_CAPTURED',
  INTERNAL: 'INTERNAL',
});

const HTTP_STATUS = Object.freeze({
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  ORDER_NOT_FOUND: 404,
  ORDER_NOT_CAPTURABLE: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  ORDER_NOT_CAPTURED: 409,
  REFUND_EXCEEDS_CAPTURED: 422,
  INTERNAL: 500,
});

export function httpStatusFor(code) {
  return HTTP_STATUS[code] ?? 500;
}

export class DomainError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }

  get status() {
    return httpStatusFor(this.code);
  }

  toJSON() {
    const body = { code: this.code, message: this.message };
    if (this.details !== undefined) body.details = this.details;
    return body;
  }
}

export function validationError(message, details) {
  return new DomainError(ERROR_CODES.VALIDATION_FAILED, message, details);
}
