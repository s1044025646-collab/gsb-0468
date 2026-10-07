export type ErrorCode =
  | 'INVALID_PARAMS'
  | 'SATELLITE_LIMIT'
  | 'DUPLICATE_ID'
  | 'INVALID_ANGLE'
  | 'EMPTY_CONSTELLATION'
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'BATCH_LIMIT'
  | 'NUMERIC_FAILURE'
  | 'INTERNAL';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}
