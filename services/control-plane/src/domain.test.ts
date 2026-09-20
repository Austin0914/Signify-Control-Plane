import { describe, expect, it } from "vitest";
import { advanceCommand, classifySnapshotConflict, isTerminal } from "./domain.js";

describe("command lifecycle", () => {
  it("does not mistake ingress acceptance for activation", () => {
    expect(advanceCommand("sent", "accepted")).toBe("accepted");
    expect(isTerminal("accepted")).toBe(false);
    expect(advanceCommand("accepted", "activated")).toBe("activated");
  });

  it("rejects a terminal rewrite", () => {
    expect(() => advanceCommand("activated", "failed")).toThrow(/Invalid command transition/);
  });

  it("keeps device truth separate from desired intent", () => {
    expect(classifySnapshotConflict("gaming", "opening")).toEqual({
      conflict: true,
      displayedRuntimeSection: "opening",
      pendingDesiredSection: "gaming",
    });
  });
});
