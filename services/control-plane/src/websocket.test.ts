import { beforeEach, describe, expect, it, vi } from "vitest";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const mocks = vi.hoisted(() => ({ send: vi.fn(), owner: "test-device" }));
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

function deliver(body: typeof nack) {
  return message({ body: JSON.stringify(body), requestContext: { connectionId: "gateway-connection", domainName: "unit", stage: "test" } } as never, {} as never, () => {});
}

beforeEach(() => {
  mocks.send.mockReset(); mocks.owner = "test-device";
  mocks.send.mockImplementation(async (command: GetCommand | UpdateCommand) => {
    const key = command.input.Key?.sortKey;
    if (key === "DEVICE#test-device") return { Item: { gatewayConnectionId: "gateway-connection", protocolConnectionId: "protocol-connection", sessionId: "test-session" } };
    if (key === "COMMAND_ID#known-command") return { Item: { deviceId: mocks.owner, serverSequence: 42 } };
    return {};
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
});
