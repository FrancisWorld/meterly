export type ErrorCode =
  | "validation_error"
  | "unauthorized"
  | "not_found"
  | "conflict"
  | "invalid_signature"
  | "payload_too_large"
  | "internal_error";

const STATUS: Record<ErrorCode, number> = {
  validation_error: 400,
  unauthorized: 401,
  not_found: 404,
  conflict: 409,
  invalid_signature: 400,
  payload_too_large: 413,
  internal_error: 500,
};

/** Error with a stable machine-readable code that is safe to show to API clients. */
export class AppError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
    this.status = STATUS[code];
  }
}

export const notFound = (what: string): AppError => new AppError("not_found", `${what} not found`);
export const conflict = (message: string, details?: unknown): AppError => new AppError("conflict", message, details);
export const invalid = (message: string, details?: unknown): AppError =>
  new AppError("validation_error", message, details);
