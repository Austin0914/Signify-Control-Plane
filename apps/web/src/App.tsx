import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, idempotencyKey } from "./api.js";
import { ConfigEditor } from "./ConfigEditor.js";
import { courseStages, stageLabel as sectionLabel, phaseLabel } from "./courseStages.js";
import { pendingCommandIds, updateJudgmentStatus, type JudgmentCommands, type TrackedCommand } from "./commandTracking.js";

type View = "operations" | "judgment" | "configuration" | "data";
type Tone = "info" | "success" | "error";
type Device = {
  deviceId: string; ready: boolean; lastSeenAt?: string; revokedAt?: string; snapshot?: {
    sessionId: string; configRevision: number; configSource?: string; deviceStateRevision: number; bootPlanState?: string;
    currentSection: { sectionId: string; sectionInstanceId?: string; generation?: number } | null;
    transition: { state: string; target: { sectionId: string } | null } | null;
    learnWord: { phase: string; phaseEpoch: number; phaseTransitioning: boolean } | null;
    activeJudgment: { sectionInstanceId: string; attemptId: string; status: "active" } | null;
  };
};
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
  const [restartConfirm, setRestartConfirm] = useState<{ deviceId: string; sectionId: string; instanceId: string | undefined } | null>(null);
  const [revokeConfirm, setRevokeConfirm] = useState(false);
  const [exportResult, setExportResult] = useState<{ format: string; itemCount: number; downloadUrl: string; downloadExpiresInSeconds: number } | null>(null);
  const [exportBusy, setExportBusy] = useState<string | null>(null);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [commandBusy, setCommandBusy] = useState(false);
  const sending = useRef(false);
  const [submittedJudgments, setSubmittedJudgments] = useState<JudgmentCommands>({});
  const pollKey = JSON.stringify(pendingCommandIds(trackedCommand, submittedJudgments));
  const [publishedFlows, setPublishedFlows] = useState<Array<{ revision: number; config: { flow: string[] } }>>([]);

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
    const commandIds: string[] = JSON.parse(pollKey);
    if (!commandIds.length) return;
    let cancelled = false;
    const poll = async () => {
      await Promise.all(commandIds.map(async (commandId) => {
        try {
          const result = await api<TrackedCommand>(`/api/v1/projects/default/commands/${encodeURIComponent(commandId)}`);
          if (cancelled) return;
          setTrackedCommand((current) => current?.commandId === commandId ? { ...current, ...result } : current);
          setSubmittedJudgments((current) => updateJudgmentStatus(current, commandId, result.status));
        } catch (error) { if (!cancelled) notify(friendlyError(error), "error"); }
      }));
    };
    void poll(); const timer = window.setInterval(() => void poll(), 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [notify, pollKey]);

  const device = devices.find((candidate) => candidate.deviceId === selected);
  const onlineCount = devices.filter((item) => item.ready).length;
  const actual = device?.snapshot?.currentSection?.sectionId ?? null;
  const operatorName = email.split("@")[0] || "operator";
  const judgmentKey = device?.snapshot?.activeJudgment ? JSON.stringify([device.deviceId, device.snapshot.sessionId, device.snapshot.activeJudgment.sectionInstanceId, device.snapshot.activeJudgment.attemptId]) : null;
  const judgmentSubmitted = Boolean(judgmentKey && submittedJudgments[judgmentKey]);
  const canJudge = Boolean(device?.ready && judgmentKey && !commandBusy && !judgmentSubmitted);
  const currentCommand = trackedCommand?.deviceId === selected ? trackedCommand : null;
  const configuredFlow = device?.snapshot?.configSource === "remote" ? publishedFlows.find((item) => item.revision === device.snapshot!.configRevision)?.config.flow : undefined;
  const flow = configuredFlow ?? courseStages.map((stage) => stage.id);
  const bootIndex = Number(device?.snapshot?.currentSection?.sectionInstanceId?.match(/#\d+@(\d+)$/)?.[1] ?? -1);
  const currentFlowIndex = configuredFlow && flow[bootIndex] === actual ? bootIndex : flow.filter((id) => id === actual).length === 1 ? flow.indexOf(actual ?? "") : -1;

  useEffect(() => {
    let cancelled = false;
    setPublishedFlows([]);
    if (device?.snapshot?.configSource === "remote" && device.snapshot.configRevision) void api<{ items: typeof publishedFlows }>("/api/v1/projects/default/config/revisions")
      .then((result) => { if (!cancelled) setPublishedFlows(result.items); })
      .catch(() => { /* The standard stage guide remains available when the revision is unavailable. */ });
    return () => { cancelled = true; };
  }, [device?.snapshot?.configRevision, device?.snapshot?.configSource, selected]);

  useEffect(() => { if (!toast || toast.tone === "error") return; const timer = window.setTimeout(() => setToast(null), 4000); return () => clearTimeout(timer); }, [toast]);

  async function send(commandType: string, payload: unknown) {
    if (sending.current) return;
    if (!device?.ready || !device.snapshot) return notify("裝置尚未連線完成，請稍候再操作。", "error");
    if (commandType === "force_judgment" && (!judgmentKey || judgmentSubmitted)) return;
    sending.current = true; setCommandBusy(true);
    try {
      const result = await api<TrackedCommand>("/api/v1/projects/default/commands", {
        method: "POST", headers: { "idempotency-key": idempotencyKey() },
        body: JSON.stringify({ deviceId: device.deviceId, sessionId: device.snapshot.sessionId, configRevision: device.snapshot.configRevision, expectedDeviceStateRevision: device.snapshot.deviceStateRevision, commandType, payload }),
      });
      setTrackedCommand({ ...result, status: result.status ?? "queued", commandType, deviceId: device.deviceId, ...(commandType === "force_judgment" && judgmentKey ? { judgmentKey } : {}) });
      if (commandType === "force_judgment" && judgmentKey) setSubmittedJudgments((current) => ({ ...current, [judgmentKey]: { ...result, status: result.status ?? "queued", commandType, deviceId: device.deviceId, judgmentKey } }));
      if (commandType !== "force_judgment") notify("操作已送出，等待裝置完成。", "success");
    } catch (error) { notify(friendlyError(error), "error"); void refresh(true); }
    finally { sending.current = false; setCommandBusy(false); }
  }

  async function navigate() {
    if (!desired) return;
    if (desired === actual) return setRestartConfirm({ deviceId: selected, sectionId: desired, instanceId: device?.snapshot?.currentSection?.sectionInstanceId });
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
      setRevokeConfirm(false); await refresh(); notify(`${device.deviceId} 的存取權已撤銷。`, "success");
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

  return <div className={`app-shell ${view === "judgment" ? "judgment-mode" : view === "configuration" ? "configuration-mode" : ""}`}>
    <aside className="app-sidebar">
      <div className="brand"><span className="brand-mark">S</span><div><strong>Signify</strong><small>課程控制台</small></div></div>
      <nav aria-label="主要導覽">
        <button className={view === "operations" ? "active" : ""} onClick={() => setView("operations")}><span>⌁</span><div>裝置控制</div></button>
        <button className={view === "judgment" ? "active" : ""} onClick={() => setView("judgment")}><span>◎</span><div>人工判斷</div></button>
        <button className={view === "configuration" ? "active" : ""} onClick={() => setView("configuration")}><span>☷</span><div>課程設定</div></button>
        <button className={view === "data" ? "active" : ""} onClick={() => setView("data")}><span>↓</span><div>資料匯出</div></button>
      </nav>
      <div className="sidebar-health"><span className={`health-dot ${onlineCount ? "online" : ""}`}/><div><strong>{onlineCount ? `${onlineCount} 台裝置在線` : "目前沒有在線裝置"}</strong><small>{devices.length} 台已註冊</small></div></div>
      <div className="sidebar-user"><span>{operatorName.slice(0, 1).toUpperCase()}</span><div><strong>{operatorName}</strong><small title={email}>{email}</small></div><button aria-label="登出" title="登出" onClick={signOut}>↗</button></div>
    </aside>

    <main className="app-main">
      {(view === "operations" || view === "judgment") && <>
        <section className="page-heading operations-heading"><div><h1>{view === "judgment" ? "人工判斷" : "裝置控制"}</h1>{view === "operations" && <p>確認目前課程階段，再選擇要前往的位置。</p>}</div></section>
        <section className="surface connection-panel">
          <button className="connection-toggle" aria-expanded={connectionOpen} aria-controls="connection-content" onClick={() => setConnectionOpen(!connectionOpen)}>
            <span className={`health-dot ${device?.ready ? "online" : ""}`}/><span className="connection-summary"><strong>裝置連線</strong><span>{device ? `${device.deviceId} · ${device.ready ? "已連線" : device.revokedAt ? "已撤銷" : "未連線"}` : "尚未選擇裝置"}</span></span><span className="connection-toggle-label">{connectionOpen ? "收合 −" : "展開 ＋"}</span>
          </button>
          <div id="connection-content" className="connection-content" hidden={!connectionOpen}>
            <div className="connection-toolbar"><p>選擇或配對裝置，完成後可收合此區塊。</p><div className="heading-actions"><button className="secondary" onClick={() => void refresh()}>↻ 更新裝置狀態</button><button onClick={() => openPairing()}>＋ 配對裝置</button></div></div>
            {devices.length ? <div className="device-list">{devices.map((item) => <button key={item.deviceId} aria-pressed={selected === item.deviceId} className={`device-row ${selected === item.deviceId ? "selected" : ""}`} onClick={() => { setSelected(item.deviceId); setDesired(null); }}><span className={`device-status ${item.ready ? "online" : ""}`}/><div><strong>{item.deviceId}</strong><small>{item.ready ? "可以操作" : item.revokedAt ? "存取權已撤銷" : "離線或連線中"}</small></div><span>{selected === item.deviceId ? "✓" : "›"}</span></button>)}</div> : <div className="empty-inline">尚未配對裝置，請先建立配對碼，再到 Unity 輸入。</div>}
            {device && <div className="connection-device-actions"><span>{device.ready ? `最後回報：${relativeTime(device.lastSeenAt)}` : "等待裝置連線"}</span><div className="heading-actions"><button className="secondary" disabled={!device.ready || commandBusy} onClick={() => void send("request_snapshot", {})}>更新目前課程階段</button><button className="secondary" onClick={() => openPairing(device.deviceId)}>重新配對</button><button className="text-danger" onClick={() => setRevokeConfirm(true)}>撤銷存取權</button></div></div>}
          </div>
        </section>
      </>}

      {view === "operations" && <div className="operations-workspace">
        {!device ? <section className="surface empty-device"><span>⌁</span><h2>先選擇一台裝置</h2><p>展開上方的裝置連線區塊，選擇或配對裝置。</p><button onClick={() => setConnectionOpen(true)}>展開裝置連線</button></section> : <>
          <section className="surface current-stage"><div><span className="card-kicker"><span className="truth-mark">●</span>{device.ready ? "目前課程階段" : "最後回報的課程階段"}</span><strong className="section-name">{sectionLabel(actual)}</strong><p>{device.ready ? "依裝置回報更新" : "裝置未連線，這個階段可能已改變"} · {relativeTime(device.lastSeenAt)}</p></div>{device.snapshot?.learnWord && actual === "learn-word" && <div className="learning-progress"><span>單字學習進度</span><strong>{phaseLabel(device.snapshot.learnWord.phase)}</strong><button disabled={!device.ready || commandBusy || device.snapshot.learnWord.phaseTransitioning || ["exit", "completed"].includes(device.snapshot.learnWord.phase)} onClick={() => void send("advance_subsection", { expectedPhase: device.snapshot!.learnWord!.phase, expectedPhaseEpoch: device.snapshot!.learnWord!.phaseEpoch })}>前進到下一步 →</button></div>}</section>
          <section className="surface course-navigation"><div className="navigation-heading"><div><h2>選擇課程階段</h2><p>{configuredFlow ? "這台裝置載入的課程順序，由上往下排列。" : "標準階段導覽，由上往下排列；實際課程以裝置載入的設定為準。"}點選目的地，再送出切換。</p></div><div className="flow-legend"><span><i className="current-dot"/>目前階段</span><span><i className="target-dot"/>選擇目的地</span></div></div>
            <ol className="course-flow">{flow.map((id, index) => { const stage = courseStages.find((item) => item.id === id); return <li key={`${id}-${index}`} className={`${currentFlowIndex === index ? "current" : ""} ${desired === id ? "target" : ""}`}><span className="flow-node">{String(index + 1).padStart(2, "0")}</span><button disabled={!device.ready || commandBusy} aria-pressed={desired === id} onClick={() => setDesired(id)}><span className="stage-copy"><strong>{sectionLabel(id)}</strong><small>{stage?.name} · {stage?.description}</small></span><span className="stage-tags">{currentFlowIndex === index && <span className="stage-current">目前階段</span>}{desired === id && <span className="stage-target">已選擇</span>}</span></button></li>; })}</ol>
            {configuredFlow && courseStages.some((stage) => !flow.includes(stage.id)) && <div className="other-stages"><span>其他可前往的階段</span><div className="choice-row">{courseStages.filter((stage) => !flow.includes(stage.id)).map((stage) => <button key={stage.id} className={`choice ${desired === stage.id ? "selected" : ""}`} aria-pressed={desired === stage.id} disabled={!device.ready || commandBusy} onClick={() => setDesired(stage.id)}>{stage.label}{actual === stage.id ? "（目前）" : ""}</button>)}</div></div>}
            <div className="intent-footer"><p>{desired === actual && desired ? "將重新開始這個階段，並重設目前進度。" : desired ? <>從 <strong>{sectionLabel(actual)}</strong> 前往 <strong>{sectionLabel(desired)}</strong></> : "尚未選擇目的地"}</p><button disabled={!device.ready || commandBusy || !desired} onClick={() => void navigate()}>{desired === actual && desired ? "重新開始" : "前往"}{desired ? `「${sectionLabel(desired)}」` : "此階段"} →</button></div>
          </section>
          {currentCommand && <section className={`command-tracker surface status-${currentCommand.status}`} aria-live="polite"><span>最近操作</span><strong>{commandLabel(currentCommand.status)}</strong></section>}
        </>}
      </div>}

      {view === "judgment" && <section className="judgment-workspace" aria-label="手勢人工判斷">
        <div className="judgment-status" role="status"><span className={`health-dot ${canJudge ? "online" : ""}`}/><div><strong>{!device ? "請先選擇裝置" : !device.ready ? "等待裝置連線" : commandBusy ? "正在送出判斷…" : judgmentSubmitted ? "已送出，等待下一筆手勢" : judgmentKey ? "這筆手勢可以判斷" : "等待下一筆手勢"}</strong><span>{device ? `${device.deviceId} · ${sectionLabel(actual)}` : "展開上方裝置連線，選擇要操作的裝置"}</span></div>{currentCommand?.commandType === "force_judgment" && <span className="judgment-result">{commandLabel(currentCommand.status)}</span>}</div>
        <div className="large-judgment-actions"><button className="judgment-correct" disabled={!canJudge} onClick={() => void send("force_judgment", { outcome: "correct" })}><span aria-hidden="true">✓</span><strong>正確</strong></button><button className="judgment-wrong" disabled={!canJudge} onClick={() => void send("force_judgment", { outcome: "wrong" })}><span aria-hidden="true">×</span><strong>錯誤</strong></button></div>
      </section>}

      {view === "configuration" && <ConfigEditor report={notify}/>}

      {view === "data" && <div className="data-workspace"><section className="page-heading"><div><span className="eyebrow">研究資料</span><h1>匯出測試紀錄</h1><p>選擇方便使用的格式，系統會產生安全的短效下載連結。</p></div></section><section className="guardrail"><span>i</span><div><strong>下載連結可使用 15 分鐘</strong><p>匯出內容已移除登入信箱、配對碼與裝置密鑰。</p></div></section><div className="export-grid"><article className="surface export-card"><span className="export-icon">▦</span><h2>試算表格式</h2><p>適合直接用 Excel 或 Numbers 開啟，快速檢視主要欄位。</p><button disabled={Boolean(exportBusy)} onClick={() => void createExport("csv")}>{exportBusy === "csv" ? "產生中…" : "下載 CSV"}</button></article><article className="surface export-card"><span className="export-icon">{`{ }`}</span><h2>完整資料格式</h2><p>保留完整巢狀資料，適合後續程式分析與研究備份。</p><button className="secondary" disabled={Boolean(exportBusy)} onClick={() => void createExport("json")}>{exportBusy === "json" ? "產生中…" : "下載 JSON"}</button></article></div>{exportResult && <section className="surface download-ready"><span className="modal-icon success">✓</span><div><h2>檔案已準備完成</h2><p>{exportResult.itemCount} 筆資料 · {exportResult.format.toUpperCase()} · 連結將於 {Math.round(exportResult.downloadExpiresInSeconds / 60)} 分鐘後失效</p></div><a className="button-link" href={exportResult.downloadUrl} target="_blank" rel="noreferrer">下載檔案 ↗</a></section>}<details className="technical-details data-details"><summary>保存期限與格式詳細資料</summary><p>匯出檔保留 7 天。JSON 會包含 snapshot、command、ACK 與 terminal result；CSV 則將主要欄位扁平化。</p></details></div>}
    </main>

    {toast && <div className={`toast ${toast.tone}`} role="status" aria-live="polite"><span>{toast.tone === "success" ? "✓" : toast.tone === "error" ? "!" : "i"}</span><p>{toast.message}</p><button aria-label="關閉通知" onClick={() => setToast(null)}>×</button></div>}

    {pairingOpen && <div className="modal" role="dialog" aria-modal="true" aria-labelledby="pair-title"><div className="modal-card pairing-card"><span className="modal-icon">⌁</span><h2 id="pair-title">{pairing ? "配對碼已建立" : pairingDeviceId ? "重新配對裝置" : "配對新裝置"}</h2>{pairing ? <><p>回到 Unity 的配對視窗輸入這組代碼。代碼只會顯示這一次。</p><button className="pairing-code" onClick={() => void navigator.clipboard.writeText(pairing.pairingCode)}><code>{pairing.pairingCode}</code><small>點一下複製</small></button><div className="expiry"><span>◷</span>五分鐘內有效 · {pairing.deviceId}</div><div className="modal-actions"><button onClick={() => setPairingOpen(false)}>完成</button></div></> : <><p>替裝置取一個容易辨識的名稱，例如「demo-vision-pro」。</p><label className="field"><span>裝置名稱</span><input autoFocus value={pairingDeviceId} onChange={(event) => setPairingDeviceId(event.target.value)} placeholder="例如：demo-vision-pro"/><small>可使用英數、點、底線與連字號。</small></label><div className="modal-actions"><button className="secondary" onClick={() => setPairingOpen(false)}>取消</button><button disabled={modalBusy || !pairingDeviceId} onClick={() => void createPairing()}>{modalBusy ? "建立中…" : "建立配對碼"}</button></div></>}</div></div>}
    {endingConfirm && <ConfirmModal
      icon="■" title="確定要結束課程？"
      description={`這會要求 ${device?.deviceId ?? "裝置"} 結束目前體驗。裝置會在安全切換後結束課程。`}
      danger confirmLabel="確認送出" busy={modalBusy} onCancel={() => setEndingConfirm(false)}
      onConfirm={() => { setEndingConfirm(false); void send("navigate_section", { sectionId: "ending" }); }}
    />}
    {restartConfirm && <ConfirmModal
      icon="↻" title={`重新開始「${sectionLabel(restartConfirm.sectionId)}」？`}
      description="目前階段的學習進度會重設，裝置會安全離開後重新開始。"
      confirmLabel="確認重新開始" busy={commandBusy} onCancel={() => setRestartConfirm(null)}
      onConfirm={() => {
        const target = restartConfirm; setRestartConfirm(null);
        if (selected !== target.deviceId || actual !== target.sectionId || device?.snapshot?.currentSection?.sectionInstanceId !== target.instanceId)
          return notify("目前階段已變更，請重新選擇後再操作。", "error");
        void send("navigate_section", { sectionId: target.sectionId });
      }}
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
  const messages: Record<string, string> = { device_not_ready: "裝置尚未連線完成，請稍候再操作。", stale_device_state: "裝置狀態已更新，請重新整理後再操作。", active_judgment_required: "目前沒有可判斷的手勢，請等待下一筆。", stable_learn_word_phase_required: "單字學習正在切換步驟，請稍後再試。", device_state_changed: "裝置狀態已改變，正在更新，請稍後再操作。", invalid_device_id: "裝置 ID 格式不正確。" };
  return messages[error.code] ?? `操作失敗（${error.code}）`;
}
function commandLabel(status: string) { return ({ queued: "已排入佇列", sent: "已送往裝置", accepted: "裝置已接收，處理中", deferred: "等待目前階段完成", activated: "已啟用", superseded: "已被取代", failed: "執行失敗", rejected: "裝置未接受操作", expired: "指令已過期", judged_correct: "已判斷為正確", judged_wrong: "已判斷為錯誤" } as Record<string, string>)[status] ?? status; }
function relativeTime(value?: string) { if (!value) return "尚無同步時間"; const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000)); return seconds < 10 ? "剛剛" : seconds < 60 ? `${seconds} 秒前` : `${Math.floor(seconds / 60)} 分鐘前`; }
