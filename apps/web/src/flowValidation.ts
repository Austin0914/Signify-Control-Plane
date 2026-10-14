import { stageLabel } from "./courseStages.js";

// Keep aligned with Unity SessionFlowRouteValidator (canonical-v1).
const canonical = ["opening", "learn-opening", "learn-word", "learn-text", "gaming", "ending"];
export type FlowIssue = { index: number | null; message: string };

export function flowIssue(flow: readonly string[]): FlowIssue | null {
  if (flow.length < 2) return { index: null, message: "課程至少需要「定位與準備」和「課程結束」兩個階段。" };
  if (flow[0] !== "landing") return { index: 0, message: "請把「定位與準備」放在課程的第一個階段。" };
  if (flow[flow.length - 1] !== "ending") return { index: flow.length - 1, message: "請把「課程結束」放在課程的最後一個階段。" };
  const seen: string[] = [];
  for (const [index, section] of flow.entries()) {
    if (section === "landing") {
      if (flow[index - 1] === "landing") return { index, message: `第 ${index + 1} 個「定位與準備」與前一個相鄰，請移除其中一個或在中間加入其他階段。` };
      if (seen.includes("gaming")) return { index, message: `第 ${index + 1} 個「定位與準備」不能放在「遊戲練習」之後，請往前移或移除。` };
      continue;
    }
    const rank = canonical.indexOf(section);
    if (rank < 0) return { index, message: `第 ${index + 1} 個階段無法使用，請移除後重新加入課程階段。` };
    if (seen.includes(section)) return { index, message: `「${stageLabel(section)}」只能出現一次，請移除第 ${index + 1} 個重複的階段。` };
    const earlier = seen.find((previous) => canonical.indexOf(previous) > rank);
    if (earlier) return { index, message: `第 ${index + 1} 個「${stageLabel(section)}」順序不正確，請移到「${stageLabel(earlier)}」之前。` };
    seen.push(section);
  }
  return null;
}
