export type ErrorCode =
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'UNAUTHORIZED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'AMOUNT_EXCEEDS_MANDATE'
  | 'MANDATE_INACTIVE'
  | 'NOTICE_FAILED'
  | 'SPLIT_INVALID'
  | 'CONFLICT'
  | 'FORBIDDEN'
  | 'CHECK_IN_PROGRESS'
  | 'RECHECK_TOO_SOON'
  | 'COMPLAINT_NOT_ALLOWED'
  | 'COMPLAINT_FAILED'
  | 'ACCOUNT_LOCKED'
  | 'AFA_REQUIRED'
  | 'RATE_LIMITED'
  | 'NO_PSP_CONNECTED';

const STATUS: Record<ErrorCode, number> = {
  NOT_FOUND: 404,
  VALIDATION: 400,
  UNAUTHORIZED: 401,
  IDEMPOTENCY_CONFLICT: 409,
  AMOUNT_EXCEEDS_MANDATE: 422,
  MANDATE_INACTIVE: 422,
  NOTICE_FAILED: 502,
  SPLIT_INVALID: 422,
  CONFLICT: 409,
  FORBIDDEN: 403,
  CHECK_IN_PROGRESS: 409,
  RECHECK_TOO_SOON: 429,
  COMPLAINT_NOT_ALLOWED: 422,
  COMPLAINT_FAILED: 502,
  ACCOUNT_LOCKED: 429,
  AFA_REQUIRED: 422,
  RATE_LIMITED: 429,
  NO_PSP_CONNECTED: 422,
};

export class AppError extends Error {
  override name = 'AppError';
  readonly httpStatus: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.httpStatus = STATUS[code];
  }
}
