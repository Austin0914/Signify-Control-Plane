import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api, idempotencyKey } from "./api.js";
import { ConfigEditor } from "./ConfigEditor.js";

type View = "operations" | "configuration" | "data";
type Tone = "info" | "success" | "error";
type Device = {
  deviceId: string; ready: boolean; lastSeenAt?: string; revokedAt?: string; snapshot?: {
    sessionId: string; configRevision: number; deviceStateRevision: number; bootPlanState?: string;
    currentSection: { sectionId: string; sectionInstanceId?: string; generation?: number } | null;
    transition: { state: string; target: { sectionId: string } | null } | null;
    learnWord: { phase: string; phaseEpoch: number; phaseTransitioning: boolean } | null;
    activeJudgment: { sectionInstanceId: string; attemptId: string; status: "active" } | null;
  };
};
type TrackedCommand = { commandId: string; status: string; commandType?: string; createdAt?: string };

const sections = [
  ["landing", "Landing"], ["opening", "Opening"], ["learn-opening", "Learn opening"], ["learn-word", "Learn word"],
  ["learn-text", "Learn text"], ["gaming", "Gaming"], ["ending", "Ending"],
] as const;
const terminalStatuses = ["activated", "superseded", "failed", "rejected", "expired", "judged_correct", "judged_wrong"];

export function App({ email, signOut }: { email: string; signOut: (() => void) | undefined }) {
  const [view, setView] = useState<View>("operations");
  const [devices, setDevices] = useState<Device[]>([]);
  const [selected, setSelected] = useState("");
  const [desired, setDesired] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: Tone } | null>(null);
  const [trackedCommand, setTrackedCommand] = useState<TrackedCommand | null>(null);
  const [pairingOpen, setPairingOpen] = useState(false);
  const [pairingDeviceId, setPairingDeviceId] = useState("");
  const [pairing, setPairing] = useState<{ pairingCode: string; expiresAt: number; deviceId: string } | null>(null);
  const [modalBusy, setModalBusy] = useState(false);
  const [endingConfirm, setEndingConfirm] = useState(false);
  const [revokeConfirm, setRevokeConfirm] = useState(false);
  const [exportResult, setExportResult] = useState<{ format: string; itemCount: number; downloadUrl: string; downloadExpiresInSeconds: number } | null>(null);
  const [exportBusy, setExportBusy] = useState<string | null>(null);

  const notify = useCallback((message: string, tone: Tone = "info") => setToast({ message, tone }), []);
  const refresh = useCallback(async (quiet = false) => {
    try {
      const result = await api<{ items: Device[] }>("/api/v1/projects/default/devices");
      setDevices(result.items);
      setSelected((current) => current && result.items.some((item) => item.deviceId === current) ? current : result.items[0]?.deviceId ?? "");
    } catch (error) { if (!quiet) notify(friendlyError(error), "error"); }
  }, [notify]);

  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(true), 3000); return () => clearInterval(timer); }, [refresh]);
  useEffect(() => {
    if (!trackedCommand || terminalStatuses.includes(trackedCommand.status)) return;
    const poll = async () => {
      try {
        const result = await api<TrackedCommand>(`/api/v1/projects/default/commands/${encodeURIComponent(trackedCommand.commandId)}`);
        setTrackedCommand((current) => current?.commandId === trackedCommand.commandId ? { ...current, ...result } : current);
      } catch (error) { notify(friendlyError(error), "error"); }
    };
    void poll(); const timer = window.setInterval(() => void poll(), 2000); return () => clearInterval(timer);
  }, [notify, trackedCommand]);

  const device = devices.find((candidate) => candidate.deviceId === selected);
  const onlineCount = devices.filter((item) => item.ready).length;
  const actual = device?.snapshot?.currentSection?.sectionId ?? null;
  const operatorName = email.split("@")[0] || "operator";

  async function send(commandType: string, payload: unknown) {
    if (!device?.ready || !device.snapshot) return notify("裝置尚未完成 hello + authoritative snapshot，現在不能送指令。", "error");
    try {
      const result = await api<TrackedCommand>("/api/v1/projects/default/commands", {
        method: "POST", headers: { "idempotency-key": idempotencyKey() },
        body: JSON.stringify({ deviceId: device.deviceId, sessionId: device.snapshot.sessionId, configRevision: device.snapshot.configRevision, expectedDeviceStateRevision: device.snapshot.deviceStateRevision, commandType, payload }),
      });
      setTrackedCommand({ ...result, commandType });
      notify("指令已排入佇列；等待 Unity ACK 與 terminal result。", "success");
    } catch (error) { notify(friendlyError(error), "error"); }
  }

  async function navigate() {
    if (!desired) return;
    if (desired === "ending") return setEndingConfirm(true);
    await send("navigate_section", { sectionId: desired });
  }

  function openPairing(deviceId = "") { setPairing(null); setPairingDeviceId(deviceId); setPairingOpen(true); }
  async function createPairing() {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(pairingDeviceId)) return notify("裝置 ID 格式不正確。", "error");
    setModalBusy(true);
    try {
      const result = await api<{ pairingCode: string; expiresAt: number; deviceId: string }>("/api/v1/projects/default/pairing-codes", { method: "POST", body: JSON.stringify({ deviceId: pairingDeviceId }) });
      setPairing(result); notify("一次性配對碼已建立，有效時間五分鐘。", "success");
    } catch (error) { notify(friendlyError(error), "error"); }
    finally { setModalBusy(false); }
  }

  async function revokeDevice() {
    if (!device) return;
    setModalBusy(true);
    try {
      await api(`/api/v1/projects/default/devices/${encodeURIComponent(device.deviceId)}/revoke`, { method: "POST" });
      setRevokeConfirm(false); await refresh(); notify(`${device.deviceId} 的 credential 已撤銷。`, "success");
    } catch (error) { notify(friendlyError(error), "error"); }
    finally { setModalBusy(false); }
  }

  async function createExport(format: "json" | "csv") {
    setExportBusy(format); setExportResult(null);
    try {
      const result = await api<{ format: string; itemCount: number; downloadUrl: string; downloadExpiresInSeconds: number }>("/api/v1/projects/default/research-exports", { method: "POST", body: JSON.stringify({ format }) });
      setExportResult(result); notify(`${format.toUpperCase()} 匯出已產生。`, "success");
    } catch (error) { notify(friendlyError(error), "error"); }
    finally { setExportBusy(null); }
  }

  return <div className="app-shell">
    <aside className="app-sidebar">
      <div className="brand"><span className="brand-mark">S</span><div><strong>Signify</strong><small>課程控制台</small></div></div>
      <nav aria-label="主要導覽">
        <button className={view === "operations" ? "active" : ""} onClick={() => setView("operations")}><span>⌁</span><div>裝置控制</div></button>
        <button className={view === "configuration" ? "active" : ""} onClick={() => setView("configuration")}><span>☷</span><div>課程設定</div></button>
        <button className={view === "data" ? "active" : ""} onClick={() => setView("data")}><span>↓</span><div>資料匯出</div></button>
      </nav>
      <div className="sidebar-health"><span className={`health-dot ${onlineCount ? "online" : ""}`}/><div><strong>{onlineCount ? `${onlineCount} 台裝置在線` : "目前沒有在線裝置"}</strong><small>{devices.length} 台已註冊</small></div></div>
      <div className="sidebar-user"><span>{operatorName.slice(0, 1).toUpperCase()}</span><div><strong>{operatorName}</strong><small title={email}>{email}</small></div><button aria-label="登出" title="登出" onClick={signOut}>↗</button></div>
    </aside>

    <main className="app-main">
      {view === "operations" && <>
        <section className="page-heading operations-heading"><div><span className="eyebrow">即時操作</span><h1>裝置控制</h1><p>先確認裝置目前畫面，再選擇你要前往的課程階段。</p></div><div className="heading-actions"><button className="secondary" onClick={() => void refresh()}>↻ 重新整理</button><button onClick={() => openPairing()}>＋ 配對裝置</button></div></section>
        <section className="demo-status surface"><div><span className={`health-dot ${onlineCount ? "online" : ""}`}/><strong>{onlineCount ? `${onlineCount} 台裝置可操作` : "等待裝置連線"}</strong><span>{devices.length ? `共 ${devices.length} 台已配對` : "尚未配對裝置"}</span></div>{trackedCommand && <div className="latest-action"><span>最近操作</span><strong>{commandLabel(trackedCommand.status)}</strong></div>}</section>
        <div className="operations-grid">
          <section className="surface device-panel"><div className="panel-heading"><div><span className="eyebrow">選擇裝置</span><h2>裝置列表</h2></div><button className="icon-button" aria-label="新增配對" onClick={() => openPairing()}>＋</button></div>
            {devices.length ? <div className="device-list">{devices.map((item) => <button key={item.deviceId} className={`device-row ${selected === item.deviceId ? "selected" : ""}`} onClick={() => { setSelected(item.deviceId); setDesired(null); }}><span className={`device-status ${item.ready ? "online" : ""}`}/><div><strong>{item.deviceId}</strong><small>{item.ready ? "可以操作" : item.revokedAt ? "存取權已撤銷" : "離線或連線中"}</small></div><span>›</span></button>)}</div> : <div className="empty-state"><span>＋</span><strong>尚未配對裝置</strong><p>先建立配對碼，再到 Unity 輸入。</p><button onClick={() => openPairing()}>配對第一台裝置</button></div>}
          </section>
          <div className="device-workspace">
            {!device ? <section className="surface empty-device"><span>⌁</span><h2>選擇一台裝置</h2><p>從左側選取裝置，或先建立新的配對。</p></section> : <>
              <section className="device-title"><div><span className={`device-status large ${device.ready ? "online" : ""}`}/><div><span className="eyebrow">目前裝置</span><h2>{device.deviceId}</h2><p>{device.ready ? `最後同步：${relativeTime(device.lastSeenAt)}` : "裝置目前離線或仍在同步"}</p></div></div><div className="heading-actions"><button className="secondary" onClick={() => openPairing(device.deviceId)}>重新配對</button><button className="text-danger" onClick={() => setRevokeConfirm(true)}>撤銷存取權</button></div></section>
              <div className="truth-intent-grid">
                <section className="surface truth-card"><div className="card-kicker"><span className="truth-mark">✓</span>裝置目前畫面</div><strong className="section-name">{sectionLabel(actual)}</strong><p className="truth-summary">{device.ready ? "這是裝置最後一次回報的實際狀態" : "等待裝置完成同步"}</p><details className="technical-details"><summary>查看技術詳細資料</summary><dl><div><dt>Section instance</dt><dd>{device.snapshot?.currentSection?.sectionInstanceId ?? "—"}</dd></div><div><dt>Device state revision</dt><dd>{device.snapshot?.deviceStateRevision ?? "—"}</dd></div><div><dt>Config revision</dt><dd>{device.snapshot?.configRevision ?? "—"}</dd></div><div><dt>Transition</dt><dd>{device.snapshot?.transition?.state ?? "idle / unknown"}</dd></div><div><dt>Boot plan</dt><dd>{device.snapshot?.bootPlanState ?? "—"}</dd></div></dl></details></section>
                <section className="surface intent-card"><div className="card-kicker"><span className="intent-mark">→</span>前往其他畫面</div><h3>選擇課程階段</h3><div className="section-picker">{sections.map(([id, label]) => <button key={id} className={`${desired === id ? "selected" : ""} ${actual === id ? "actual" : ""}`} disabled={!device.ready} onClick={() => setDesired(id)}><span>{label}</span>{actual === id && <small>目前</small>}</button>)}</div><div className="intent-footer"><p>{desired && desired !== actual ? <>將從 <strong>{sectionLabel(actual)}</strong> 前往 <strong>{sectionLabel(desired)}</strong></> : "選擇目的地後再送出。裝置會自行判斷是否能安全切換。"}</p><button disabled={!device.ready || !desired || desired === actual} onClick={() => void navigate()}>前往此階段</button></div></section>
              </div>
              {trackedCommand && <section className={`command-tracker surface status-${trackedCommand.status}`}><div><span className="pulse-dot"/><div><span className="eyebrow">操作進度</span><strong>{commandLabel(trackedCommand.status)}</strong><details className="inline-details"><summary>技術資訊</summary><small>{trackedCommand.commandType ?? "command"} · {shortId(trackedCommand.commandId)}</small></details></div></div><div className="lifecycle"><span className="done">已送出</span><i/><span className={statusReached(trackedCommand.status, "accepted") ? "done" : ""}>已接收</span><i/><span className={terminalStatuses.includes(trackedCommand.status) ? "done" : ""}>已完成</span></div></section>}
              <div className="control-grid"><section className="surface control-card"><div><span className="control-icon">↻</span><h3>同步與階段</h3><p>要求完整快照，或在 LearnWord 穩定階段前進。</p></div><div className="stack-actions"><button className="secondary" disabled={!device.ready} onClick={() => void send("request_snapshot", {})}>要求完整快照</button><button disabled={!device.snapshot?.learnWord || device.snapshot.learnWord.phaseTransitioning} onClick={() => void send("advance_subsection", { expectedPhase: device.snapshot!.learnWord!.phase, expectedPhaseEpoch: device.snapshot!.learnWord!.phaseEpoch })}>LearnWord 下一階段</button></div></section>
                <section className="surface control-card"><div><span className="control-icon">◎</span><h3>人工判定</h3><p>{device.snapshot?.activeJudgment ? "目前有一筆手勢等待判定" : "尚未出現可以判定的手勢"}</p></div><div className="judgment-actions"><button disabled={!device.snapshot?.activeJudgment} onClick={() => void send("force_judgment", { outcome: "correct" })}>✓ 正確</button><button className="danger" disabled={!device.snapshot?.activeJudgment} onClick={() => void send("force_judgment", { outcome: "wrong" })}>× 錯誤</button></div></section></div>
              <details className="technical-details operations-notes"><summary>操作原則與技術說明</summary><p>畫面永遠以裝置回報為準。指令顯示「已接收」只代表 Unity 收到要求，不代表課程畫面已完成切換；完成後才會更新上方的裝置目前畫面。</p></details>
            </>}
          </div>
        </div>
      </>}

      {view === "configuration" && <ConfigEditor report={notify}/>}

      {view === "data" && <div className="data-workspace"><section className="page-heading"><div><span className="eyebrow">研究資料</span><h1>匯出測試紀錄</h1><p>選擇方便使用的格式，系統會產生安全的短效下載連結。</p></div></section><section className="guardrail"><span>i</span><div><strong>下載連結可使用 15 分鐘</strong><p>匯出內容已移除登入信箱、配對碼與裝置密鑰。</p></div></section><div className="export-grid"><article className="surface export-card"><span className="export-icon">▦</span><h2>試算表格式</h2><p>適合直接用 Excel 或 Numbers 開啟，快速檢視主要欄位。</p><button disabled={Boolean(exportBusy)} onClick={() => void createExport("csv")}>{exportBusy === "csv" ? "產生中…" : "下載 CSV"}</button></article><article className="surface export-card"><span className="export-icon">{`{ }`}</span><h2>完整資料格式</h2><p>保留完整巢狀資料，適合後續程式分析與研究備份。</p><button className="secondary" disabled={Boolean(exportBusy)} onClick={() => void createExport("json")}>{exportBusy === "json" ? "產生中…" : "下載 JSON"}</button></article></div>{exportResult && <section className="surface download-ready"><span className="modal-icon success">✓</span><div><h2>檔案已準備完成</h2><p>{exportResult.itemCount} 筆資料 · {exportResult.format.toUpperCase()} · 連結將於 {Math.round(exportResult.downloadExpiresInSeconds / 60)} 分鐘後失效</p></div><a className="button-link" href={exportResult.downloadUrl} target="_blank" rel="noreferrer">下載檔案 ↗</a></section>}<details className="technical-details data-details"><summary>保存期限與格式詳細資料</summary><p>匯出檔保留 7 天。JSON 會包含 snapshot、command、ACK 與 terminal result；CSV 則將主要欄位扁平化。</p></details></div>}
    </main>

    {toast && <div className={`toast ${toast.tone}`} role="status" aria-live="polite"><span>{toast.tone === "success" ? "✓" : toast.tone === "error" ? "!" : "i"}</span><p>{toast.message}</p><button aria-label="關閉通知" onClick={() => setToast(null)}>×</button></div>}

    {pairingOpen && <div className="modal" role="dialog" aria-modal="true" aria-labelledby="pair-title"><div className="modal-card pairing-card"><span className="modal-icon">⌁</span><h2 id="pair-title">{pairing ? "配對碼已建立" : pairingDeviceId ? "重新配對裝置" : "配對新裝置"}</h2>{pairing ? <><p>回到 Unity 的配對視窗輸入這組代碼。代碼只會顯示這一次。</p><button className="pairing-code" onClick={() => void navigator.clipboard.writeText(pairing.pairingCode)}><code>{pairing.pairingCode}</code><small>點一下複製</small></button><div className="expiry"><span>◷</span>五分鐘內有效 · {pairing.deviceId}</div><div className="modal-actions"><button onClick={() => setPairingOpen(false)}>完成</button></div></> : <><p>替裝置取一個容易辨識的名稱，例如「demo-vision-pro」。</p><label className="field"><span>裝置名稱</span><input autoFocus value={pairingDeviceId} onChange={(event) => setPairingDeviceId(event.target.value)} placeholder="例如：demo-vision-pro"/><small>可使用英數、點、底線與連字號。</small></label><div className="modal-actions"><button className="secondary" onClick={() => setPairingOpen(false)}>取消</button><button disabled={modalBusy || !pairingDeviceId} onClick={() => void createPairing()}>{modalBusy ? "建立中…" : "建立配對碼"}</button></div></>}</div></div>}
    {endingConfirm && <ConfirmModal
      icon="■" title="確定要前往 Ending？"
      description={`這會要求 ${device?.deviceId ?? "裝置"} 結束目前體驗。Unity 仍會自行判斷能否切換。`}
      danger confirmLabel="確認送出" busy={modalBusy} onCancel={() => setEndingConfirm(false)}
      onConfirm={() => { setEndingConfirm(false); void send("navigate_section", { sectionId: "ending" }); }}
    />}
    {revokeConfirm && <ConfirmModal
      icon="!" title="撤銷這台裝置的存取權？"
      description={`${device?.deviceId ?? "此裝置"} 會立即離線，之後必須重新配對才能操作。`}
      danger confirmLabel="確認撤銷" busy={modalBusy} onCancel={() => setRevokeConfirm(false)} onConfirm={() => void revokeDevice()}
    />}
  </div>;
}

function ConfirmModal({ icon, title, description, danger, confirmLabel, busy, onCancel, onConfirm }: { icon: string; title: string; description: string; danger?: boolean; confirmLabel: string; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return <div className="modal" role="dialog" aria-modal="true"><div className="modal-card"><span className={`modal-icon ${danger ? "danger" : ""}`}>{icon}</span><h2>{title}</h2><p>{description}</p><div className="modal-actions"><button className="secondary" onClick={onCancel}>取消</button><button className={danger ? "danger" : ""} disabled={busy} onClick={onConfirm}>{busy ? "處理中…" : confirmLabel}</button></div></div></div>;
}

function friendlyError(error: unknown) {
  if (!(error instanceof ApiError)) return "發生未預期錯誤，請稍後再試。";
  const messages: Record<string, string> = { device_not_ready: "裝置尚未 ready，請等待 snapshot 同步。", stale_device_state: "裝置狀態已更新，請重新整理後再操作。", active_judgment_required: "目前沒有可判定的 active attempt。", stable_learn_word_phase_required: "LearnWord 正在切換階段，請稍後再試。", invalid_device_id: "裝置 ID 格式不正確。" };
  return messages[error.code] ?? `操作失敗（${error.code}）`;
}
function shortId(value: string) { return value.length > 12 ? `${value.slice(0, 8)}…` : value; }
function commandLabel(status: string) { return ({ queued: "已排入佇列", sent: "已送往裝置", accepted: "Unity 已接受，尚未完成", deferred: "Unity 延後處理", activated: "已啟用", superseded: "已被取代", failed: "執行失敗", rejected: "Unity 已拒絕", expired: "指令已過期", judged_correct: "已判定 Correct", judged_wrong: "已判定 Wrong" } as Record<string, string>)[status] ?? status; }
function statusReached(status: string, target: string) { return status === target || ["accepted", "deferred", ...terminalStatuses].includes(status); }
function relativeTime(value?: string) { if (!value) return "尚無同步時間"; const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000)); return seconds < 10 ? "剛剛" : seconds < 60 ? `${seconds} 秒前` : `${Math.floor(seconds / 60)} 分鐘前`; }
function sectionLabel(id: string | null) { return id ? sections.find(([candidate]) => candidate === id)?.[1] ?? id : "尚無資料"; }
