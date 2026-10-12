import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api, idempotencyKey } from "./api.js";
import { courseStages } from "./courseStages.js";

const sectionOptions = courseStages.map(({ id, label }) => [id, label] as const);
const wordOptions = [
  ["good-morning", "早安"], ["i", "我"], ["wake-up", "起床"], ["brush-teeth", "刷牙"], ["wash-face", "洗臉"],
  ["eat-breakfast", "吃早餐"], ["study", "讀書"], ["go", "去"], ["happy", "開心"],
] as const;
const textOptions = [["text-1", "文本 1"], ["text-2", "文本 2"], ["text-3", "文本 3"], ["text-4", "文本 4"]] as const;

type SectionId = typeof sectionOptions[number][0];
type WordId = typeof wordOptions[number][0];
type TextId = typeof textOptions[number][0];
export type SessionConfig = {
  schemaVersion: 1;
  sessionId: string;
  configRevision: number;
  contentCatalogVersion: "signify-core-1";
  flow: SectionId[];
  content: {
    learnOpening: { wordId: WordId };
    learnWord: { words: Array<{ puzzleNumber: number; wordId: WordId }> };
    learnText: { textIds: TextId[] };
    gaming: { wordIds: WordId[] };
  };
};
type Revision = { revision: number; publishedAt?: string; publishedBy?: string; config: SessionConfig };

const starter: SessionConfig = {
  schemaVersion: 1, sessionId: "demo-session", configRevision: 1, contentCatalogVersion: "signify-core-1",
  flow: sectionOptions.map(([id]) => id),
  content: {
    learnOpening: { wordId: "good-morning" },
    learnWord: { words: wordOptions.map(([wordId], index) => ({ puzzleNumber: index + 1, wordId })) },
    learnText: { textIds: textOptions.map(([id]) => id) },
    gaming: { wordIds: wordOptions.map(([id]) => id) },
  },
};

export function ConfigEditor({ report }: { report: (message: string, tone?: "info" | "success" | "error") => void }) {
  const [config, setConfig] = useState<SessionConfig>(starter);
  const [editorSection, setEditorSection] = useState<"flow" | "content" | "details">("flow");
  const [flowKeys, setFlowKeys] = useState<string[]>(() => starter.flow.map(() => crypto.randomUUID()));
  const [flowAnnouncement, setFlowAnnouncement] = useState("");
  const [movedKey, setMovedKey] = useState<string | null>(null);
  const [removedStep, setRemovedStep] = useState<{ section: SectionId; index: number; key: string } | null>(null);
  const [draftVersion, setDraftVersion] = useState(0);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"validate" | "save" | "publish" | "rollback" | null>(null);
  const [dirty, setDirty] = useState(false);
  const [validated, setValidated] = useState(false);
  const [published, setPublished] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [publishConfirm, setPublishConfirm] = useState(false);
  const [rollbackTarget, setRollbackTarget] = useState<Revision | null>(null);
  const issues = useMemo(() => localIssues(config), [config]);

  const refreshHistory = useCallback(async () => {
    const result = await api<{ items: Revision[] }>("/api/v1/projects/default/config/revisions");
    setRevisions(result.items);
  }, []);

  const loadConfig = useCallback((next: SessionConfig) => {
    setConfig(next); setFlowKeys(next.flow.map(() => crypto.randomUUID())); setRemovedStep(null); setMovedKey(null); setFlowAnnouncement("");
  }, []);

  const loadDraft = useCallback(async () => {
    setLoading(true); setConflict(false);
    try {
      const draft = await api<{ config: SessionConfig; draftVersion: number }>("/api/v1/projects/default/config/draft");
      loadConfig(draft.config); setDraftVersion(draft.draftVersion);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
      try { loadConfig(await api<SessionConfig>("/api/v1/projects/default/config/latest")); }
      catch (latestError) {
        if (!(latestError instanceof ApiError) || latestError.status !== 404) throw latestError;
        loadConfig(starter);
      }
      setDraftVersion(0);
    } finally { setDirty(false); setValidated(false); setPublished(false); setLoading(false); }
  }, [loadConfig]);

  useEffect(() => { void Promise.all([loadDraft(), refreshHistory()]).catch((error) => report(friendlyError(error), "error")); }, [loadDraft, refreshHistory, report]);

  function update(next: SessionConfig) { setConfig(next); setDirty(true); setValidated(false); setPublished(false); setConflict(false); }
  function patchContent<K extends keyof SessionConfig["content"]>(key: K, value: SessionConfig["content"][K]) { update({ ...config, content: { ...config.content, [key]: value } }); }
  function addFlow(section: SectionId) {
    update({ ...config, flow: [...config.flow, section] });
    setFlowKeys([...flowKeys, crypto.randomUUID()]); setRemovedStep(null);
    setFlowAnnouncement(`已加入「${labelFor(sectionOptions, section)}」，位於第 ${config.flow.length + 1} 個。`);
  }
  function moveFlow(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= config.flow.length) return;
    const flow = [...config.flow]; [flow[index], flow[target]] = [flow[target]!, flow[index]!];
    const keys = [...flowKeys]; [keys[index], keys[target]] = [keys[target]!, keys[index]!];
    update({ ...config, flow }); setFlowKeys(keys); setMovedKey(keys[target]!);
    setFlowAnnouncement(`「${labelFor(sectionOptions, flow[target]!)}」已移到第 ${target + 1} 個。`);
  }
  function removeFlow(index: number) {
    setRemovedStep({ section: config.flow[index]!, index, key: flowKeys[index]! });
    update({ ...config, flow: config.flow.filter((_, candidate) => candidate !== index) });
    setFlowKeys(flowKeys.filter((_, candidate) => candidate !== index));
    setFlowAnnouncement(`已移除「${labelFor(sectionOptions, config.flow[index]!)}」。`);
  }
  function undoRemove() {
    if (!removedStep) return;
    const flow = [...config.flow], keys = [...flowKeys];
    const index = Math.min(removedStep.index, flow.length);
    flow.splice(index, 0, removedStep.section); keys.splice(index, 0, removedStep.key);
    update({ ...config, flow }); setFlowKeys(keys); setMovedKey(removedStep.key); setRemovedStep(null);
    setFlowAnnouncement(`已復原「${labelFor(sectionOptions, removedStep.section)}」。`);
  }
  function setPuzzleWord(index: number, wordId: WordId) { patchContent("learnWord", { words: config.content.learnWord.words.map((word, candidate) => candidate === index ? { ...word, wordId } : word) }); }
  function toggleText(textId: TextId) { const current = config.content.learnText.textIds; patchContent("learnText", { textIds: current.includes(textId) ? current.filter((item) => item !== textId) : [...current, textId] }); }
  function toggleGameWord(wordId: WordId) { const current = config.content.gaming.wordIds; patchContent("gaming", { wordIds: current.includes(wordId) ? current.filter((item) => item !== wordId) : [...current, wordId] }); }

  async function validate() {
    if (issues.length) return report(`請先修正 ${issues.length} 個欄位問題。`, "error");
    setBusy("validate");
    try { await api("/api/v1/projects/default/config/validate", { method: "POST", body: JSON.stringify(config) }); setValidated(true); report("課程設定檢查通過，可以發布。", "success"); }
    catch (error) { setValidated(false); report(friendlyError(error), "error"); }
    finally { setBusy(null); }
  }

  async function save() {
    if (issues.length) return report(`請先修正 ${issues.length} 個欄位問題。`, "error");
    setBusy("save");
    try {
      await api("/api/v1/projects/default/config/validate", { method: "POST", body: JSON.stringify(config) });
      const result = await api<{ config: SessionConfig; draftVersion: number }>("/api/v1/projects/default/config/draft", { method: "PUT", headers: { "if-match": `"draft-${draftVersion}"` }, body: JSON.stringify(config) });
      setConfig(result.config); setDraftVersion(result.draftVersion); setDirty(false); setValidated(true); report("草稿已儲存並通過檢查，可以發布。", "success");
    } catch (error) { if (error instanceof ApiError && error.status === 412) setConflict(true); report(friendlyError(error), "error"); }
    finally { setBusy(null); }
  }

  async function publish() {
    setBusy("publish");
    try {
      await api<{ revision: number }>("/api/v1/projects/default/config/publish", { method: "POST", headers: { "idempotency-key": idempotencyKey() } });
      setPublishConfirm(false); setPublished(true); await refreshHistory(); report("課程設定已發布，裝置會在下次載入時套用。", "success");
    } catch (error) { report(friendlyError(error), "error"); }
    finally { setBusy(null); }
  }

  async function rollback() {
    if (!rollbackTarget) return;
    setBusy("rollback");
    try {
      const result = await api<{ draftVersion: number }>("/api/v1/projects/default/config/rollback", { method: "POST", body: JSON.stringify({ revision: rollbackTarget.revision, expectedDraftVersion: draftVersion }) });
      const revision = rollbackTarget.revision; setRollbackTarget(null); await loadDraft(); report(`已從版本 ${revision} 建立草稿，尚未發布。`, "success");
    } catch (error) { if (error instanceof ApiError && error.status === 412) setConflict(true); report(friendlyError(error), "error"); }
    finally { setBusy(null); }
  }

  return <div className="config-workspace">
    <section className="page-heading"><div><span className="eyebrow">課程內容</span><h1>課程設定</h1><p>安排課程順序與學習內容，確認後發布給裝置。</p></div></section>
    {conflict && <section className="inline-alert error" role="alert"><div><strong>草稿已被其他操作者更新</strong><p>為避免覆蓋他人的修改，請重新載入最新草稿後再編輯。</p></div><button onClick={() => void loadDraft()}>重新載入</button></section>}
    <nav className="config-section-nav" aria-label="課程設定區塊">
      {([["flow", "課程順序", `${config.flow.length} 個階段`], ["content", "學習內容", "詞彙、課文與遊戲"], ["details", "課程資訊", "名稱與版本紀錄"]] as const).map(([id, label, detail]) => <button key={id} className={editorSection === id ? "selected" : ""} aria-current={editorSection === id ? "page" : undefined} aria-controls={`config-${id}`} onClick={() => setEditorSection(id)}><strong>{label}</strong><span>{detail}</span></button>)}
    </nav>
    <div className="config-layout"><div className="config-form">
      <fieldset className="config-fields" disabled={loading || Boolean(busy)}>
      {editorSection === "flow" && <section id="config-flow" className="surface form-section">
        <div className="section-heading"><div><h2>安排課程順序</h2><p>由上往下依序進行。每個階段下方都可以直接調整位置。</p></div></div>
        <ol className="flow-builder">{config.flow.length ? config.flow.map((section, index) => <li className={`flow-step ${movedKey === flowKeys[index] ? "recently-moved" : ""}`} key={flowKeys[index]}>
          <span className="flow-index">{String(index + 1).padStart(2, "0")}</span>
          <div className="flow-step-body"><div className="flow-step-title"><strong>{labelFor(sectionOptions, section)}</strong><span>{courseStages.find((stage) => stage.id === section)?.description}</span></div>
            <div className="flow-controls"><button className="secondary" aria-label={`將第 ${index + 1} 個「${labelFor(sectionOptions, section)}」上移`} disabled={index === 0} onClick={() => moveFlow(index, -1)}>↑ 上移</button><button className="secondary" aria-label={`將第 ${index + 1} 個「${labelFor(sectionOptions, section)}」下移`} disabled={index === config.flow.length - 1} onClick={() => moveFlow(index, 1)}>↓ 下移</button><button className="flow-remove" aria-label={`移除第 ${index + 1} 個「${labelFor(sectionOptions, section)}」`} onClick={() => removeFlow(index)}>× 移除</button></div>
          </div>
        </li>) : <li className="empty-inline">尚未加入課程階段，請從下方選擇。</li>}</ol>
        <div className="flow-feedback" role="status"><span>{flowAnnouncement || "先安排順序，再到「學習內容」選擇教材。"}</span>{removedStep && <button className="secondary" onClick={undoRemove}>↶ 復原移除</button>}</div>
        <div className="add-stages"><h3>加入課程階段</h3><div className="choice-row">{sectionOptions.filter(([id]) => id === "landing" || !config.flow.includes(id)).map(([id, label]) => <button className="choice add" key={id} onClick={() => addFlow(id)}>＋ {id === "landing" && config.flow.includes(id) ? "再加入定位與準備" : label}</button>)}</div><p>定位與準備可以在課程中重複安排。</p></div>
      </section>}
      {editorSection === "content" && <section id="config-content" className="content-editor">
        <div className="content-intro"><h2>選擇學習內容</h2><p>展開要修改的教材，每次專心調整一個區塊。</p></div>
        <details className="surface content-section"><summary><span><strong>開場詞彙</strong><small>目前使用：{labelFor(wordOptions, config.content.learnOpening.wordId)}</small></span><span className="content-expand" aria-hidden="true">＋</span></summary><div className="content-section-body"><label className="field"><span>示範與練習的詞彙</span><select value={config.content.learnOpening.wordId} onChange={(event) => patchContent("learnOpening", { wordId: event.target.value as WordId })}>{wordOptions.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label></div></details>
        <details className="surface content-section" open><summary><span><strong>單字學習拼圖</strong><small>{config.content.learnWord.words.length} 個詞彙 · 依編號順序教學</small></span><span className="content-expand" aria-hidden="true">＋</span></summary><div className="content-section-body"><p>依序選擇九個詞彙，同一個詞彙可以重複使用。</p><div className="puzzle-grid">{config.content.learnWord.words.map((word, index) => <label className="puzzle-field" key={word.puzzleNumber}><span>第 {index + 1} 個詞彙 <small>拼圖 {word.puzzleNumber}</small></span><select value={word.wordId} onChange={(event) => setPuzzleWord(index, event.target.value as WordId)}>{wordOptions.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>)}</div></div></details>
        <details className="surface content-section"><summary><span><strong>課文學習</strong><small>已選 {config.content.learnText.textIds.length} 段文本{config.content.learnText.textIds.length > 0 ? ` · ${config.content.learnText.textIds.map((id) => labelFor(textOptions, id)).join(" → ")}` : ""}</small></span><span className="content-expand" aria-hidden="true">＋</span></summary><div className="content-section-body"><p>依點選順序安排教學；再點一下即可移除。</p><div className="content-choices">{textOptions.map(([id, label]) => { const index = config.content.learnText.textIds.indexOf(id); return <button key={id} className={`choice ${index >= 0 ? "selected" : ""}`} aria-pressed={index >= 0} onClick={() => toggleText(id)}><span>{index >= 0 ? "✓" : "＋"} {label}</span><small>{index >= 0 ? `第 ${index + 1} 段教學` : "點選加入"}</small></button>; })}</div></div></details>
        <details className="surface content-section"><summary><span><strong>遊戲練習題庫</strong><small>已選 {config.content.gaming.wordIds.length} 個詞彙</small></span><span className="content-expand" aria-hidden="true">＋</span></summary><div className="content-section-body"><div className="game-selection-toolbar"><p>勾選遊戲會出現的詞彙。</p><button className="secondary" onClick={() => patchContent("gaming", { wordIds: wordOptions.map(([id]) => id) })}>全部選取</button></div><div className="content-choices">{wordOptions.map(([id, label]) => <button key={id} className={`choice ${config.content.gaming.wordIds.includes(id) ? "selected" : ""}`} aria-pressed={config.content.gaming.wordIds.includes(id)} onClick={() => toggleGameWord(id)}><span>{config.content.gaming.wordIds.includes(id) ? "✓" : "＋"} {label}</span></button>)}</div></div></details>
      </section>}
      {editorSection === "details" && <section id="config-details" className="surface form-section"><div className="section-heading"><div><h2>課程資訊</h2><p>為這次課程取一個容易辨識的名稱。</p></div></div><label className="field"><span>課程識別名稱</span><input value={config.sessionId} onChange={(event) => update({ ...config, sessionId: event.target.value })} placeholder="例如：class-a-morning"/><small>使用英數開頭，可搭配點、底線與連字號。</small></label></section>}
      </fieldset>
      <details className="surface revision-rail" hidden={editorSection !== "details"}><summary><span><strong>版本紀錄與復原</strong><small>需要查看舊版本或復原時再展開</small></span><span>展開</span></summary><div className="revision-body"><div className="revision-toolbar"><p>選擇舊版本只會建立草稿，不會立即影響裝置。</p><button className="secondary small" onClick={() => void refreshHistory()}>↻ 重新整理</button></div>{loading ? <div className="skeleton-list"><i/><i/><i/></div> : revisions.length ? <div className="revision-list">{revisions.map((revision, index) => <article className="revision-card" key={revision.revision}><div><span className={index === 0 ? "status-badge success" : "status-badge"}>{index === 0 ? "目前使用" : "歷史版本"}</span><strong>版本 {revision.revision}</strong><small>{formatTime(revision.publishedAt)}</small></div><button className="secondary small" disabled={Boolean(busy)} onClick={() => setRollbackTarget(revision)}>使用這個版本建立草稿</button></article>)}</div> : <div className="empty-state compact"><span>◇</span><strong>尚無發布紀錄</strong><p>先儲存並發布第一份設定。</p></div>}</div></details>
    </div></div>
    {issues.length > 0 && <section className="config-issues" role="alert"><strong>儲存前需要處理</strong><ul>{issues.map((issue) => <li key={issue}>{issue}</li>)}</ul></section>}
    <section className="surface action-bar"><div className="save-state"><span className={`state-dot ${dirty ? "warning" : validated ? "success" : ""}`}/><div><strong>{loading ? "正在載入課程…" : dirty ? "有尚未儲存的修改" : published ? "課程已發布" : validated ? "草稿已檢查，可以發布" : "課程草稿已載入"}</strong><small>{issues.length ? `${issues.length} 個問題待修正` : dirty || draftVersion === 0 ? "儲存時會自動檢查設定" : validated ? "發布後於裝置下次載入套用" : "檢查設定後即可發布"}</small></div></div><div className="action-group"><button className="secondary" disabled={loading || Boolean(busy) || issues.length > 0 || validated && !dirty && draftVersion > 0} onClick={() => void (dirty || draftVersion === 0 ? save() : validate())}>{busy === "save" ? "儲存中…" : busy === "validate" ? "檢查中…" : dirty || draftVersion === 0 ? "儲存草稿" : validated ? "草稿已儲存 ✓" : "檢查設定"}</button><button className="publish-button" disabled={loading || Boolean(busy) || published || dirty || !validated || draftVersion === 0 || issues.length > 0} onClick={() => setPublishConfirm(true)}>{published ? "已發布 ✓" : "發布課程"}</button></div></section>
    {publishConfirm && <div className="modal" role="dialog" aria-modal="true" aria-labelledby="publish-title"><div className="modal-card"><span className="modal-icon warning">↑</span><h2 id="publish-title">發布目前的課程設定？</h2><p>發布後，裝置會在下次載入時取得這份設定。正在執行中的裝置不會被強制中斷。</p><div className="modal-actions"><button className="secondary" onClick={() => setPublishConfirm(false)}>返回檢查</button><button className="publish-button" disabled={busy === "publish"} onClick={() => void publish()}>{busy === "publish" ? "發布中…" : "確認發布"}</button></div></div></div>}
    {rollbackTarget && <div className="modal" role="dialog" aria-modal="true" aria-labelledby="rollback-title"><div className="modal-card"><span className="modal-icon">↶</span><h2 id="rollback-title">從版本 {rollbackTarget.revision} 建立草稿？</h2><p>目前草稿會被這個歷史版本取代，但不會立即發布到裝置。</p><div className="modal-actions"><button className="secondary" onClick={() => setRollbackTarget(null)}>取消</button><button disabled={busy === "rollback"} onClick={() => void rollback()}>{busy === "rollback" ? "建立中…" : "建立復原草稿"}</button></div></div></div>}
  </div>;
}

export function localIssues(config: SessionConfig): string[] {
  const issues: string[] = [];
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(config.sessionId)) issues.push("Session ID 格式不正確");
  if (config.flow.length === 0) issues.push("課程流程至少需要一個 section");
  const puzzleNumbers = config.content.learnWord.words.map((word) => word.puzzleNumber);
  if (puzzleNumbers.length !== 9 || new Set(puzzleNumbers).size !== 9 || puzzleNumbers.some((value) => value < 1 || value > 9)) issues.push("Learn word 必須包含拼圖編號 1–9，且每個編號恰好一次");
  if (config.content.learnText.textIds.length === 0) issues.push("Learn text 至少選擇一段文本");
  if (config.content.gaming.wordIds.length === 0) issues.push("Gaming 至少選擇一個詞彙");
  return issues;
}
function labelFor<T extends readonly (readonly [string, string])[]>(options: T, id: string) { return options.find(([candidate]) => candidate === id)?.[1] ?? id; }
function formatTime(value?: string) { return value ? new Intl.DateTimeFormat("zh-TW", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "時間未知"; }
function friendlyError(error: unknown) {
  if (!(error instanceof ApiError)) return "發生未預期錯誤，請稍後再試。";
  const messages: Record<string, string> = { draft_conflict: "草稿已被其他操作者更新，請重新載入。", invalid_config: "設定未通過 server 驗證，請檢查欄位。", valid_draft_required: "請先儲存一份有效草稿。", draft_already_published: "這份草稿已經發布過。", draft_or_base_changed: "草稿或發布基準已改變，請重新載入。" };
  return messages[error.code] ?? `操作失敗（${error.code}）`;
}
