import { useCallback, useEffect, useState } from "react";
import { api, idempotencyKey } from "./api.js";
import { ConfigEditor } from "./ConfigEditor.js";

type Device = {
  deviceId: string; ready: boolean; lastSeenAt?: string; snapshot?: {
    sessionId: string; configRevision: number; deviceStateRevision: number;
    currentSection: { sectionId: string } | null;
    transition: { state: string; target: { sectionId: string } | null } | null;
    learnWord: { phase: string; phaseEpoch: number; phaseTransitioning: boolean } | null;
    activeJudgment: { sectionInstanceId: string; attemptId: string; status: "active" } | null;
  };
};

const sections = ["landing", "opening", "learn-opening", "learn-word", "learn-text", "gaming", "ending"];

export function App({ email, signOut }: { email: string; signOut: (() => void) | undefined }) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [selected, setSelected] = useState("");
  const [desired, setDesired] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [pairing, setPairing] = useState<{ pairingCode: string; expiresAt: number } | null>(null);
  const [trackedCommand, setTrackedCommand] = useState<{ commandId: string; status: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await api<{ items: Device[] }>("/api/v1/projects/default/devices");
      setDevices(result.items);
      if (!selected && result.items[0]) setSelected(result.items[0].deviceId);
    } catch (error) { setMessage(String(error)); }
  }, [selected]);
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 3000); return () => clearInterval(timer); }, [refresh]);
  useEffect(() => {
    if (!trackedCommand || ["activated", "superseded", "failed", "rejected", "expired", "judged_correct", "judged_wrong"].includes(trackedCommand.status)) return;
    const poll = async () => {
      try {
        const result = await api<{ status: string }>(`/api/v1/projects/default/commands/${encodeURIComponent(trackedCommand.commandId)}`);
        setTrackedCommand((current) => current?.commandId === trackedCommand.commandId ? { ...current, status: result.status } : current);
      } catch (error) { setMessage(String(error)); }
    };
    void poll(); const timer = window.setInterval(() => void poll(), 2000); return () => clearInterval(timer);
  }, [trackedCommand?.commandId, trackedCommand?.status]);
  const device = devices.find((candidate) => candidate.deviceId === selected);
  const actual = device?.snapshot?.currentSection?.sectionId ?? "尚無 authoritative snapshot";

  async function send(commandType: string, payload: unknown) {
    if (!device?.ready || !device.snapshot) return setMessage("裝置未完成 hello + snapshot，不能送指令。");
    setMessage("送出意圖中…");
    const result = await api<{ commandId: string; status: string }>("/api/v1/projects/default/commands", {
      method: "POST", headers: { "idempotency-key": idempotencyKey() },
      body: JSON.stringify({ deviceId: device.deviceId, sessionId: device.snapshot.sessionId, configRevision: device.snapshot.configRevision,
        expectedDeviceStateRevision: device.snapshot.deviceStateRevision, commandType, payload }),
    });
    setTrackedCommand(result);
    setMessage(`已排入 ${result.commandId}；這不代表畫面已切換，等待 terminal result／snapshot。`);
  }

  async function navigate() {
    if (!desired) return;
    if (desired === "ending" && window.prompt(`危險操作：輸入裝置 ID ${selected} 以確認`) !== selected) return setMessage("已取消。");
    await send("navigate_section", { sectionId: desired });
  }

  async function createPairing() {
    const deviceId = window.prompt("輸入新裝置 ID（英數、點、底線或連字號）");
    if (!deviceId) return;
    const result = await api<{ pairingCode: string; expiresAt: number }>("/api/v1/projects/default/pairing-codes", { method: "POST", body: JSON.stringify({ deviceId }) });
    setPairing(result);
  }

  return <main>
    <header><div><span className="eyebrow">SIGNIFY / CONTROL PLANE</span><h1>Session operations</h1></div><div className="operator"><span>{email}</span><button className="ghost" onClick={signOut}>登出</button></div></header>
    <section className="notice"><strong>真實狀態以裝置快照為準。</strong> Accepted／Deferred 只表示 Unity 收到指令，不表示 section 已 Activated。</section>
    <div className="layout">
      <aside><div className="side-title"><h2>裝置</h2><button onClick={() => void createPairing()}>配對</button></div>{devices.map((item) => <button key={item.deviceId} className={`device ${selected === item.deviceId ? "selected" : ""}`} onClick={() => setSelected(item.deviceId)}><span className={item.ready ? "dot online" : "dot"}/><span><b>{item.deviceId}</b><small>{item.ready ? "ready" : "offline / syncing"}</small></span></button>)}</aside>
      <section className="panel">
        <div className="truth"><span className="label">DEVICE-REPORTED TRUTH</span><h2>{actual}</h2><dl><div><dt>Device state revision</dt><dd>{device?.snapshot?.deviceStateRevision ?? "—"}</dd></div><div><dt>Config revision</dt><dd>{device?.snapshot?.configRevision ?? "—"}</dd></div><div><dt>Transition</dt><dd>{device?.snapshot?.transition?.state ?? "idle / unknown"}</dd></div></dl></div>
        <div className="intent"><span className="label">OPERATOR INTENT</span><h2>Navigate section</h2><div className="command"><select value={desired ?? ""} onChange={(event) => setDesired(event.target.value)}><option value="">選擇 section</option>{sections.map((section) => <option key={section}>{section}</option>)}</select><button disabled={!device?.ready || !desired} onClick={() => void navigate()}>送出</button></div><p>{desired && desired !== actual ? `Pending intent: ${desired}（目前仍是 ${actual}）` : "尚無與實際狀態不同的意圖"}</p>
          {trackedCommand && <p className={`status status-${trackedCommand.status}`}><b>{trackedCommand.status}</b> · {trackedCommand.commandId}{["accepted", "deferred"].includes(trackedCommand.status) && "（尚未 Activated）"}</p>}
          <div className="command"><button className="ghost" disabled={!device?.ready} onClick={() => void send("request_snapshot", {})}>要求完整快照</button><button className="ghost" disabled={!device?.snapshot?.learnWord || device.snapshot.learnWord.phaseTransitioning} onClick={() => void send("advance_subsection", { expectedPhase: device!.snapshot!.learnWord!.phase, expectedPhaseEpoch: device!.snapshot!.learnWord!.phaseEpoch })}>LearnWord 下一階段</button></div>
          <hr/><h3>Attempt-scoped judgment</h3>{device?.snapshot?.activeJudgment ? <div className="command"><button onClick={() => void send("force_judgment", { ...device.snapshot!.activeJudgment, outcome: "correct", status: undefined })}>Correct</button><button className="danger" onClick={() => void send("force_judgment", { ...device.snapshot!.activeJudgment, outcome: "wrong", status: undefined })}>Wrong</button></div> : <p>目前沒有 active attempt，操作保持停用。</p>}
        </div>
      </section>
    </div>
    <ConfigEditor report={setMessage} />
    {message && <div className="toast">{message}<button onClick={() => setMessage("")}>×</button></div>}
    {pairing && <div className="modal"><div><h2>一次性配對碼</h2><code>{pairing.pairingCode}</code><p>五分鐘後失效；關閉後控制台不再顯示。</p><button onClick={() => setPairing(null)}>我已保存</button></div></div>}
  </main>;
}
