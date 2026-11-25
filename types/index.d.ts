/** 按「產生 commit 訊息」時用的工具：Claude Haiku，或本機的 Cursor CLI（cursor-agent） */
export type Generator = 'haiku' | 'cursor'

/** 等待按下 Commit 的訊息；source 標示是 Claude 回覆附上的，還是按「產生」後由產生器寫的（by 為哪個產生器） */
export type Pending = { message: string; source?: 'claude' | 'model'; by?: Generator }

/** 回合結束時的未提交變更：本 session 改過的檔案與其他變更，皆為相對 repo 根目錄的路徑 */
export type Changes = { session: string[]; others: string[] }

export type Busy = 'commit' | 'generate' | null

/** session 開始時偵測 cursor-agent 的結果：argv 為啟動它的指令（含參數），找不到時為 null */
export type CursorProbe = { argv: string[] | null }

declare module 'claude-code' {
  interface PluginState {
    'commit-button': {
      pending: Pending | null
      busy: Busy
      /** 本 session 改過的檔案（絕對路徑，`/` 分隔） */
      touched: string[]
      /** 主回合開始時已存在的未提交變更（相對路徑），用來找出 Bash 等方式改到的檔案 */
      baseline: string[] | null
      changes: Changes | null
      /** cursor-agent 偵測結果；null 表示還沒偵測 */
      cursor: CursorProbe | null
    }
  }
}
