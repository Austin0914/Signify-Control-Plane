import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;
export const CONTENT_CATALOG_VERSION = "signify-core-1" as const;
export const MAX_UNITY_MESSAGE_BYTES = 64 * 1024;
export const MAX_API_GATEWAY_FRAME_BYTES = 32 * 1024;
export const MAX_COMMAND_TTL_SECONDS = 60;

export const sectionIdSchema = z.enum([
  "landing",
  "opening",
  "learn-opening",
  "learn-word",
  "learn-text",
  "gaming",
  "ending",
]);

export const wordIdSchema = z.enum([
  "good-morning",
  "i",
  "wake-up",
  "brush-teeth",
  "wash-face",
  "eat-breakfast",
  "study",
  "go",
  "happy",
]);

export const textIdSchema = z.enum(["text-1", "text-2", "text-3", "text-4"]);
export const learnWordPhaseSchema = z.enum([
  "puzzle_appearance",
  "word_learning",
  "final_assembly",
  "celebration",
]);

const identitySchema = z.string().min(1).max(128).regex(/^[\x21-\x7e]+$/);
const commandIdSchema = z.string().min(1).max(64).regex(/^[\x21-\x7e]+$/);
const positiveInteger = z.number().int().positive();

export const sessionConfigSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  configRevision: positiveInteger,
  contentCatalogVersion: z.literal(CONTENT_CATALOG_VERSION),
  flow: z.array(sectionIdSchema).min(1),
  content: z.object({
    learnOpening: z.object({ wordId: wordIdSchema }).strict(),
    learnWord: z.object({
      words: z.array(z.object({
        puzzleNumber: z.number().int().min(1).max(9),
        wordId: wordIdSchema,
      }).strict()).length(9).superRefine((words, context) => {
        const numbers = new Set(words.map((word) => word.puzzleNumber));
        if (numbers.size !== 9) {
          context.addIssue({ code: "custom", message: "Puzzle numbers 1-9 must each appear exactly once." });
        }
      }),
    }).strict(),
    learnText: z.object({ textIds: z.array(textIdSchema).min(1).max(4) }).strict()
      .superRefine((value, context) => uniqueArray(value.textIds, "textIds", context)),
    gaming: z.object({ wordIds: z.array(wordIdSchema).min(1).max(9) }).strict()
      .superRefine((value, context) => uniqueArray(value.wordIds, "wordIds", context)),
  }).strict(),
}).strict();

function uniqueArray(values: readonly string[], field: string, context: z.RefinementCtx): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", path: [field], message: `${field} must not contain duplicates.` });
  }
}

const baseDeviceMessageShape = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  sessionId: identitySchema,
  deviceId: identitySchema,
  connectionId: identitySchema,
};

export const clientHelloSchema = z.object({
  ...baseDeviceMessageShape,
  messageType: z.literal("client_hello"),
  configRevision: z.number().int().nonnegative(),
  deviceStateRevision: z.number().int().nonnegative(),
  capabilities: z.array(z.enum([
    "navigate_section",
    "advance_subsection",
    "force_judgment",
    "request_snapshot",
  ])).max(16),
}).strict();

export const heartbeatSchema = z.object({
  ...baseDeviceMessageShape,
  messageType: z.literal("heartbeat"),
  deviceStateRevision: z.number().int().nonnegative(),
  deviceEventSequence: z.number().int().nonnegative(),
  inboxDepth: z.number().int().nonnegative(),
  inboxHighWater: z.number().int().nonnegative(),
  outboundDepth: z.number().int().nonnegative(),
  outboundHighWater: z.number().int().nonnegative(),
  ledgerSize: z.number().int().nonnegative(),
  sentAt: z.iso.datetime({ offset: true }),
}).strict();

export const commandAckSchema = z.object({
  ...baseDeviceMessageShape,
  messageType: z.literal("command_ack"),
  commandId: commandIdSchema,
  serverSequence: positiveInteger,
  ingressDisposition: z.enum(["accepted", "deferred"]),
  authorityCode: z.string().max(128),
  transitionId: identitySchema.nullable(),
  targetSectionInstanceId: identitySchema.nullable(),
  deviceStateRevision: z.number().int().nonnegative(),
  replayed: z.boolean(),
}).strict();

export const commandNackSchema = z.object({
  ...baseDeviceMessageShape,
  messageType: z.literal("command_nack"),
  commandId: z.string().max(64),
  serverSequence: z.number().int().nonnegative(),
  ingressDisposition: z.literal("rejected"),
  reasonCode: z.string().min(1).max(128),
  detail: z.string().max(256),
  deviceStateRevision: z.number().int().nonnegative(),
  replayed: z.boolean(),
}).strict();

export const commandResultSchema = z.object({
  ...baseDeviceMessageShape,
  messageType: z.literal("command_result"),
  commandId: commandIdSchema,
  result: z.enum(["activated", "superseded", "failed"]),
  transitionId: identitySchema.nullable(),
  sectionId: sectionIdSchema.nullable(),
  sectionInstanceId: identitySchema.nullable(),
  generation: positiveInteger.nullable(),
  failureCode: z.string().max(128).nullable(),
  deviceStateRevision: z.number().int().nonnegative(),
  deviceEventSequence: z.number().int().nonnegative(),
}).strict();

export const judgmentResultSchema = z.object({
  ...baseDeviceMessageShape,
  messageType: z.literal("judgment_result"),
  commandId: commandIdSchema,
  sectionInstanceId: identitySchema,
  attemptId: identitySchema,
  outcome: z.enum(["correct", "wrong"]),
  source: z.literal("manual_remote"),
  deviceStateRevision: z.number().int().nonnegative(),
  deviceEventSequence: z.number().int().nonnegative(),
}).strict();

export const executionSchema = z.object({
  sectionId: sectionIdSchema,
  sectionInstanceId: identitySchema,
  generation: positiveInteger,
  origin: z.string().min(1).max(64),
}).strict();

export const deviceSnapshotSchema = z.object({
  ...baseDeviceMessageShape,
  messageType: z.literal("device_snapshot"),
  configRevision: z.number().int().nonnegative(),
  configSource: z.enum(["remote", "packageddefault", "packaged_default"]),
  deviceStateRevision: z.number().int().nonnegative(),
  deviceEventSequence: z.number().int().nonnegative(),
  connectionState: z.literal("connected"),
  bootPlanState: z.string().min(1).max(128),
  transition: z.object({
    state: z.string().min(1).max(128),
    transitionId: identitySchema.nullable(),
    target: executionSchema.nullable(),
  }).strict().nullable(),
  currentSection: executionSchema.nullable(),
  pendingLanding: executionSchema.nullable(),
  learnWord: z.object({
    phase: learnWordPhaseSchema,
    phaseEpoch: positiveInteger,
    phaseTransitioning: z.boolean(),
  }).strict().nullable(),
  fatal: z.object({ code: z.string().min(1).max(128), detail: z.string().max(256) }).strict().nullable(),
  lastProcessedServerSequence: z.number().int().nonnegative(),
  capabilities: z.array(z.string().min(1).max(64)).max(16),
  activeJudgment: z.object({
    sectionInstanceId: identitySchema,
    attemptId: identitySchema,
    status: z.literal("active"),
    startedAt: z.iso.datetime({ offset: true }),
  }).strict().nullable(),
}).strict();

export const deviceInboundMessageSchema = z.discriminatedUnion("messageType", [
  clientHelloSchema,
  heartbeatSchema,
  commandAckSchema,
  commandNackSchema,
  commandResultSchema,
  judgmentResultSchema,
  deviceSnapshotSchema,
]);

const commandBaseShape = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  messageType: z.literal("command"),
  sessionId: identitySchema,
  configRevision: z.number().int().nonnegative(),
  deviceId: identitySchema,
  connectionId: identitySchema,
  commandId: commandIdSchema,
  serverSequence: positiveInteger,
  issuedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
};

export const serverCommandSchema = z.discriminatedUnion("commandType", [
  z.object({ ...commandBaseShape, commandType: z.literal("navigate_section"), payload: z.object({ sectionId: sectionIdSchema }).strict() }).strict(),
  z.object({ ...commandBaseShape, commandType: z.literal("advance_subsection"), payload: z.object({ expectedPhase: learnWordPhaseSchema, expectedPhaseEpoch: positiveInteger }).strict() }).strict(),
  z.object({ ...commandBaseShape, commandType: z.literal("force_judgment"), payload: z.object({ sectionInstanceId: identitySchema, attemptId: identitySchema, outcome: z.enum(["correct", "wrong"]) }).strict() }).strict(),
  z.object({ ...commandBaseShape, commandType: z.literal("request_snapshot"), payload: z.object({}).strict() }).strict(),
]);

export const serverHelloSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  messageType: z.literal("server_hello"),
  sessionId: identitySchema,
  configRevision: z.number().int().nonnegative(),
  deviceId: identitySchema,
  connectionId: identitySchema,
  serverTime: z.iso.datetime({ offset: true }),
}).strict();

export const heartbeatAckSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  messageType: z.literal("heartbeat_ack"),
  sessionId: identitySchema,
  configRevision: z.number().int().nonnegative(),
  deviceId: identitySchema,
  connectionId: identitySchema,
}).strict();

export type SessionConfig = z.infer<typeof sessionConfigSchema>;
export type DeviceInboundMessage = z.infer<typeof deviceInboundMessageSchema>;
export type DeviceSnapshot = z.infer<typeof deviceSnapshotSchema>;
export type ServerCommand = z.infer<typeof serverCommandSchema>;
export type SectionId = z.infer<typeof sectionIdSchema>;
