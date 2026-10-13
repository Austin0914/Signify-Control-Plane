import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";

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
