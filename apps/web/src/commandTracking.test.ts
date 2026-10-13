import { describe, expect, it } from "vitest";
import { pendingCommandIds, updateJudgmentStatus } from "./commandTracking.js";

describe("pending judgment tracking", () => {
  it("keeps polling a judgment after a snapshot request replaces the recent command", () => {
    const judgments = { attempt: { commandId: "judge", status: "sent" } };
    const recent = { commandId: "snapshot", status: "accepted" };
    expect(pendingCommandIds(recent, judgments)).toEqual(["judge", "snapshot"]);
    expect(updateJudgmentStatus(judgments, "judge", "expired")).toEqual({});
    expect(recent.status).toBe("accepted");
  });

  it("retains the successful attempt lock when the device still reports that attempt", () => {
    const completed = updateJudgmentStatus({ attempt: { commandId: "judge", status: "sent" } }, "judge", "judged_correct");
    expect(completed.attempt?.status).toBe("judged_correct");
    expect(pendingCommandIds(completed.attempt!, completed)).toEqual([]);
  });

  it("does not unlock a newer retry when a late response belongs to its predecessor", () => {
    const judgments = { attempt: { commandId: "retry", status: "sent" } };
    expect(updateJudgmentStatus(judgments, "old", "rejected")).toBe(judgments);
    expect(pendingCommandIds(judgments.attempt!, judgments)).toEqual(["retry"]);
    expect(updateJudgmentStatus(judgments, "retry", "rejected")).toEqual({});
  });
});
