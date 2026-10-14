# 後台「開始遊戲」

狀態：使用者已於 2026-10-15 授權部署；既有 dev 後端已更新，接著發布網頁。最終部署與線上驗收結果記錄於工作區 `plan10-remote-game-start/deployment.md`。Vision Pro App 尚未重新建置。實際 Unity 專案的 7 個檔案已更新；可檢閱的對應差異在 [Unity patch](unity-patches/remote-game-start-2026-10-15.patch)。

## 使用方式與改動範圍

先用原有導航切到「遊戲練習」，再按目前階段卡片上的「開始遊戲」。此按鈕等同遊戲開始泡泡的確認，接著執行現有設定的開場與倒數，不會修改課程草稿或永久開啟自動開始。原本的泡泡操作保留。

- 網頁依裝置回報的 `gaming.phase`、`gaming.canStart` 與 `start_gaming` 能力啟用按鈕；處理中與已開始時停用。舊版裝置顯示需要更新。新一輪 Gaming 不會被上一輪的指令鎖住；失敗、拒絕、過期或被取代後可重試。
- 後端增加 `start_gaming`，payload 必須指定 `sectionInstanceId`。僅接受在線、穩定、等待開始且支援此功能的遊戲，沿用原有狀態版本、冪等鍵及指令帳本機制。
- Unity 透過目前 Gaming execution 的正式開始入口確認原有 trigger，不直接呼叫另一套 Demo 啟動器。相同指令只重播結果；另一筆重複開始或過期 execution 會拒絕。
- ACK 只代表開始請求已接受；真正進入 Gameplay 才回覆 `activated`。開始途中離開遊戲會回覆 `superseded`，並由原有 Quiesce 清理場景與協程。

## 部署前驗證結果

|層級|結果|
|---|---|
|專案檢查|`npm run check` 通過型別、測試與全部模組建置。其後新增真實 Unity wire fixture 的契約測試通過，最終共 80 項：Web 49、契約 9、後端 22。最後的 Web 修改也重新通過 TypeScript／Vite build。|
|基礎設施|`npm run cdk:synth` 成功。唯讀 `cdk diff --no-change-set` 顯示既有 8 個 Lambda 的程式資產／metadata 更新，沒有資料表、權限、網域或其他資源結構變更。尚未 deploy。|
|Unity 編譯與協定|腳本編譯成功，編譯後 Console error 為 0；既有 Plan 06 verifier 加入 3 個新指令解析檢查後執行成功。7 筆真實 Unity hello／snapshot／ACK／replay／terminal 訊息已作為契約測試 fixture。|
|Unity runtime|沿用使用者 Remote `real-demo` revision 8，Editor helper 提供地板／頭部輸入。測試訊息直接經正式 parser、processor、SceneFlow、開始 gate 執行，擷取真實 writer 輸出；**此輪使用本地測試連線，未驗證新版指令通過線上 AWS 傳輸。**|
|狀態與重複|Landing 拒絕開始；舊 execution 拒絕；等待開始可啟動；同 ID 重送只 replay；另一筆重複開始、已在 Gameplay 再開始均拒絕。開始後只有進入 Gameplay 才 activated。|
|中途離開|遊戲已開始可跳回單字；再次進遊戲後，在開始流程中立即切回單字，原開始指令 superseded。最終新單字判斷正常，GamingController／GamingBubble 均為 0，Gaming 場景已卸載，SceneFlow 無 fatal。15 項 runtime assertion 全通過。|
|網頁實際元件|本地真實 App 搭配隔離模擬 API：等待開始可點、快速連按只發一筆、處理／Gameplay 停用、舊版裝置停用、失敗後恢復可重試、重進 Gaming 可操作。瀏覽器 error logs 為 0。此為 UI 測試，不列作 AWS E2E。|
|收尾|Play 停止，helper 關閉、原配對保留且 credential slot 還原。826 個來源／設定檔案比對，只有預期的 7 個 Unity 檔案變動。課程仍為 revision 8，沒有儲存或發布草稿。|

完整證據在工作區 `plan10-remote-game-start/`：原始 Unity 備份／編輯副本、`runtime-wire-messages.json`、`before-start.json`、`started-game.json`、`runtime-final.json`、`assertions.json`、`cleanup.json`、`restoration.json`、`source-check.json`、`cdk-diff.log` 與 UI 截圖。

## 部署順序與待驗收

1. 先部署既有 `SignifyControlPlane-dev` 後端。新版 Unity hello 宣告 `start_gaming`，舊後端的嚴格 enum 不接受；**後端更新前請先不要用新版 Unity 做正式連線測試**。
2. 更新 Amplify `main` 網頁；舊 App 仍可連線，但開始遊戲按鈕會停用。
3. 用已修改的 Unity Editor Play，於線上控制台完成「單字 → 遊戲 → 開始遊戲 → 單字」驗收，檢查 activated 與清理結果。
4. Vision Pro 使用前重新產生 Device build 與 Xcode App。既有真機候選版 RC1 是舊版，尚未包含本功能；本輪不宣稱 visionOS IL2CPP／實機驗證完成。

若需回退，網頁與後端還原前一版本；Unity 可用工作區 `before/` 備份或反向套用 patch 還原這 7 個檔案。新舊版本切換期間，後端應保留支援新 capability 的版本，直到新版 App 全部退出。
