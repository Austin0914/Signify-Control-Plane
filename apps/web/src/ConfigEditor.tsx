import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api, idempotencyKey } from "./api.js";

const sectionOptions = [
  ["landing", "Landing"], ["opening", "Opening"], ["learn-opening", "Learn opening"],
  ["learn-word", "Learn word"], ["learn-text", "Learn text"], ["gaming", "Gaming"], ["ending", "Ending"],
] as const;
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
  const [draftVersion, setDraftVersion] = useState(0);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"validate" | "save" | "publish" | "rollback" | null>(null);
  const [dirty, setDirty] = useState(false);
  const [validated, setValidated] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [publishConfirm, setPublishConfirm] = useState(false);
  const [rollbackTarget, setRollbackTarget] = useState<Revision | null>(null);
  const issues = useMemo(() => localIssues(config), [config]);

  const refreshHistory = useCallback(async () => {
    const result = await api<{ items: Revision[] }>("/api/v1/projects/default/config/revisions");
    setRevisions(result.items);
  }, []);

  const loadDraft = useCallback(async () => {
    setLoading(true); setConflict(false);
    try {
      const draft = await api<{ config: SessionConfig; draftVersion: number }>("/api/v1/projects/default/config/draft");
      setConfig(draft.config); setDraftVersion(draft.draftVersion);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
      try { setConfig(await api<SessionConfig>("/api/v1/projects/default/config/latest")); }
      catch (latestError) {
        if (!(latestError instanceof ApiError) || latestError.status !== 404) throw latestError;
        setConfig(starter);
      }
      setDraftVersion(0);
    } finally { setDirty(false); setValidated(false); setLoading(false); }
  }, []);

  useEffect(() => { void Promise.all([loadDraft(), refreshHistory()]).catch((error) => report(friendlyError(error), "error")); }, [loadDraft, refreshHistory, report]);

  function update(next: SessionConfig) { setConfig(next); setDirty(true); setValidated(false); setConflict(false); }
  function patchContent<K extends keyof SessionConfig["content"]>(key: K, value: SessionConfig["content"][K]) { update({ ...config, content: { ...config.content, [key]: value } }); }
  function toggleFlow(section: SectionId) { update({ ...config, flow: config.flow.includes(section) ? config.flow.filter((item) => item !== section) : [...config.flow, section] }); }
  function moveFlow(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= config.flow.length) return;
    const flow = [...config.flow]; [flow[index], flow[target]] = [flow[target]!, flow[index]!]; update({ ...config, flow });
  }
  function setPuzzleWord(index: number, wordId: WordId) { patchContent("learnWord", { words: config.content.learnWord.words.map((word, candidate) => candidate === index ? { ...word, wordId } : word) }); }
  function toggleText(textId: TextId) { const current = config.content.learnText.textIds; patchContent("learnText", { textIds: current.includes(textId) ? current.filter((item) => item !== textId) : [...current, textId] }); }
  function toggleGameWord(wordId: WordId) { const current = config.content.gaming.wordIds; patchContent("gaming", { wordIds: current.includes(wordId) ? current.filter((item) => item !== wordId) : [...current, wordId] }); }

  async function validate() {
    if (issues.length) return report(`請先修正 ${issues.length} 個欄位問題。`, "error");
    setBusy("validate");
    try { await api("/api/v1/projects/default/config/validate", { method: "POST", body: JSON.stringify(config) }); setValidated(true); report("設定已通過 server schema 與 content catalog 驗證。", "success"); }
    catch (error) { setValidated(false); report(friendlyError(error), "error"); }
    finally { setBusy(null); }
  }

  async function save() {
    if (issues.length) return report(`請先修正 ${issues.length} 個欄位問題。`, "error");
    setBusy("save");
    try {
      await api("/api/v1/projects/default/config/validate", { method: "POST", body: JSON.stringify(config) });
      const result = await api<{ config: SessionConfig; draftVersion: number }>("/api/v1/projects/default/config/draft", { method: "PUT", headers: { "if-match": `"draft-${draftVersion}"` }, body: JSON.stringify(config) });
      setConfig(result.config); setDraftVersion(result.draftVersion); setDirty(false); setValidated(true); report(`草稿 v${result.draftVersion} 已安全儲存。`, "success");
    } catch (error) { if (error instanceof ApiError && error.status === 412) setConflict(true); report(friendlyError(error), "error"); }
    finally { setBusy(null); }
  }

  async function publish() {
    setBusy("publish");
    try {
      const result = await api<{ revision: number }>("/api/v1/projects/default/config/publish", { method: "POST", headers: { "idempotency-key": idempotencyKey() } });
      setPublishConfirm(false); await refreshHistory(); report(`Revision ${result.revision} 已發布。裝置仍會自行載入並回報實際 revision。`, "success");
    } catch (error) { report(friendlyError(error), "error"); }
    finally { setBusy(null); }
  }

  async function rollback() {
    if (!rollbackTarget) return;
    setBusy("rollback");
    try {
      const result = await api<{ draftVersion: number }>("/api/v1/projects/default/config/rollback", { method: "POST", body: JSON.stringify({ revision: rollbackTarget.revision, expectedDraftVersion: draftVersion }) });
      const revision = rollbackTarget.revision; setRollbackTarget(null); await loadDraft(); report(`Revision ${revision} 已複製成草稿 v${result.draftVersion}，尚未發布。`, "success");
    } catch (error) { if (error instanceof ApiError && error.status === 412) setConflict(true); report(friendlyError(error), "error"); }
    finally { setBusy(null); }
  }

  const latestRevision = revisions[0]?.revision ?? 0;
  return <div className="config-workspace">
    <section className="page-heading"><div><span className="eyebrow">SESSION CONFIGURATION</span><h1>課程流程設定</h1><p>以表單組合課程內容，儲存為草稿後再發布給裝置。</p></div><div className="revision-summary"><span>已發布</span><strong>Revision {latestRevision || "—"}</strong><small>草稿 v{draftVersion}</small></div></section>
    {conflict && <section className="inline-alert error" role="alert"><div><strong>草稿已被其他操作者更新</strong><p>為避免覆蓋他人的修改，請重新載入最新草稿後再編輯。</p></div><button onClick={() => void loadDraft()}>重新載入</button></section>}
    <div className="config-layout"><div className="config-form">
      <section className="surface form-section"><div className="section-heading"><span className="step-number">01</span><div><h2>基本資訊</h2><p>識別這一輪課程，發布後會成為裝置載入的設定。</p></div></div><div className="field-grid two"><label className="field"><span>Session ID</span><input value={config.sessionId} onChange={(event) => update({ ...config, sessionId: event.target.value })} placeholder="例如：class-a-morning"/><small>英數開頭，可使用點、底線與連字號。</small></label><label className="field"><span>Content catalog</span><input value="signify-core-1" disabled/><small>目前由 Unity content catalog 固定管理。</small></label></div></section>
      <section className="surface form-section"><div className="section-heading"><span className="step-number">02</span><div><h2>課程流程</h2><p>點選加入或移除，並使用箭頭調整實際執行順序。</p></div></div><div className="flow-builder">{config.flow.length ? config.flow.map((section, index) => <div className="flow-step" key={section}><span className="flow-index">{String(index + 1).padStart(2, "0")}</span><strong>{labelFor(sectionOptions, section)}</strong><code>{section}</code><span className="flow-controls"><button className="icon-button" aria-label={`將 ${section} 往前`} disabled={index === 0} onClick={() => moveFlow(index, -1)}>↑</button><button className="icon-button" aria-label={`將 ${section} 往後`} disabled={index === config.flow.length - 1} onClick={() => moveFlow(index, 1)}>↓</button><button className="icon-button remove" aria-label={`移除 ${section}`} onClick={() => toggleFlow(section)}>×</button></span></div>) : <div className="empty-inline">尚未選擇任何 section</div>}</div><div className="choice-row">{sectionOptions.filter(([id]) => !config.flow.includes(id)).map(([id, label]) => <button className="choice add" key={id} onClick={() => toggleFlow(id)}>＋ {label}</button>)}</div></section>
      <section className="surface form-section"><div className="section-heading"><span className="step-number">03</span><div><h2>學習內容</h2><p>所有選項都來自已確認的 content catalog，不會傳送 Scene 名稱或 Unity reference。</p></div></div>
        <div className="subsection"><div className="subsection-title"><div><h3>Learn opening</h3><p>開場示範使用的詞彙</p></div><span className="count-pill">1 個詞彙</span></div><label className="field compact"><span>開場詞彙</span><select value={config.content.learnOpening.wordId} onChange={(event) => patchContent("learnOpening", { wordId: event.target.value as WordId })}>{wordOptions.map(([id, label]) => <option key={id} value={id}>{label} · {id}</option>)}</select></label></div>
        <div className="subsection"><div className="subsection-title"><div><h3>Learn word 拼圖</h3><p>固定九個拼圖槽位；詞彙可以重複，排列順序就是教學順序</p></div><span className={`count-pill ${config.content.learnWord.words.length !== 9 ? "warning" : ""}`}>{config.content.learnWord.words.length}/9 個槽位</span></div><div className="puzzle-grid">{config.content.learnWord.words.map((word, index) => <label className="puzzle-field" key={word.puzzleNumber}><span>拼圖 {word.puzzleNumber}</span><select value={word.wordId} onChange={(event) => setPuzzleWord(index, event.target.value as WordId)}>{wordOptions.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>)}</div></div>
        <div className="content-columns"><div className="subsection"><div className="subsection-title"><div><h3>Learn text</h3><p>選擇 1–4 段文本</p></div><span className="count-pill">{config.content.learnText.textIds.length}/4</span></div><div className="choice-row">{textOptions.map(([id, label]) => <button key={id} className={`choice ${config.content.learnText.textIds.includes(id) ? "selected" : ""}`} aria-pressed={config.content.learnText.textIds.includes(id)} onClick={() => toggleText(id)}>{label}</button>)}</div></div><div className="subsection"><div className="subsection-title"><div><h3>Gaming</h3><p>選擇遊戲會出現的詞彙</p></div><span className="count-pill">{config.content.gaming.wordIds.length}/9</span></div><div className="choice-row">{wordOptions.map(([id, label]) => <button key={id} className={`choice ${config.content.gaming.wordIds.includes(id) ? "selected" : ""}`} aria-pressed={config.content.gaming.wordIds.includes(id)} onClick={() => toggleGameWord(id)}>{label}</button>)}</div></div></div>
      </section>
      <section className="surface action-bar"><div className="save-state"><span className={`state-dot ${dirty ? "warning" : validated ? "success" : ""}`}/><div><strong>{dirty ? "有尚未儲存的修改" : validated ? "草稿已儲存並通過驗證" : "草稿已載入"}</strong><small>{issues.length ? `${issues.length} 個問題待修正` : `Draft v${draftVersion}`}</small></div></div><div className="action-group"><button className="secondary" disabled={Boolean(busy)} onClick={() => void validate()}>{busy === "validate" ? "驗證中…" : "先驗證"}</button><button disabled={Boolean(busy) || !dirty} onClick={() => void save()}>{busy === "save" ? "儲存中…" : "儲存草稿"}</button><button className="danger" disabled={Boolean(busy) || dirty || !validated || draftVersion === 0} onClick={() => setPublishConfirm(true)}>發布 revision</button></div></section>
    </div>
    <aside className="revision-rail surface"><div className="section-heading compact"><div><span className="eyebrow">REVISION HISTORY</span><h2>發布紀錄</h2></div><button className="icon-button" aria-label="重新整理發布紀錄" onClick={() => void refreshHistory()}>↻</button></div>{loading ? <div className="skeleton-list"><i/><i/><i/></div> : revisions.length ? <div className="revision-list">{revisions.map((revision, index) => <article className="revision-card" key={revision.revision}><div><span className={index === 0 ? "status-badge success" : "status-badge"}>{index === 0 ? "目前發布" : "歷史版本"}</span><strong>Revision {revision.revision}</strong><small>{formatTime(revision.publishedAt)}</small></div><button className="secondary small" disabled={Boolean(busy)} onClick={() => setRollbackTarget(revision)}>建立 rollback 草稿</button></article>)}</div> : <div className="empty-state compact"><span>◇</span><strong>尚無發布紀錄</strong><p>先儲存並發布第一份設定。</p></div>}<div className="rail-note"><strong>安全發布原則</strong><p>Rollback 只會建立新草稿；舊 revision 永遠不會被改寫。</p></div></aside></div>
    {issues.length > 0 && <section className="issue-drawer" aria-live="polite"><strong>發布前需要處理</strong>{issues.map((issue) => <span key={issue}>• {issue}</span>)}</section>}
    {publishConfirm && <div className="modal" role="dialog" aria-modal="true" aria-labelledby="publish-title"><div className="modal-card"><span className="modal-icon warning">↑</span><h2 id="publish-title">發布草稿 v{draftVersion}？</h2><p>發布後會建立新的不可變 revision。裝置是否已套用，仍以 device-reported config revision 為準。</p><div className="modal-actions"><button className="secondary" onClick={() => setPublishConfirm(false)}>返回檢查</button><button className="danger" disabled={busy === "publish"} onClick={() => void publish()}>{busy === "publish" ? "發布中…" : "確認發布"}</button></div></div></div>}
    {rollbackTarget && <div className="modal" role="dialog" aria-modal="true" aria-labelledby="rollback-title"><div className="modal-card"><span className="modal-icon">↶</span><h2 id="rollback-title">從 Revision {rollbackTarget.revision} 建立草稿？</h2><p>目前草稿會被這個歷史版本取代，但不會立即發布到裝置。</p><div className="modal-actions"><button className="secondary" onClick={() => setRollbackTarget(null)}>取消</button><button disabled={busy === "rollback"} onClick={() => void rollback()}>{busy === "rollback" ? "建立中…" : "建立 rollback 草稿"}</button></div></div></div>}
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
