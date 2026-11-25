# commit-button

Claude Code mod：Claude 的回覆裡有「建議的 commit message」時，在輸入框上方顯示一列按鈕，按一下就在本機執行 `git add -A` 和 `git commit`，不經過模型，也不花 token。

## 功能

- **自動附上建議訊息**：mod 會在 system prompt 補一段要求：當回合中修改了 git repository 的檔案、而且工作告一段落時，請 Claude 在回覆結尾附上「commit message」字樣，後面接一個只含訊息本身的 ``` 程式碼區塊。所以不需要在自己的 CLAUDE.md 另外設定，安裝後就能觸發按鈕。訊息語言與格式會跟隨專案或使用者的慣例。這是給模型的指示，Claude 大多數時候會照做，但不保證每次都附上。
- **偵測建議訊息**：每次主對話回合結束時，從回覆中找出「commit message」字樣之後的第一個 ``` 程式碼區塊，把裡面的內容當成 commit message。
- **輸入框上方的按鈕列**：顯示「建議 commit：<第一行> [Commit] [略過]」。
  - **Commit**：依序執行 `git status --porcelain`、`git add -A`、`git commit -F -`，完成後用 toast 顯示新的 commit hash。沒有變更時不會 commit。
  - **略過**：收起這一列。
- **續接對話**：session 開始時，會從最近幾則訊息找回尚未處理的建議訊息。
- **避免重複詢問**：Claude 能使用桌面版的 `wrap_up` 工具時，mod 會在 system prompt 補一段說明，請 Claude 不要在「下一步」提示框再問要不要 commit。這是給模型的指示，大多數時候會遵守，但不保證每次都不問。

## 安裝

在 Claude Code 終端機 session 的輸入框輸入：

```
/plugin install commit-button --marketplace homTsai/claude-commit-button
```

出現 `Add marketplace?` 時回答 `y`，再選擇安裝範圍（建議選 user），安裝完成後立即生效。

或在 shell 執行：

```powershell
claude plugin install commit-button --marketplace homTsai/claude-commit-button
```

在桌面版 app（無法使用 `/plugin`）：點輸入框旁的 **+** → **Plugins** → **Add marketplace**，輸入 `homTsai/claude-commit-button`，再按 **Add plugin**。

### 從本機資料夾載入（開發用）

把這個資料夾放在固定位置，例如 `~/.claude/mods/commit-button`，然後在 `~/.claude/settings.json` 的 `env` 加上：

```json
"CLAUDE_CODE_PLUGIN_DIRS": "C:\\Users\\<你>\\.claude\\mods\\commit-button"
```

有多個 mod 時，用 `;` 分隔多個路徑（macOS／Linux 用 `:`）。設定完成後，要重新啟動 app 或開新 session 才會載入。

## 開發

```powershell
claude plugin validate .
```

```powershell
claude plugin test .
```

主程式在 `hooks/register.tsx`，測試在 `hooks/register.test.tsx`，`$.state` 的型別定義在 `types/index.d.ts`。

## 注意事項

- `git add -A` 會加入工作目錄中**所有**變更（包含未追蹤的檔案），按 Commit 前請先確認沒有不該提交的檔案。
- commit 是在 session 的工作目錄執行。

## 授權

MIT，詳見 [LICENSE](LICENSE)。
