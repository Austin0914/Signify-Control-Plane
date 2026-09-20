import { createHash, randomBytes } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

let cachedPepper: string | undefined;

export async function tokenHash(token: string): Promise<string> {
  if (!cachedPepper) {
    const result = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: env("DEVICE_TOKEN_SECRET_ARN") }));
    cachedPepper = result.SecretString;
  }
  const pepper = cachedPepper;
  if (!pepper) throw new Error("Device token pepper secret is empty");
  return createHash("sha256").update(`${pepper}:${token}`, "utf8").digest("hex");
}

export function opaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function unixAfter(seconds: number): number {
  return Math.floor(Date.now() / 1000) + seconds;
}
