import { randomUUID } from "node:crypto";
import { Amplify } from "aws-amplify";
import { fetchAuthSession, signIn, signOut } from "aws-amplify/auth";
import WebSocket from "ws";

// This is an opt-in live dev test: it creates config, device, command, audit and
// export records. The caller must provision a disposable Cognito user and clean
// all test records afterward; it is intentionally excluded from `npm test`.

const region = process.env.SIGNIFY_AWS_REGION ?? "ap-northeast-3";
const userPoolId = process.env.SIGNIFY_USER_POOL_ID ?? "ap-northeast-3_3cbodDNKb";
const userPoolClientId = process.env.SIGNIFY_USER_POOL_CLIENT_ID ?? "6eeg8nb6n74n1mmog60s43uj7h";
const apiUrl = process.env.SIGNIFY_API_URL ?? "https://15f5hxwl22.execute-api.ap-northeast-3.amazonaws.com";
const websocketUrl = process.env.SIGNIFY_WEBSOCKET_URL ?? "wss://ilzahq1m7a.execute-api.ap-northeast-3.amazonaws.com/dev";
const frontendOrigin = process.env.SIGNIFY_FRONTEND_ORIGIN ?? "https://main.d3xlnrkwumb75.amplifyapp.com";
const email = required("SIGNIFY_TEST_EMAIL");
const password = required("SIGNIFY_TEST_PASSWORD");

Amplify.configure({ Auth: { Cognito: { userPoolId, userPoolClientId, loginWith: { email: true } } } });

const checks = [];
let idToken;
let activeSocket;

try {
  const auth = await signIn({ username: email, password });
  assert(auth.isSignedIn, `unexpected auth step: ${auth.nextStep?.signInStep}`);
  idToken = (await fetchAuthSession()).tokens?.idToken?.toString();
  assert(idToken, "Cognito did not return an ID token");
  pass("Cognito SRP login");

  const me = await api("/api/v1/me", { expected: 200 });
  assert(me.role === "operator" && typeof me.subject === "string", "unexpected /me response");
  await api("/api/v1/projects/default", { expected: 200 });
  pass("JWT-protected operator API");

  const config = fixtureConfig();
  await api("/api/v1/projects/default/config/validate", {
    method: "POST", body: { ...config, sceneName: "ForbiddenScene" }, expected: 422,
  });
  await api("/api/v1/projects/default/config/validate", { method: "POST", body: config, expected: 200 });
  const draft = await api("/api/v1/projects/default/config/draft", {
    method: "PUT", body: config, headers: { "if-match": '"draft-0"' }, expected: 200,
  });
  assert(draft.draftVersion === 1, "first draft version must be 1");
  await api("/api/v1/projects/default/config/draft", {
    method: "PUT", body: config, headers: { "if-match": '"draft-0"' }, expected: 412,
  });
  const publishKey = randomUUID();
  const published = await api("/api/v1/projects/default/config/publish", {
    method: "POST", headers: { "idempotency-key": publishKey }, expected: 201,
  });
  assert(published.revision === 1 && published.replayed === false, "first publish response mismatch");
  const publishReplay = await api("/api/v1/projects/default/config/publish", {
    method: "POST", headers: { "idempotency-key": publishKey }, expected: 200,
  });
  assert(publishReplay.revision === 1 && publishReplay.replayed === true, "publish idempotency replay mismatch");
  const latest = await api("/api/v1/projects/default/config/latest", { expected: 200, includeResponse: true });
  assert(latest.body.configRevision === 1 && latest.response.headers.get("etag") === '"revision-1"', "latest revision/ETag mismatch");
  const revisions = await api("/api/v1/projects/default/config/revisions", { expected: 200 });
  assert(revisions.items.length === 1 && revisions.items[0].revision === 1, "revision history mismatch");
  const rollback = await api("/api/v1/projects/default/config/rollback", {
    method: "POST", body: { revision: 1, expectedDraftVersion: 1 }, expected: 200,
  });
  assert(rollback.draftVersion === 2 && rollback.rollbackSourceRevision === 1, "rollback draft mismatch");
  const latestAfterRollback = await api("/api/v1/projects/default/config/latest", { expected: 200 });
  assert(latestAfterRollback.configRevision === 1, "rollback must not rewrite published truth");
  pass("config validate/draft/conflict/publish/revision/rollback");

  const deviceId = `integration-${Date.now()}`;
  const pairing = await api("/api/v1/projects/default/pairing-codes", {
    method: "POST", body: { deviceId }, expected: 201,
  });
  const redeemed = await publicApi("/device/v1/pairing/redeem", {
    method: "POST", body: { pairingCode: pairing.pairingCode }, expected: 201,
  });
  assert(redeemed.deviceId === deviceId && typeof redeemed.credential === "string", "pairing redeem mismatch");
  await publicApi("/device/v1/pairing/redeem", {
    method: "POST", body: { pairingCode: pairing.pairingCode }, expected: 409,
  });
  const deviceConfig = await deviceApi("/device/v1/config/latest", redeemed.credential, { expected: 200 });
  assert(deviceConfig.configRevision === 1, "device latest config mismatch");
  pass("single-use pairing and device-authenticated config");

  const connection1 = `conn-${randomUUID()}`;
  activeSocket = await openDevice(redeemed.credential);
  send(activeSocket, clientHello(deviceId, connection1));
  const serverHello1 = await activeSocket.next((message) => message.messageType === "server_hello");
  assert(serverHello1.connectionId === connection1 && serverHello1.configRevision === 1, "server hello mismatch");
  send(activeSocket, snapshot(deviceId, connection1, 1, 1, 0));
  await waitUntil(async () => (await findDevice(deviceId))?.ready === true, "device did not become ready");

  send(activeSocket, heartbeat(deviceId, connection1, 1, 2));
  const heartbeatAck = await activeSocket.next((message) => message.messageType === "heartbeat_ack");
  assert(heartbeatAck.connectionId === connection1, "heartbeat ACK mismatch");
  pass("WebSocket authorize/hello/snapshot/heartbeat");

  const requestSnapshotKey = randomUUID();
  const queued = await createCommand(deviceId, "request_snapshot", {}, requestSnapshotKey, 1, 202);
  const delivered = await activeSocket.next((message) => message.messageType === "command" && message.commandId === queued.commandId);
  assert(delivered.serverSequence === queued.serverSequence && delivered.commandType === "request_snapshot", "delivered command mismatch");
  const replayed = await createCommand(deviceId, "request_snapshot", {}, requestSnapshotKey, 1, 202);
  assert(replayed.commandId === queued.commandId && replayed.replayed === true, "command idempotency replay mismatch");
  await createCommand(deviceId, "navigate_section", { sectionId: "gaming" }, requestSnapshotKey, 1, 409);
  send(activeSocket, commandAck(deviceId, connection1, delivered, 1));
  await waitUntil(async () => (await getCommand(queued.commandId)).status === "accepted", "ACK did not reach accepted");
  const accepted = await getCommand(queued.commandId);
  assert(!accepted.terminal, "Accepted must not be terminal");
  send(activeSocket, commandResult(deviceId, connection1, delivered, 2, 3));
  await waitUntil(async () => (await getCommand(queued.commandId)).status === "activated", "terminal result did not activate");
  const truthAfterTerminal = await findDevice(deviceId);
  assert(truthAfterTerminal.snapshot.currentSection.sectionId === "landing", "server intent overwrote device-reported truth");
  pass("command delivery/idempotency/ACK/terminal/truth separation");

  await createCommand(deviceId, "navigate_section", { sceneName: "ForbiddenScene" }, randomUUID(), 1, 422);
  await createCommand(deviceId, "force_judgment", { outcome: "correct" }, randomUUID(), 1, 409);
  await createCommand(deviceId, "advance_subsection", { expectedPhase: "celebration", expectedPhaseEpoch: 99 }, randomUUID(), 1, 409);
  pass("forbidden payload and authoritative-snapshot guards");

  const pending = await createCommand(deviceId, "navigate_section", { sectionId: "gaming" }, randomUUID(), 1, 202);
  const firstDelivery = await activeSocket.next((message) => message.messageType === "command" && message.commandId === pending.commandId);
  assert(firstDelivery.connectionId === connection1, "first delivery connection mismatch");
  await activeSocket.close();

  const connection2 = `conn-${randomUUID()}`;
  activeSocket = await openDevice(redeemed.credential);
  send(activeSocket, clientHello(deviceId, connection2));
  await activeSocket.next((message) => message.messageType === "server_hello" && message.connectionId === connection2);
  send(activeSocket, snapshot(deviceId, connection2, 2, 2, queued.serverSequence));
  const retransmitted = await activeSocket.next((message) => message.messageType === "command" && message.commandId === pending.commandId);
  assert(retransmitted.serverSequence === pending.serverSequence && retransmitted.connectionId === connection2, "retransmission/fencing mismatch");
  send(activeSocket, commandNack(deviceId, connection2, retransmitted, 2));
  await waitUntil(async () => (await getCommand(pending.commandId)).status === "rejected", "NACK did not reject command");
  pass("disconnect/reconnect/fenced connection/retransmission/NACK");

  const exported = await api("/api/v1/projects/default/research-exports", {
    method: "POST", body: { format: "json" }, expected: 201,
  });
  const exportResponse = await fetch(exported.downloadUrl);
  assert(exportResponse.ok, "signed research export download failed");
  const exportBody = await exportResponse.text();
  assert(exportBody.includes('"schemaVersion": 1') && !exportBody.includes(redeemed.credential) && !exportBody.includes(email), "research export redaction mismatch");
  pass("redacted research export and signed download");

  const revoked = await api(`/api/v1/projects/default/devices/${encodeURIComponent(deviceId)}/revoke`, {
    method: "POST", expected: 200,
  });
  assert(revoked.credentialCount === 1, "revocation count mismatch");
  await deviceApi("/device/v1/config/latest", redeemed.credential, { expected: [401, 403] });
  await activeSocket.close();
  activeSocket = undefined;
  await expectWebSocketRejected(redeemed.credential);
  const revokedDevice = await findDevice(deviceId);
  assert(revokedDevice.ready === false, "revoked device remained ready");
  pass("credential revocation and reconnect denial");

  console.log(`live_integration=passed checks=${checks.length}`);
} finally {
  if (activeSocket) await activeSocket.close().catch(() => undefined);
  await signOut().catch(() => undefined);
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function pass(name) {
  checks.push(name);
  console.log(`PASS ${name}`);
}

async function request(path, init, authorization) {
  const response = await fetch(`${apiUrl}${path}`, {
    method: init.method ?? "GET",
    headers: {
      "content-type": "application/json",
      origin: frontendOrigin,
      ...(authorization ? { authorization } : {}),
      ...init.headers,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const body = await response.json().catch(() => ({}));
  const expectedStatuses = Array.isArray(init.expected) ? init.expected : [init.expected];
  assert(expectedStatuses.includes(response.status), `${init.method ?? "GET"} ${path}: expected ${expectedStatuses.join("/")}, got ${response.status} ${JSON.stringify(body)}`);
  assert(response.headers.get("access-control-allow-origin") === frontendOrigin, `${path}: missing exact CORS origin`);
  return init.includeResponse ? { body, response } : body;
}

function api(path, init = {}) {
  return request(path, init, `Bearer ${idToken}`);
}

function publicApi(path, init = {}) {
  return request(path, init);
}

function deviceApi(path, credential, init = {}) {
  return request(path, init, `Bearer ${credential}`);
}

async function createCommand(deviceId, commandType, payload, idempotencyKey, expectedDeviceStateRevision, expected) {
  return api("/api/v1/projects/default/commands", {
    method: "POST", expected,
    headers: { "idempotency-key": idempotencyKey },
    body: { deviceId, sessionId: "integration-session", configRevision: 1, expectedDeviceStateRevision, commandType, payload },
  });
}

function getCommand(commandId) {
  return api(`/api/v1/projects/default/commands/${encodeURIComponent(commandId)}`, { expected: 200 });
}

async function findDevice(deviceId) {
  const result = await api("/api/v1/projects/default/devices", { expected: 200 });
  return result.items.find((item) => item.deviceId === deviceId);
}

async function waitUntil(fn, message, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(message);
}

async function openDevice(credential) {
  const ws = new WebSocket(websocketUrl, { headers: { authorization: `Bearer ${credential}` } });
  const queue = [];
  const waiters = [];
  ws.on("message", (data) => {
    const message = JSON.parse(data.toString());
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else queue.push(message);
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
    ws.once("unexpected-response", (_request, response) => reject(new Error(`WebSocket rejected: ${response.statusCode}`)));
  });
  return {
    raw: ws,
    next(predicate, timeoutMs = 12_000) {
      const index = queue.findIndex(predicate);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: undefined };
        waiter.timer = setTimeout(() => {
          const waiterIndex = waiters.indexOf(waiter);
          if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
          reject(new Error("WebSocket message timeout"));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    close() {
      if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
      return new Promise((resolve) => {
        ws.once("close", resolve);
        ws.close();
        setTimeout(() => { if (ws.readyState !== WebSocket.CLOSED) ws.terminate(); }, 2_000);
      });
    },
  };
}

function send(socket, message) {
  socket.raw.send(JSON.stringify(message));
}

async function expectWebSocketRejected(credential) {
  const ws = new WebSocket(websocketUrl, { headers: { authorization: `Bearer ${credential}` } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("revoked WebSocket was not rejected")), 8_000);
    ws.once("open", () => { clearTimeout(timer); ws.close(); reject(new Error("revoked WebSocket unexpectedly opened")); });
    ws.once("unexpected-response", (_request, response) => {
      clearTimeout(timer);
      assert(response.statusCode === 403, `expected WebSocket 403, got ${response.statusCode}`);
      resolve();
    });
    ws.once("error", () => {
      // `ws` may emit error after unexpected-response; the response handler is authoritative.
    });
  });
}

function baseDevice(deviceId, connectionId) {
  return { protocolVersion: 1, sessionId: "integration-session", deviceId, connectionId };
}

function clientHello(deviceId, connectionId) {
  return { ...baseDevice(deviceId, connectionId), messageType: "client_hello", configRevision: 1, deviceStateRevision: 1, capabilities: ["navigate_section", "advance_subsection", "force_judgment", "request_snapshot"] };
}

function snapshot(deviceId, connectionId, deviceStateRevision, deviceEventSequence, lastProcessedServerSequence) {
  return {
    ...baseDevice(deviceId, connectionId), messageType: "device_snapshot", configRevision: 1, configSource: "remote",
    deviceStateRevision, deviceEventSequence, connectionState: "connected", bootPlanState: "active", transition: null,
    currentSection: { sectionId: "landing", sectionInstanceId: "landing@g1", generation: 1, origin: "boot" },
    pendingLanding: null, learnWord: null, fatal: null, lastProcessedServerSequence,
    capabilities: ["navigate_section", "advance_subsection", "force_judgment", "request_snapshot"], activeJudgment: null,
  };
}

function heartbeat(deviceId, connectionId, deviceStateRevision, deviceEventSequence) {
  return {
    ...baseDevice(deviceId, connectionId), messageType: "heartbeat", deviceStateRevision, deviceEventSequence,
    inboxDepth: 0, inboxHighWater: 1, outboundDepth: 0, outboundHighWater: 1, ledgerSize: 0, sentAt: new Date().toISOString(),
  };
}

function commandAck(deviceId, connectionId, command, deviceStateRevision) {
  return {
    ...baseDevice(deviceId, connectionId), messageType: "command_ack", commandId: command.commandId,
    serverSequence: command.serverSequence, ingressDisposition: "accepted", authorityCode: "accepted_for_test",
    transitionId: null, targetSectionInstanceId: null, deviceStateRevision, replayed: false,
  };
}

function commandNack(deviceId, connectionId, command, deviceStateRevision) {
  return {
    ...baseDevice(deviceId, connectionId), messageType: "command_nack", commandId: command.commandId,
    serverSequence: command.serverSequence, ingressDisposition: "rejected", reasonCode: "test_rejection",
    detail: "integration test rejection", deviceStateRevision, replayed: true,
  };
}

function commandResult(deviceId, connectionId, command, deviceStateRevision, deviceEventSequence) {
  return {
    ...baseDevice(deviceId, connectionId), messageType: "command_result", commandId: command.commandId,
    result: "activated", transitionId: null, sectionId: "landing", sectionInstanceId: "landing@g1", generation: 1,
    failureCode: null, deviceStateRevision, deviceEventSequence,
  };
}

function fixtureConfig() {
  const words = ["good-morning", "i", "wake-up", "brush-teeth", "wash-face", "eat-breakfast", "study", "go", "happy"];
  return {
    schemaVersion: 1, sessionId: "integration-session", configRevision: 1, contentCatalogVersion: "signify-core-1",
    flow: ["landing", "opening", "learn-opening", "learn-word", "learn-text", "gaming", "ending"],
    content: {
      learnOpening: { wordId: "good-morning" },
      learnWord: { words: words.map((wordId, index) => ({ puzzleNumber: index + 1, wordId })) },
      learnText: { textIds: ["text-1", "text-2", "text-3", "text-4"] }, gaming: { wordIds: words },
    },
  };
}
