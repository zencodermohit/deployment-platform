/**
 * The API's error vocabulary.
 *
 * One envelope for every failure, so clients never have to guess the shape:
 *
 *   { "error": { "code": "...", "message": "...", "requestId": "..." } }
 */

export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'QUOTA_EXCEEDED'
  | 'RATE_LIMITED'
  | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  NOT_FOUND: 404,
  CONFLICT: 409,
  QUOTA_EXCEEDED: 429,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = STATUS[code];
  }
}

export const badRequest = (message: string): ApiError => new ApiError('VALIDATION_FAILED', message);
export const unauthenticated = (message = 'authentication required'): ApiError =>
  new ApiError('UNAUTHENTICATED', message);
export const conflict = (message: string): ApiError => new ApiError('CONFLICT', message);
export const quotaExceeded = (message: string): ApiError => new ApiError('QUOTA_EXCEEDED', message);

/**
 * Always 404, never 403.
 *
 * Returning 403 for a resource that exists but belongs to someone else confirms
 * its existence, which is an enumeration oracle. From outside, "not yours" and
 * "not there" must be indistinguishable. Threat T11.
 */
export const notFound = (what = 'resource'): ApiError =>
  new ApiError('NOT_FOUND', `${what} not found`);
