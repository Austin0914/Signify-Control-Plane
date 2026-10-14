import { beforeEach, describe, expect, it, vi } from "vitest";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("./aws.js", () => ({
  ddb: { send: mocks.send }, env: () => "unit-table", nowIso: () => new Date().toISOString(),
  unixAfter: () => 0, opaqueToken: () => "unit-token", tokenHash: async () => "unit-hash",
}));
import { handler } from "./operator-api.js";

function devicesRequest() {
  return handler({ rawPath: "/api/v1/projects/default/devices", headers: {}, requestContext: { http: { method: "GET" }, authorizer: { jwt: { claims: { sub: "unit-operator" } } } } } as never, {} as never, () => {});
}

beforeEach(() => mocks.send.mockReset());

describe("operator device listing", () => {
  it("queries only project device keys rather than scanning the first 100 mixed records", async () => {
    mocks.send.mockResolvedValue({ Items: [{ entityType: "device", deviceId: "test-device", ready: true, lastSeenAt: new Date().toISOString(), credentialHash: "private-hash" }] });
    const response = await devicesRequest() as { statusCode: number; body: string };
    const command = mocks.send.mock.calls[0]![0] as QueryCommand;
    expect(command).toBeInstanceOf(QueryCommand);
    expect(command.input.ExpressionAttributeValues).toMatchObject({ ":project": "default", ":prefix": "DEVICE#" });
    const body = JSON.parse(response.body);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].ready).toBe(true);
    expect(body.items[0]).not.toHaveProperty("credentialHash");
  });

  it("continues after a filtered empty page and includes devices from the next page", async () => {
    const cursor = { projectId: "default", sortKey: "DEVICE#first" };
    mocks.send.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: cursor }).mockResolvedValueOnce({ Items: [{ entityType: "device", deviceId: "next-device", ready: false }] });
    const response = await devicesRequest() as { statusCode: number; body: string };
    expect(JSON.parse(response.body).items.map((item: { deviceId: string }) => item.deviceId)).toEqual(["next-device"]);
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect((mocks.send.mock.calls[1]![0] as QueryCommand).input.ExclusiveStartKey).toEqual(cursor);
  });
});

describe("remote gaming start", () => {
  function liveDevice() {
    return { ready: true, lastSeenAt: new Date().toISOString(), gatewayConnectionId: "gateway", protocolConnectionId: "connection", snapshot: {
      sessionId: "demo", configRevision: 8, deviceStateRevision: 12,
      currentSection: { sectionId: "gaming", sectionInstanceId: "gaming@g3" }, transition: { state: "active" },
      gaming: { phase: "rules_gate", canStart: true }, capabilities: ["start_gaming"],
    } };
  }
  async function start(live: ReturnType<typeof liveDevice>, payload = { sectionInstanceId: "gaming@g3" }) {
    mocks.send.mockImplementation(async (command) => command instanceof GetCommand
      ? command.input.Key?.sortKey?.startsWith("DEVICE#") ? { Item: live } : {} : {});
    return await handler({ rawPath: "/api/v1/projects/default/commands", headers: { "idempotency-key": "start-one" },
      body: JSON.stringify({ deviceId: "demo-device", expectedDeviceStateRevision: 12, commandType: "start_gaming", payload }),
      requestContext: { http: { method: "POST" }, authorizer: { jwt: { claims: { sub: "unit-operator" } } } },
    } as never, {} as never, () => {}) as { statusCode: number; body: string };
  }

  it("queues an execution-scoped start only for a supported waiting game", async () => {
    expect((await start(liveDevice())).statusCode).toBe(202);
    const transaction = mocks.send.mock.calls.map(([command]) => command).find((command) => command instanceof TransactWriteCommand);
    const item = transaction?.input.TransactItems?.find((entry) => entry.Put?.Item?.entityType === "command")?.Put?.Item;
    expect(item?.command).toMatchObject({ commandType: "start_gaming", sessionId: "demo", configRevision: 8, payload: { sectionInstanceId: "gaming@g3" } });
  });

  it.each([
    { label: "legacy device", mutate: (live: ReturnType<typeof liveDevice>) => { live.snapshot.capabilities = []; }, code: "device_update_required" },
    { label: "another section", mutate: (live: ReturnType<typeof liveDevice>) => { live.snapshot.currentSection.sectionId = "learn-word"; }, code: "gaming_not_waiting" },
    { label: "section transition", mutate: (live: ReturnType<typeof liveDevice>) => { live.snapshot.transition.state = "quiescing"; }, code: "gaming_not_waiting" },
    { label: "start already requested", mutate: (live: ReturnType<typeof liveDevice>) => { live.snapshot.gaming.canStart = false; }, code: "gaming_not_waiting" },
    { label: "gameplay already running", mutate: (live: ReturnType<typeof liveDevice>) => { live.snapshot.gaming.phase = "gameplay"; }, code: "gaming_not_waiting" },
  ])("rejects $label before queuing", async ({ mutate, code }) => {
    const live = liveDevice(); mutate(live);
    const response = await start(live);
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).code).toBe(code);
    expect(mocks.send.mock.calls.some(([command]) => command instanceof TransactWriteCommand)).toBe(false);
  });

  it("rejects a start captured before leaving and returning to Gaming", async () => {
    const response = await start(liveDevice(), { sectionInstanceId: "gaming@g1" });
    expect(JSON.parse(response.body).code).toBe("stale_gaming_section");
  });
});
