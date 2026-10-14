#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { ControlPlaneStack } from "../lib/control-plane-stack.js";

const app = new App();
const environmentName = String(app.node.tryGetContext("environment") ?? "dev");
if (!new Set(["dev", "demo"]).has(environmentName)) throw new Error("environment must be dev or demo");

// Explicit overrides take precedence over the saved environment allowlist.
// Keep the singular context supported for existing deployment commands.
const originsContext = app.node.tryGetContext("frontendOrigins")
  ?? app.node.tryGetContext("frontendOrigin")
  ?? app.node.tryGetContext(`frontendOrigins:${environmentName}`)
  ?? "http://localhost:5173";
const frontendOrigins = [...new Set((Array.isArray(originsContext)
  ? originsContext.map(String)
  : String(originsContext).split(",")).map((origin) => origin.trim()))];
for (const origin of frontendOrigins) {
  const url = new URL(origin);
  if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin) {
    throw new Error(`frontendOrigins must contain exact HTTP(S) origins without paths or trailing slashes: ${origin}`);
  }
}
if (!frontendOrigins.length) throw new Error("frontendOrigins must not be empty");

const account = process.env.CDK_DEFAULT_ACCOUNT;
new ControlPlaneStack(app, `SignifyControlPlane-${environmentName}`, {
  environmentName,
  frontendOrigins,
  env: { ...(account ? { account } : {}), region: String(app.node.tryGetContext("region") ?? "ap-northeast-3") },
});
