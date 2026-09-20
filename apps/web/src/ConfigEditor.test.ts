import { describe, expect, it } from "vitest";
import { localIssues, type SessionConfig } from "./ConfigEditor.js";

function repeatedLearnWordConfig(): SessionConfig {
  return {
    schemaVersion: 1,
    sessionId: "repeated-learn-word",
    configRevision: 1,
    contentCatalogVersion: "signify-core-1",
    flow: ["learn-word"],
    content: {
      learnOpening: { wordId: "good-morning" },
      learnWord: {
        words: Array.from({ length: 9 }, (_, index) => ({
          puzzleNumber: index + 1,
          wordId: "good-morning" as const,
        })),
      },
      learnText: { textIds: ["text-1"] },
      gaming: { wordIds: ["good-morning"] },
    },
  };
}

describe("ConfigEditor local validation", () => {
  it("allows repeated LearnWord word IDs", () => {
    expect(localIssues(repeatedLearnWordConfig())).toEqual([]);
  });

  it("still rejects duplicate puzzle numbers", () => {
    const config = repeatedLearnWordConfig();
    config.content.learnWord.words[8]!.puzzleNumber = 8;
    expect(localIssues(config)).toContain("Learn word 必須包含拼圖編號 1–9，且每個編號恰好一次");
  });
});
