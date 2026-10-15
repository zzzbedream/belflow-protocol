// Typed client for the BelFlow API envelope ({ success, data, error }).

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface Envelope<T> {
  success: boolean;
  data: T | null;
  error: { message: string; code: string } | null;
}

async function unwrap<T>(response: Response): Promise<T> {
  let body: Envelope<T>;
  try {
    body = (await response.json()) as Envelope<T>;
  } catch {
    throw new ApiError(`Server returned HTTP ${response.status}.`, response.status, 'BAD_RESPONSE');
  }
  if (!response.ok || !body.success) {
    throw new ApiError(body.error?.message ?? `Request failed (${response.status}).`, response.status, body.error?.code ?? 'ERROR');
  }
  return body.data as T;
}

export async function apiGet<T>(path: string): Promise<T> {
  return unwrap<T>(await fetch(path, { cache: 'no-store' }));
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  return unwrap<T>(
    await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}
