import 'server-only';

/** HTTP-aware errors thrown by route logic and mapped in http.ts. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string = 'ERROR',
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const notConfigured = (what: string) =>
  new HttpError(503, `${what} is not configured on this server. See docs/testnet-setup.md.`, 'NOT_CONFIGURED');
export const unauthorized = (message = 'Sign in with the treasury operator wallet.') => new HttpError(401, message, 'UNAUTHORIZED');
export const forbidden = (message = 'This wallet is not the treasury operator.') => new HttpError(403, message, 'FORBIDDEN');
export const notFound = (message = 'Not found.') => new HttpError(404, message, 'NOT_FOUND');
export const conflict = (message: string) => new HttpError(409, message, 'CONFLICT');
export const tooManyRequests = () => new HttpError(429, 'Too many requests. Slow down.', 'RATE_LIMITED');
