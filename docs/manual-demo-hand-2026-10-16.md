# 漂浮手手動模式

課程可勾選「漂浮手僅由後台觸發」，套用開場詞彙、單字、課文與遊戲的錯誤提示。勾選時答錯不再自動播放漂浮手；未勾選或舊設定缺少此欄位時，保留原本自動行為。課程內容與遊戲開始選項互相獨立。

## 使用

1. Unity 從目前原始碼重新 Build、由 Xcode 安裝到 Vision Pro。
2. 後台「課程設定 → 課程順序」勾選「漂浮手僅由後台觸發」，儲存並發布。
3. 重新開啟 App 載入新課程設定。
4. 在「裝置控制」或「人工判斷」按「觸發漂浮手」，示範目前辨識中的動作。

只在目前有辨識題目且漂浮手閒置時可觸發。示範不會代替人工正確／錯誤判斷，也不會切換課程。換題、切換場景、播放中或舊 App 不支援時會停用按鈕或拒絕過期請求。取消勾選、儲存發布並重新開啟 App，即恢復原本的自動提示。

## 實作

- Config v1 新增選填 `demoHandManualOnly: boolean`，缺少／false 代表維持自動提示。取消勾選時省略欄位。
- 新命令 `show_demo_hand`，payload 為 `{ sectionInstanceId, attemptId }`。不允許操作員指定其他 SignId、跳過課程或附帶判斷結果。
- 新 capability `show_demo_hand`；snapshot 新增選填 `demoHand: { canShow, isPlaying, manualOnly }`，保留舊裝置相容性。
- API 與 Unity 都驗證目前辨識實例；Unity 另外驗證 Session、場景世代與播放狀態。同 ID 重送只重播 ACK／result，不重播動作。ACK／activated 表示已開始播放，不表示播放已結束。
- Unity 沿用各階段現有的漂浮手播放函式，只替自動路徑加上課程模式檢查。保留錯誤計數、判斷、進度與遊戲自適應失敗／移除規則。
- Unity 修正共 13 個既有腳本，沒有新增場景、Prefab 或套件；版本差異保存在 `docs/unity-patches/manual-demo-hand-2026-10-16.patch`。

新版設定需由新版 Unity App 讀取。舊 App 的嚴格 JSON 解析器不接受 `demoHandManualOnly`，請先更新 App，再發布含新欄位的課程。

## 驗證

- `npm run check` 通過；新增來源對照 fixture 後 `npm test` 97 個測試通過。
- Unity 編譯通過；Config 缺少／false／true，以及字串／數字／null 型別拒絕檢查通過。
- 本地 Play：四個實際學習／遊戲控制器各收到兩次合成的非 Final 錯誤通知，手動模式下都沒有自動播放；同一辨識題目的手動觸發都成功。
- 單字實測經完整 RemoteSessionCommandProcessor：拒絕舊 attempt、正常啟動、相同 ID 重播與播放中拒絕；辨識 attempt 沒有因此完成或換題。實際 writer 訊息保存為 `packages/contracts/fixtures/unity-demo-hand-results.json` 並由 TS contracts 解析驗證。
- 開場詞彙與課文的測試透過既有 phase service／practice coroutine 進入練習，未重測完整教學開場。遊戲為測試複製 runtime config，將辨識延遲暫改為零，以免測試泡泡過期；沒有改設定資產。
- 關閉手動模式後，既有自動播放入口仍能播放。
- 瀏覽器使用真正 App／ConfigEditor 與隔離本地 API fixture，確認按鈕送出精確 attempt、播放中／舊 App／無題目停用，以及勾選→儲存→模擬發布→重載、取消勾選省略欄位。沒有修改線上 Demo 草稿。
- 本地 Play 完成後已停止，Editor Smoke 關閉、原本設定與憑證欄位還原、遠端模式恢復。

工作區詳細證據位於 `/Users/austin/Documents/ChatGPT/專題/plan10-manual-demo-hand/`。未替使用者執行 App 打包、安裝或真機測試；部署結果另行記錄於該目錄的 README。
