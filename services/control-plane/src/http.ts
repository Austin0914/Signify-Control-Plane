import type { APIGatewayProxyResultV2 } from "aws-lambda";

export function json(statusCode: number, body: unknown, headers: Record<string, string> = {}): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
    body: JSON.stringify(body),
  };
}

export function parseJson(body: string | undefined): unknown {
  if (!body) return {};
  return JSON.parse(body);
}

export function actorFromClaims(claims: Record<string, string | undefined> | undefined): string {
  return claims?.sub ?? "unknown";
}
