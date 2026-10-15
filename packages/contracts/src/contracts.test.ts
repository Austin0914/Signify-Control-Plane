import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { commandDigest } from "./digest.js";
import { commandAckSchema, commandResultSchema, deviceInboundMessageSchema, deviceSnapshotSchema, serverCommandSchema, sessionConfigSchema } from "./index.js";

const words = [
  "good-morning", "i", "wake-up", "brush-teeth", "wash-face",
  "eat-breakfast", "study", "go", "happy",
] as const;

describe("SessionConfig v1", () => {
  it.each([undefined, false, true])("preserves optional game auto-start %s through JSON serialization", (autoStart) => {
    const config = {
      schemaVersion: 1, sessionId: "auto-game", configRevision: 1, contentCatalogVersion: "signify-core-1",
      flow: ["landing", "gaming", "ending"], content: {
        learnOpening: { wordId: "good-morning" },
        learnWord: { words: words.map((wordId, index) => ({ puzzleNumber: index + 1, wordId })) },
        learnText: { textIds: ["text-1"] }, gaming: { wordIds: ["good-morning"], ...(autoStart === undefined ? {} : { autoStart }) },
      },
    };
    const result = sessionConfigSchema.parse(JSON.parse(JSON.stringify(config)));
    expect(result.content.gaming.autoStart).toBe(autoStart);
    for (const invalid of ["true", 1, null]) {
      expect(sessionConfigSchema.safeParse({ ...config, content: { ...config.content, gaming: { ...config.content.gaming, autoStart: invalid } } }).success).toBe(false);
    }
  });
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

  it("allows repeated LearnWord word IDs while puzzle numbers remain unique", () => {
    const config = {
      schemaVersion: 1,
      sessionId: "repeated-learn-word",
      configRevision: 1,
      contentCatalogVersion: "signify-core-1",
      flow: ["learn-word"],
      content: {
        learnOpening: { wordId: "good-morning" },
        learnWord: { words: words.map((_, index) => ({ puzzleNumber: index + 1, wordId: "good-morning" })) },
        learnText: { textIds: ["text-1"] },
        gaming: { wordIds: ["good-morning"] },
      },
    };
    expect(sessionConfigSchema.safeParse(config).success).toBe(true);
  });
});

describe("Unity protocol source reconciliation", () => {
  it("accepts game start capability, state, replay and terminal messages captured from Unity", () => {
    const messages = JSON.parse(readFileSync(new URL("../fixtures/unity-game-start-results.json", import.meta.url), "utf8")) as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(7);
    for (const message of messages) expect(deviceInboundMessageSchema.safeParse(message).success).toBe(true);
  });
  it("accepts ACK and terminal replay messages captured from the Unity writer and processor", () => {
    const messages = JSON.parse(readFileSync(new URL("../fixtures/unity-replay-results.json", import.meta.url), "utf8")) as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(3);
    for (const message of messages) {
      expect(deviceInboundMessageSchema.safeParse(message).success).toBe(true);
      expect(message.connectionId).toBe("new-connection");
      if (message.messageType === "command_ack") expect(message.replayed).toBe(true);
      else {
        expect(message).not.toHaveProperty("serverSequence");
        expect(message.deviceEventSequence).toBe(7);
      }
    }
  });
  it("enforces Unity's exact 60-second TTL boundary, including millisecond drift", () => {
    const command = {
      protocolVersion: 1, messageType: "command", sessionId: "demo-a", configRevision: 1,
      deviceId: "vision-pro-demo", connectionId: "conn", commandId: "cmd-ttl", serverSequence: 1,
      issuedAt: "2026-10-12T17:50:37.509Z", commandType: "request_snapshot", payload: {},
    };
    expect(serverCommandSchema.safeParse({ ...command, expiresAt: "2026-10-12T17:51:37.509Z" }).success).toBe(true);
    expect(serverCommandSchema.safeParse({ ...command, expiresAt: "2026-10-12T17:51:37.510Z" }).success).toBe(false);
    expect(serverCommandSchema.safeParse({ ...command, expiresAt: command.issuedAt }).success).toBe(false);
    expect(serverCommandSchema.safeParse({ ...command, expiresAt: "2026-10-12T17:50:37.508Z" }).success).toBe(false);
  });

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
    expect(deviceSnapshotSchema.safeParse({ ...snapshot, gaming: { phase: "rules_gate", canStart: true } }).success).toBe(true);
    expect(deviceSnapshotSchema.safeParse({ ...snapshot, gaming: { phase: "rules_gate", canStart: "yes" } }).success).toBe(false);
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
    expect(serverCommandSchema.safeParse({ ...base, commandType: "start_gaming", payload: { sectionInstanceId: "gaming@g3" } }).success).toBe(true);
    expect(serverCommandSchema.safeParse({ ...base, commandType: "start_gaming", payload: {} }).success).toBe(false);
    expect(serverCommandSchema.safeParse({ ...base, commandType: "start_gaming", payload: { sectionInstanceId: "gaming@g3", skipIntro: true } }).success).toBe(false);
  });

  it("keeps ingress ACK and terminal result as distinct wire messages", () => {
    const identity = { protocolVersion: 1, sessionId: "demo-a", deviceId: "vision-pro-demo", connectionId: "conn" };
    expect(commandAckSchema.parse({ ...identity, messageType: "command_ack", commandId: "cmd-3", serverSequence: 3, ingressDisposition: "accepted", authorityCode: "accepted", transitionId: "t1", targetSectionInstanceId: "s1", deviceStateRevision: 4, replayed: false }).ingressDisposition).toBe("accepted");
    expect(commandResultSchema.parse({ ...identity, messageType: "command_result", commandId: "cmd-3", result: "activated", transitionId: "t1", sectionId: "gaming", sectionInstanceId: "s1", generation: 2, failureCode: null, deviceStateRevision: 5, deviceEventSequence: 6 }).result).toBe("activated");
  });
});

describe("manual demo hand", () => {
  const config = {
    schemaVersion: 1, sessionId: "manual-hand", configRevision: 1, contentCatalogVersion: "signify-core-1",
    flow: ["landing", "learn-word", "gaming", "ending"], content: {
      learnOpening: { wordId: "good-morning" },
      learnWord: { words: words.map((wordId, index) => ({ puzzleNumber: index + 1, wordId })) },
      learnText: { textIds: ["text-1"] }, gaming: { wordIds: ["good-morning"], autoStart: true },
    },
  };
  it.each([undefined, false, true])("preserves manual-only policy %s without changing game start", (manualOnly) => {
    const result = sessionConfigSchema.parse(JSON.parse(JSON.stringify({ ...config, ...(manualOnly === undefined ? {} : { demoHandManualOnly: manualOnly }) })));
    expect(result.demoHandManualOnly).toBe(manualOnly);
    expect(result.content.gaming.autoStart).toBe(true);
  });
  it.each(["true", 1, null])("rejects a coerced manual-only policy %s", (value) => {
    expect(sessionConfigSchema.safeParse({ ...config, demoHandManualOnly: value }).success).toBe(false);
  });
  it("requires an exact attempt and disallows outcome or sign overrides", () => {
    const base = { protocolVersion: 1, messageType: "command", sessionId: "manual-hand", configRevision: 1,
      deviceId: "device", connectionId: "connection", commandId: "hand-one", serverSequence: 1,
      issuedAt: "2026-10-16T00:00:00Z", expiresAt: "2026-10-16T00:00:30Z", commandType: "show_demo_hand" };
    const payload = { sectionInstanceId: "word@g1", attemptId: "attempt-1" };
    expect(serverCommandSchema.safeParse({ ...base, payload }).success).toBe(true);
    for (const invalid of [{ sectionInstanceId: "word@g1" }, { ...payload, attemptId: "" }, { ...payload, outcome: "correct" }, { ...payload, signId: "happy" }])
      expect(serverCommandSchema.safeParse({ ...base, payload: invalid }).success).toBe(false);
  });
});

it("accepts manual demo hand snapshots, rejection, activation and replay captured from Unity", () => {
  const messages = JSON.parse(readFileSync(new URL("../fixtures/unity-demo-hand-results.json", import.meta.url), "utf8")) as Array<Record<string, unknown>>;
  expect(messages.length).toBeGreaterThanOrEqual(8);
  for (const message of messages) expect(deviceInboundMessageSchema.safeParse(message).success).toBe(true);
});
