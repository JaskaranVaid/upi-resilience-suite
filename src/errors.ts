export type ErrorCode =
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'UNAUTHORIZED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'AMOUNT_EXCEEDS_MANDATE'
  | 'MANDATE_INACTIVE'
  | 'NOTICE_FAILED'
  | 'SPLIT_INVALID'
  | 'CONFLICT';

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
