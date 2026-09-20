import { describe, expect, it } from "vitest";
import { commandDigest } from "./digest.js";
import { commandAckSchema, commandResultSchema, deviceSnapshotSchema, serverCommandSchema, sessionConfigSchema } from "./index.js";

const words = [
  "good-morning", "i", "wake-up", "brush-teeth", "wash-face",
  "eat-breakfast", "study", "go", "happy",
] as const;

describe("SessionConfig v1", () => {
  it("accepts a complete config and rejects duplicate puzzle numbers", () => {
    const config = {
      schemaVersion: 1,
      sessionId: "demo-a",
      configRevision: 1,
      contentCatalogVersion: "signify-core-1",
      flow: ["landing", "learn-word", "ending"],
      content: {
        learnOpening: { wordId: "wake-up" },
        learnWord: { words: words.map((wordId, index) => ({ puzzleNumber: index + 1, wordId })) },
        learnText: { textIds: ["text-1"] },
        gaming: { wordIds: ["wake-up"] },
      },
    };
    expect(sessionConfigSchema.safeParse(config).success).toBe(true);
    config.content.learnWord.words[8]!.puzzleNumber = 8;
    expect(sessionConfigSchema.safeParse(config).success).toBe(false);
  });
});

describe("Unity protocol source reconciliation", () => {
  it("allows packaged revision zero commands and hashes semantic fields only", () => {
    const base = serverCommandSchema.parse({
      protocolVersion: 1,
      messageType: "command",
      sessionId: "packaged-default",
      configRevision: 0,
      deviceId: "vision-pro-demo",
      connectionId: "aaa",
      commandId: "cmd-1",
      serverSequence: 1,
      issuedAt: "2026-09-20T05:30:00.000Z",
      expiresAt: "2026-09-20T05:31:00.000Z",
      commandType: "navigate_section",
      payload: { sectionId: "learn-word" },
    });
    const retry = { ...base, connectionId: "bbb", serverSequence: 9, issuedAt: "2026-09-20T05:30:10.000Z" };
    expect(commandDigest(base)).toBe(commandDigest(retry));
  });

  it("matches the actual snapshot execution shape without a status field", () => {
    const snapshot = {
      protocolVersion: 1,
      messageType: "device_snapshot",
      sessionId: "demo-a",
      configRevision: 1,
      configSource: "remote",
      deviceId: "vision-pro-demo",
      connectionId: "conn",
      deviceStateRevision: 2,
      deviceEventSequence: 1,
      connectionState: "connected",
      bootPlanState: "active",
      transition: null,
      currentSection: { sectionId: "landing", sectionInstanceId: "landing@g1", generation: 1, origin: "boot" },
      pendingLanding: null,
      learnWord: null,
      fatal: null,
      lastProcessedServerSequence: 0,
      capabilities: ["navigate_section"],
      activeJudgment: null,
    };
    expect(deviceSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(deviceSnapshotSchema.safeParse({ ...snapshot, currentSection: { ...snapshot.currentSection!, status: "active" } }).success).toBe(false);
  });

  it("rejects server attempts to bypass Unity transition authority", () => {
    const base = {
      protocolVersion: 1, messageType: "command", sessionId: "demo-a", configRevision: 1,
      deviceId: "vision-pro-demo", connectionId: "conn", commandId: "cmd-2", serverSequence: 2,
      issuedAt: "2026-09-20T05:30:00.000Z", expiresAt: "2026-09-20T05:31:00.000Z",
    };
    expect(serverCommandSchema.safeParse({ ...base, commandType: "navigate_section", payload: { sceneName: "GamingScene" } }).success).toBe(false);
    expect(serverCommandSchema.safeParse({ ...base, commandType: "navigate_section", payload: { sectionId: 5 } }).success).toBe(false);
    expect(serverCommandSchema.safeParse({ ...base, commandType: "advance_subsection", payload: { targetPhase: "celebration", expectedPhase: "word_learning", expectedPhaseEpoch: 2 } }).success).toBe(false);
    expect(serverCommandSchema.safeParse({ ...base, commandType: "force_judgment", payload: { sectionInstanceId: "s1", attemptId: "a1", outcome: "correct", worldPose: [0, 1, 2] } }).success).toBe(false);
  });

  it("keeps ingress ACK and terminal result as distinct wire messages", () => {
    const identity = { protocolVersion: 1, sessionId: "demo-a", deviceId: "vision-pro-demo", connectionId: "conn" };
    expect(commandAckSchema.parse({ ...identity, messageType: "command_ack", commandId: "cmd-3", serverSequence: 3, ingressDisposition: "accepted", authorityCode: "accepted", transitionId: "t1", targetSectionInstanceId: "s1", deviceStateRevision: 4, replayed: false }).ingressDisposition).toBe("accepted");
    expect(commandResultSchema.parse({ ...identity, messageType: "command_result", commandId: "cmd-3", result: "activated", transitionId: "t1", sectionId: "gaming", sectionInstanceId: "s1", generation: 2, failureCode: null, deviceStateRevision: 5, deviceEventSequence: 6 }).result).toBe("activated");
  });
});
