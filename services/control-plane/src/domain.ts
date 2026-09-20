export type CommandLifecycle =
  | "queued"
  | "sent"
  | "accepted"
  | "deferred"
  | "activated"
  | "superseded"
  | "failed"
  | "judged_correct"
  | "judged_wrong"
  | "rejected"
  | "expired";

const terminal = new Set<CommandLifecycle>(["activated", "superseded", "failed", "judged_correct", "judged_wrong", "rejected", "expired"]);

const allowed: Record<CommandLifecycle, ReadonlySet<CommandLifecycle>> = {
  queued: new Set(["sent", "expired"]),
  sent: new Set(["sent", "accepted", "deferred", "activated", "superseded", "failed", "judged_correct", "judged_wrong", "rejected", "expired"]),
  accepted: new Set(["activated", "superseded", "failed", "judged_correct", "judged_wrong"]),
  deferred: new Set(["accepted", "deferred", "activated", "superseded", "failed", "judged_correct", "judged_wrong", "expired"]),
  activated: new Set(),
  superseded: new Set(),
  failed: new Set(),
  judged_correct: new Set(),
  judged_wrong: new Set(),
  rejected: new Set(),
  expired: new Set(),
};

export function advanceCommand(current: CommandLifecycle, next: CommandLifecycle): CommandLifecycle {
  if (current === next) return current;
  if (!allowed[current].has(next)) throw new Error(`Invalid command transition ${current} -> ${next}`);
  return next;
}

export function isTerminal(value: CommandLifecycle): boolean {
  return terminal.has(value);
}

export function classifySnapshotConflict(desiredSection: string | undefined, actualSection: string | undefined) {
  return {
    conflict: desiredSection !== undefined && desiredSection !== actualSection,
    displayedRuntimeSection: actualSection ?? null,
    pendingDesiredSection: desiredSection ?? null,
  };
}
