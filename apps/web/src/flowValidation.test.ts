import { describe, expect, it } from "vitest";
import { flowIssue } from "./flowValidation.js";

describe("Unity canonical-v1 course flow", () => {
  const optional = ["opening", "learn-opening", "learn-word", "learn-text", "gaming"];
  it.each(Array.from({ length: 32 }, (_, mask) => ({
    mask, flow: ["landing", ...optional.filter((_, index) => mask & (1 << index)), "ending"],
  })))("allows ordered subset $mask", ({ flow }) => {
    expect(flowIssue(flow)).toBeNull();
  });

  it("allows returning to positioning between teaching stages", () => {
    expect(flowIssue(["landing", "opening", "landing", "learn-word", "landing", "gaming", "ending"])).toBeNull();
  });

  it("identifies the misplaced stage and where to move it", () => {
    expect(flowIssue(["landing", "learn-word", "gaming", "opening", "learn-opening", "ending"])).toEqual({
      index: 3, message: "第 4 個「課程開場」順序不正確，請移到「單字學習」之前。",
    });
  });

  it.each([
    { flow: [], message: "至少" },
    { flow: ["landing"], message: "至少" },
    { flow: ["opening", "ending"], message: "第一個" },
    { flow: ["landing", "opening"], message: "最後一個" },
    { flow: ["landing", "landing", "ending"], message: "相鄰" },
    { flow: ["landing", "gaming", "landing", "ending"], message: "遊戲練習」之後" },
    { flow: ["landing", "opening", "landing", "opening", "ending"], message: "只能出現一次" },
    { flow: ["landing", "unknown", "ending"], message: "無法使用" },
    { flow: ["landing", "learn-word", "learn-opening", "ending"], message: "單字學習」之前" },
  ])("rejects $flow with an actionable message", ({ flow, message }) => {
    expect(flowIssue(flow)?.message).toContain(message);
  });
});
