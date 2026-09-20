import { fetchAuthSession } from "aws-amplify/auth";

const baseUrl = import.meta.env.VITE_API_URL as string;

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...init.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status}: ${body.code ?? "request_failed"}`);
  return body as T;
}

export function idempotencyKey(): string {
  return crypto.randomUUID();
}
