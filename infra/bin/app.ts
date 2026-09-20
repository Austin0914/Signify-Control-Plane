#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { ControlPlaneStack } from "../lib/control-plane-stack.js";

const app = new App();
const environmentName = String(app.node.tryGetContext("environment") ?? "dev");
if (!new Set(["dev", "demo"]).has(environmentName)) throw new Error("environment must be dev or demo");

const account = process.env.CDK_DEFAULT_ACCOUNT;
new ControlPlaneStack(app, `SignifyControlPlane-${environmentName}`, {
  environmentName,
  frontendOrigin: String(app.node.tryGetContext("frontendOrigin") ?? "http://localhost:5173"),
  env: { ...(account ? { account } : {}), region: String(app.node.tryGetContext("region") ?? "ap-northeast-3") },
});
