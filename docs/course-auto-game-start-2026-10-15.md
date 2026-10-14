# 課程選項：進入遊戲後自動開始

程式與本地驗證完成，分支 `codex/course-auto-game-start`。沿用使用者已授權的同一個 Demo dev 後端與控制台部署流程；最終結果記錄於工作區 `plan10-course-auto-game-start/deployment.md`。沒有自動修改或發布使用者的 Demo 草稿。

## 行為與相容性

在課程順序的「遊戲練習」列新增「進入遊戲後自動開始」。勾選後儲存、發布，裝置下次載入課程時套用；每次進入 Gaming 都會略過規則頁與開始泡泡，執行原有確認後的開場、倒數與生成泡泡流程。不是跳過整個遊戲階段，也不改變遊戲時間與題庫。

未勾選時維持原流程，仍可用開始泡泡或後台「開始遊戲」。選項為 `content.gaming.autoStart?: boolean`，缺少欄位等同 false；取消勾選時網頁移除此欄位，避免無意為舊課程加入新欄位。選擇／全部選取遊戲詞彙會保留勾選，不會覆蓋設定。

Unity DTO、不可變 snapshot 與反向 DTO 映射都保留此選項，JSON 解析拒絕字串、數字、null。獨立場景沒有 session bootstrap、舊課程沒有此欄位、內建課程預設都維持手動開始。新欄位需要新版 Unity；舊版 App 對勾選後的設定仍可能因嚴格 schema 拒絕，實機使用前需重建 App。

## 驗證

- `npm run check`：全部型別／模組建置通過，共 83 項測試（Web 49、契約 12、後端 22）。最後樣式調整再通過 Web build；CDK synth 成功。
- Unity 編譯成功，新增 7 項設定檢查獨立執行通過：缺省 false、true 進入 snapshot、DTO JSON 往返、顯式 false、拒絕字串／數字／null。
- 真實 ConfigEditor 配隔離模擬 API：初次未勾選、儲存及模擬發布保留 true、重新載入仍勾選、改題庫不丟失勾選、取消勾選儲存後欄位消失且重新載入為關閉；Browser error logs 為 0。
- Editor runtime 沿用 Remote `real-demo` revision 8 及既有地板／頭部 helper。未勾選時實測 RulesGate、180 秒尚未倒數、規則及開始確認都存在；網站手動開始 sequence 31 仍 activated。
- 自動模式只在測試記憶體建立新 immutable snapshot 並令 autoStart=true，未儲存或發布雲端課程。透過正常網站導航 sequence 33 進入 `gaming@g5`，無開始指令即自動 Gameplay，讀取時剩約 174.25 秒；規則 panel 和開始 trigger 的 active count 均為 0。
- 從自動模式遊戲中途返回單字，sequence 34 activated，新 execution `learn-word@g6` 正常建立判斷；Gaming 場景、控制器、泡泡均清理，fatal 為空。14 項 runtime assertion 全通過。
- Play 已停止、helper 關閉、原 credential slot 保留／還原。826 個腳本／設定檔案比對，僅預期的 6 個 Unity 檔案變動；原稿見工作區 `before/`，可審閱差異見 [Unity patch](unity-patches/course-auto-game-start-2026-10-15.patch)。

完整證據位於工作區 `plan10-course-auto-game-start/`，包含模擬 UI 環境、測試 log、manual／automatic runtime JSON、runtime-assertions.json、config-parser-checks.json 與 source-check.json。此輪不宣稱已完成將 true 發布到雲端並由 App 冷啟動下載的端到端驗收；該設定的保存、解析與 runtime 行為分層驗證。

既有 Plan 02 全套 verifier 要求遠端設定為 checked-in 的 disabled 預設，與目前已啟用的 Demo 環境不符；未為測試改動使用者設定，改以新增的 `VerifyGamingAutoStart()` 執行本功能檢查。初次驗證案例曾誤用只接受 revision 0 的 packaged validator，已修正為遠端 DTO JSON 往返；這是測試案例修正。

## 上線與使用

先部署後端支援新可選欄位，再發布控制台；新 Unity Editor 程式已套用。使用者可刷新網頁，在課程順序的遊戲列勾選、儲存並發布，下次 Play 載入後套用。現有 Demo 預設維持未勾選，不會因部署而改變開始方式。

Vision Pro 的既有 RC1 App 尚未包含本功能；需要重新產生 Device build／Xcode App。這次沒有實機定位、觸控或多人驗收。
