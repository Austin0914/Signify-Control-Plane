import { beforeEach, describe, expect, it, vi } from "vitest";
import { GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";

const mocks = vi.hoisted(() => ({ send: vi.fn(), post: vi.fn(), owner: "test-device", pages: [] as Array<Record<string, unknown>> }));
vi.mock("@aws-sdk/client-apigatewaymanagementapi", async (original) => ({
  ...await original<typeof import("@aws-sdk/client-apigatewaymanagementapi")>(),
  ApiGatewayManagementApiClient: class { send = mocks.post; },
}));
vi.mock("./aws.js", () => ({
  ddb: { send: mocks.send }, env: () => "unit-live", nowIso: () => "2026-10-13T00:00:00.000Z", unixAfter: () => 0,
}));
import { message } from "./websocket.js";

const nack = {
  protocolVersion: 1, messageType: "command_nack", sessionId: "test-session", deviceId: "test-device",
  connectionId: "protocol-connection", commandId: "known-command", serverSequence: 0,
  ingressDisposition: "rejected", reasonCode: "invalid_payload", detail: "Invalid TTL",
  deviceStateRevision: 2, replayed: false,
};

function deliver(body: unknown) {
  return message({ body: JSON.stringify(body), requestContext: { connectionId: "gateway-connection", domainName: "unit", stage: "test" } } as never, {} as never, () => {});
}

beforeEach(() => {
  mocks.send.mockReset(); mocks.post.mockReset(); mocks.post.mockResolvedValue({}); mocks.pages = []; mocks.owner = "test-device";
  mocks.send.mockImplementation(async (command: GetCommand | UpdateCommand) => {
    if (command instanceof QueryCommand) return mocks.pages.shift() ?? {};
    const key = command.input.Key?.sortKey;
    if (key === "DEVICE#test-device") return { Item: { gatewayConnectionId: "gateway-connection", protocolConnectionId: "protocol-connection", sessionId: "test-session" } };
    if (key === "COMMAND_ID#known-command") return { Item: { deviceId: mocks.owner, serverSequence: 42 } };
    return {};
  });
});

const snapshot = {
  protocolVersion: 1, messageType: "device_snapshot", sessionId: "test-session", configRevision: 4,
  configSource: "remote", deviceId: "test-device", connectionId: "protocol-connection",
  deviceStateRevision: 10, deviceEventSequence: 4, connectionState: "connected", bootPlanState: "active",
  transition: null, currentSection: null, pendingLanding: null, learnWord: null, fatal: null,
  lastProcessedServerSequence: 42, capabilities: [], activeJudgment: null,
};
const oldCommand = { commandId: "pending-command", serverSequence: 42, connectionId: "old-connection", expiresAt: "2020-01-01T00:00:00.000Z" };

describe("pending command reconciliation after reconnect", () => {
  it.each(["accepted", "deferred"])("replays %s commands after the admission deadline without extending it", async (status) => {
    mocks.pages = [{ Items: [{ status, command: oldCommand }] }];
    await deliver(snapshot);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    const posted = mocks.post.mock.calls[0]![0] as PostToConnectionCommand;
    expect(posted.input.Data).toBeInstanceOf(Buffer);
    expect(JSON.parse(Buffer.from(posted.input.Data as Uint8Array).toString())).toEqual({ ...oldCommand, connectionId: "protocol-connection" });
  });

  it("expires commands without an ingress ACK and never replays completed commands", async () => {
    mocks.pages = [{ Items: ["queued", "sent", "judged_correct", "rejected"].map((status) => ({ status, command: oldCommand })) }];
    await deliver(snapshot);
    expect(mocks.post).not.toHaveBeenCalled();
    const expired = mocks.send.mock.calls.map(([command]) => command).filter((command) => command instanceof UpdateCommand && command.input.ExpressionAttributeValues?.[":status"] === "expired");
    expect(expired).toHaveLength(2);
  });

  it("treats an accepted snapshot request as complete without a terminal result", async () => {
    mocks.pages = [{ Items: [{ status: "accepted", command: { ...oldCommand, commandType: "request_snapshot" } }] }];
    await deliver(snapshot);
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.send.mock.calls.some(([command]) => command instanceof UpdateCommand && command.input.ExpressionAttributeValues?.[":status"] === "expired")).toBe(false);
  });

  it("finds unresolved commands after a page containing only completed commands", async () => {
    mocks.pages = [
      { Items: [{ status: "judged_correct", command: oldCommand }], LastEvaluatedKey: { projectId: "default", sortKey: "COMMAND#test-device#100" } },
      { Items: [{ status: "accepted", command: oldCommand }] },
    ];
    await deliver(snapshot);
    const queries = mocks.send.mock.calls.map(([command]) => command).filter((command) => command instanceof QueryCommand);
    expect(queries).toHaveLength(2);
    expect(queries[1]!.input.ExclusiveStartKey).toEqual({ projectId: "default", sortKey: "COMMAND#test-device#100" });
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });
});

describe("parse-failure NACK reconciliation", () => {
  it("resolves a zero-sequence NACK by command ID instead of addressing sequence zero", async () => {
    await deliver(nack);
    const update = mocks.send.mock.calls.map(([command]) => command).find((command) => command instanceof UpdateCommand) as UpdateCommand;
    expect(update.input.Key?.sortKey).toBe("COMMAND#test-device#000000000042");
    expect(update.input.ExpressionAttributeValues?.[":status"]).toBe("rejected");
    expect(update.input.ExpressionAttributeValues?.[":allowedCurrent"]).not.toContain("activated");
  });

  it("does not modify a command belonging to another device", async () => {
    mocks.owner = "other-device";
    await deliver(nack);
    expect(mocks.send.mock.calls.some(([command]) => command instanceof UpdateCommand)).toBe(false);
  });

  it("ignores unidentifiable malformed traffic without creating a command row", async () => {
    await deliver({ ...nack, commandId: "" });
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("keeps the known nonzero sequence path for normal authority rejection", async () => {
    await deliver({ ...nack, serverSequence: 9 });
    const update = mocks.send.mock.calls.map(([command]) => command).find((command) => command instanceof UpdateCommand) as UpdateCommand;
    expect(update.input.Key?.sortKey).toBe("COMMAND#test-device#000000000009");
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });

  it("allows a new runtime to reject an accepted or deferred command while protecting completed results", async () => {
    await deliver({ ...nack, serverSequence: 9, reasonCode: "no_active_judgment", detail: "Attempt no longer exists after restart" });
    const update = mocks.send.mock.calls.map(([command]) => command).find((command) => command instanceof UpdateCommand) as UpdateCommand;
    const allowed = update.input.ExpressionAttributeValues?.[":allowedCurrent"];
    expect(allowed).toEqual(expect.arrayContaining(["queued", "sent", "accepted", "deferred", "rejected"]));
    for (const completed of ["activated", "judged_correct", "judged_wrong", "superseded", "failed", "expired"])
      expect(allowed).not.toContain(completed);
  });
});
