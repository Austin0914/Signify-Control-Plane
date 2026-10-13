export type TrackedCommand = { commandId: string; status: string; commandType?: string; createdAt?: string; deviceId?: string; judgmentKey?: string };
export type JudgmentCommands = Record<string, TrackedCommand>;

const terminalStatuses = new Set(["activated", "superseded", "failed", "rejected", "expired", "judged_correct", "judged_wrong"]);
const retryStatuses = new Set(["failed", "rejected", "expired", "superseded"]);

export function pendingCommandIds(recent: TrackedCommand | null, judgments: JudgmentCommands): string[] {
  return [...new Set([...(recent ? [recent] : []), ...Object.values(judgments)]
    .filter((command) => !terminalStatuses.has(command.status)).map((command) => command.commandId))].sort();
}

export function updateJudgmentStatus(current: JudgmentCommands, commandId: string, status: string): JudgmentCommands {
  const entry = Object.entries(current).find(([, command]) => command.commandId === commandId);
  if (!entry || entry[1].status === status) return current;
  const [key, command] = entry;
  const next = { ...current };
  if (retryStatuses.has(status)) delete next[key];
  else next[key] = { ...command, status };
  return next;
}
