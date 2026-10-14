# 課程順序錯誤顯示

狀態：本地驗證完成；使用者已於 2026-10-15 授權部署至既有 Amplify `main` 與控制台網域。實際部署結果另記於工作區 `plan10-web-flow-validation/deployment.md`。

## 原因與修正

課程 revision 7 的順序為 `landing → learn-word → gaming → opening → learn-opening → ending`。後端原本的設定驗證會接受，但 Unity `SessionFlowRouteValidator`（`canonical-v1`）拒絕，因此 Unity 改用內建課程，遠端裝置連線未就緒。

前端新增同樣的順序限制：第一個必須是定位與準備，最後必須是課程結束；中間學習階段可省略，但須依課程開場、開場詞彙、單字學習、課文學習、遊戲練習的順序。定位與準備可重複，但不能連續相鄰或出現在遊戲練習之後；其他階段不能重複，未知階段也會擋下。

畫面一次顯示第一個順序問題，包含階段編號與修正位置，例如：

> 第 4 個「課程開場」順序不正確，請移到「單字學習」之前。

錯誤摘要位於編輯區上方，對應階段以紅框和文字標示；切到其他分頁仍保留摘要與「前往課程順序」。每次調整即時重新檢查，問題修正前無法檢查、儲存或發布；發布處另加本地狀態防護。沒有自動重排或修改線上課程。

## 驗證

- `npm run test --workspace @signify/web`：3 個測試檔、49 項測試通過。涵蓋 32 種合法學習階段子集、合法重複定位、revision 7 原始錯誤、缺少起訖、重複／相鄰／逆序／未知階段，以及既有內容驗證。
- `npm run build --workspace @signify/web`：TypeScript 與 Vite 正式建置通過；仍有 bundle 大小提示，沒有建置錯誤。
- `git diff --check` 通過。
- 本地瀏覽器使用真正的 ConfigEditor 與 CSS、隔離模擬 API，載入 revision 7 的內容副本。確認錯誤摘要與階段提示正確、檢查及發布停用、跨頁可返回修正。
- 依提示將課程開場和開場詞彙移到單字學習之前：提示消失、儲存可用；儲存成功後發布可用，確認對話框可完成模擬發布。瀏覽器錯誤紀錄為 0。

證據位於工作區 `plan10-web-flow-validation/`：`invalid-flow.png`、`corrected-flow.png`、`error-preview.png`，以及可重現的 `preview/` 隔離環境。

## 範圍與上線後驗收

只修改前端，不改 Unity、後端、配對或金鑰，也沒有發布課程。此防護需部署新版網頁才會生效；舊網頁或直接 API 呼叫仍可能送入不符合 Unity 規則的流程，後端規則尚未同步。

部署後重新整理控制台，載入現有草稿，確認錯誤位置與修正提示；調整後由操作者儲存並發布。再啟動 Unity Persistent 場景的 Play，確認使用 Remote 設定並維持 Play，於網頁更新裝置狀態驗收連線。既有錯誤 revision 不會因部署網頁而自動修復。
