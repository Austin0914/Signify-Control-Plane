import { fetchAuthSession } from "aws-amplify/auth";

const baseUrl = import.meta.env.VITE_API_URL as string;

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, public readonly body: unknown) {
    super(`${status}: ${code}`);
    this.name = "ApiError";
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...init.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = typeof body === "object" && body && "code" in body ? String(body.code) : "request_failed";
    throw new ApiError(response.status, code, body);
  }
  return body as T;
}

export function idempotencyKey(): string {
  return crypto.randomUUID();
}
