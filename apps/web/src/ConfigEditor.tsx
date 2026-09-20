import { useState } from "react";
import { api, idempotencyKey } from "./api.js";

const starter = {
  schemaVersion: 1,
  sessionId: "demo-session",
  configRevision: 1,
  contentCatalogVersion: "signify-core-1",
  flow: ["landing", "opening", "learn-opening", "learn-word", "learn-text", "gaming", "ending"],
  content: {
    learnOpening: { wordId: "good-morning" },
    learnWord: { words: ["good-morning", "i", "wake-up", "brush-teeth", "wash-face", "eat-breakfast", "study", "go", "happy"].map((wordId, index) => ({ puzzleNumber: index + 1, wordId })) },
    learnText: { textIds: ["text-1", "text-2", "text-3", "text-4"] },
    gaming: { wordIds: ["good-morning", "i", "wake-up", "brush-teeth", "wash-face", "eat-breakfast", "study", "go", "happy"] },
  },
};

export function ConfigEditor({ report }: { report: (message: string) => void }) {
  const [text, setText] = useState(JSON.stringify(starter, null, 2));
  const [draftVersion, setDraftVersion] = useState(0);
  const [valid, setValid] = useState<boolean | null>(null);

  async function load() {
    try {
      const result = await api<{ config: unknown; draftVersion: number }>("/api/v1/projects/default/config/draft");
      setText(JSON.stringify(result.config, null, 2)); setDraftVersion(result.draftVersion); setValid(null); report(`Draft v${result.draftVersion} 已載入。`);
    } catch (error) { report(`${String(error)}；若尚無 draft，可直接從預設範本開始。`); }
  }

  async function validate() {
    try {
      await api("/api/v1/projects/default/config/validate", { method: "POST", body: text });
      setValid(true); report("Config schema 與 catalog 驗證通過。");
    } catch (error) { setValid(false); report(String(error)); }
  }

  async function save() {
    try {
      const result = await api<{ draftVersion: number }>("/api/v1/projects/default/config/draft", {
        method: "PUT", headers: { "if-match": `\"draft-${draftVersion}\"` }, body: text,
      });
      setDraftVersion(result.draftVersion); setValid(true); report(`Draft v${result.draftVersion} 已儲存。`);
    } catch (error) { report(`${String(error)}；若是 412，請重新載入以免覆蓋別人的草稿。`); }
  }

  async function publish() {
    if (!valid) return report("請先驗證並儲存 draft。");
    if (window.prompt("輸入 PUBLISH 以建立不可變 revision") !== "PUBLISH") return report("已取消 publish。");
    try {
      const result = await api<{ revision: number }>("/api/v1/projects/default/config/publish", { method: "POST", headers: { "idempotency-key": idempotencyKey() } });
      report(`Config revision ${result.revision} 已發佈；裝置仍以自身實際載入結果回報 truth。`);
    } catch (error) { report(String(error)); }
  }

  return <section className="config-panel"><div><span className="label">CONFIG DRAFT</span><h2>Session configuration</h2></div><textarea spellCheck={false} value={text} onChange={(event) => { setText(event.target.value); setValid(null); }} /><div className="config-actions"><span>Draft v{draftVersion} · {valid === true ? "valid" : valid === false ? "invalid" : "not validated"}</span><button className="ghost" onClick={() => void load()}>重新載入</button><button className="ghost" onClick={() => void validate()}>驗證</button><button onClick={() => void save()}>儲存草稿</button><button className="danger" onClick={() => void publish()}>Publish</button></div></section>;
}
