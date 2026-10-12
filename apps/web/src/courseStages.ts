export const courseStages = [
  { id: "landing", label: "定位與準備", name: "Landing", description: "完成空間定位，準備開始" },
  { id: "opening", label: "課程開場", name: "Opening", description: "認識課程與操作方式" },
  { id: "learn-opening", label: "開場詞彙", name: "Learn opening", description: "練習開場示範的詞彙" },
  { id: "learn-word", label: "單字學習", name: "Learn word", description: "練習九個詞彙並完成拼圖" },
  { id: "learn-text", label: "課文學習", name: "Learn text", description: "依序練習課文內容" },
  { id: "gaming", label: "遊戲練習", name: "Gaming", description: "透過遊戲練習手勢" },
  { id: "ending", label: "課程結束", name: "Ending", description: "結束這次課程體驗" },
] as const;

export function stageLabel(id: string | null) {
  return id ? courseStages.find((stage) => stage.id === id)?.label ?? id : "尚無資料";
}

export function phaseLabel(phase?: string) {
  return ({ puzzle_appearance: "拼圖出現", word_learning: "單字練習", final_assembly: "拼圖組合", celebration: "完成慶祝", exit: "離開單字學習", completed: "已完成" } as Record<string, string>)[phase ?? ""] ?? "等待裝置回報";
}
