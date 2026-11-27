import { atom, read, update } from 'claude-code'
import type { Hook, Register, RenderChildren, RenderNode } from 'claude-code'

import type { Busy, Changes, CursorProbe, Generator, Pending } from '../types'

/**
 * commit-button：Claude 的回覆含「建議的 commit message」程式碼區塊時，
 * 在提示框上方顯示一列，按「Commit」直接執行 git add + git commit。
 *
 * - 記下本 session 改過的檔案（Edit／Write／NotebookEdit，加上回合前後 git status 的差異），
 *   repo 裡還有其他變更時，可以只提交本 session 的檔案。
 * - Claude 沒附建議訊息、但本 session 有未提交的檔案時，提供「產生 commit 訊息」，
 *   由便宜模型（Haiku）或本機的 Cursor CLI（cursor-agent，auto 模型）依 diff 寫訊息，
 *   可在 band 上或設定（userConfig `messageGenerator`）切換；
 *   git 指令一律由 mod 自己執行，模型只負責寫訊息。
 */

const pending = atom({ plugin: 'commit-button', key: 'pending' } as const, null)
const busy = atom({ plugin: 'commit-button', key: 'busy' } as const, null)
const touched = atom({ plugin: 'commit-button', key: 'touched' } as const, [])
const baseline = atom({ plugin: 'commit-button', key: 'baseline' } as const, null)
const changes = atom({ plugin: 'commit-button', key: 'changes' } as const, null)
const cursor = atom({ plugin: 'commit-button', key: 'cursor' } as const, null)

/** 產生 commit 訊息用的模型（產生器為 haiku 時） */
export const MESSAGE_MODEL = 'haiku'
/** 選擇產生器的 userConfig 欄位 */
const GENERATOR_FIELD = 'messageGenerator'
export const GENERATOR_NAMES: Record<Generator, string> = { haiku: 'Haiku', cursor: 'Cursor' }
/**
 * cursor-agent 的參數：非互動、唯讀（ask 模式）、純文字輸出。
 * 明確指定 --model auto：不帶的話會沿用使用者在 Cursor 裡目前選的模型。
 */
export const CURSOR_ARGS = ['-p', '--mode', 'ask', '--output-format', 'text', '--trust', '--model', 'auto'] as const
const CURSOR_TIMEOUT_MS = 120000
/** 送給模型的 diff 上限（字元） */
const MAX_DIFF_CHARS = 20000

/** 找出「commit message」字樣之後的第一個 ``` 區塊內容；沒有就回 null */
export function extractCommitMessage(text: string): string | null {
  const lower = text.toLowerCase()
  const at = lower.lastIndexOf('commit message')
  if (at < 0) return null
  const open = text.indexOf('```', at)
  if (open < 0) return null
  const bodyStart = text.indexOf('\n', open)
  if (bodyStart < 0) return null
  const close = text.indexOf('```', bodyStart + 1)
  if (close < 0) return null
  const message = text.slice(bodyStart + 1, close).replace(/\s+$/, '').replace(/^\s*\n/, '')
  return message.trim() ? message : null
}

function firstLine(text: string, max = 60): string {
  const line = (text.split('\n')[0] ?? '').trim()
  return line.length > max ? `${line.slice(0, max)}…` : line
}

function firstError(stderr: string, stdout: string): string {
  const text = (stderr || stdout).trim()
  return firstLine(text || '未知錯誤', 120)
}

// ---------- 路徑與 git status ----------

/** 統一成 `/` 分隔、去掉結尾的 `/` */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

/** Windows 路徑（D:/…）不分大小寫，比對時用小寫 */
function pathKey(path: string): string {
  return /^[a-zA-Z]:\//.test(path) ? path.toLowerCase() : path
}

/** 絕對路徑轉成相對 repo 根目錄的路徑；不在 repo 內就回 null */
export function toRepoPath(top: string, absolute: string): string | null {
  const root = normalizePath(top)
  const file = normalizePath(absolute)
  const prefix = `${root}/`
  if (!pathKey(file).startsWith(pathKey(prefix))) return null
  return file.slice(prefix.length)
}

export type StatusEntry = { code: string; path: string; orig?: string }

/** 解析 `git status --porcelain -z` 的輸出；改名／複製會多帶一筆原始路徑 */
export function parseStatus(output: string): StatusEntry[] {
  const parts = output.split('\0')
  const entries: StatusEntry[] = []
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? ''
    if (part.length < 4) continue
    const code = part.slice(0, 2)
    const entry: StatusEntry = { code, path: part.slice(3) }
    if (code[0] === 'R' || code[0] === 'C') entry.orig = parts[++i]
    entries.push(entry)
  }
  return entries
}

/** 依本 session 改過的檔案，把未提交的變更分成兩組 */
export function splitChanges(entries: readonly StatusEntry[], sessionPaths: readonly string[]): Changes {
  const mine = new Set(sessionPaths.map(pathKey))
  const session: string[] = []
  const others: string[] = []
  for (const entry of entries) {
    const paths = entry.orig ? [entry.path, entry.orig] : [entry.path]
    const isMine = paths.some(p => mine.has(pathKey(p)))
    ;(isMine ? session : others).push(...paths)
  }
  return { session, others }
}

const STATUS_ARGV = ['git', 'status', '--porcelain', '-z', '--untracked-files=all']

/** hook 拿到的 `$` */
type Ctx = Parameters<Hook<'turn.complete'>>[0]

type Repo = { top: string; entries: StatusEntry[] }

/** 讀取 repo 根目錄與未提交的變更；不是 git repo 或指令失敗時回錯誤訊息 */
async function inspectRepo($: Ctx): Promise<Repo | { error: string }> {
  const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'])
  if (top.exitCode !== 0) return { error: `git rev-parse 失敗：${firstError(top.stderr, top.stdout)}` }
  const status = await $.process.run(STATUS_ARGV)
  if (status.exitCode !== 0) return { error: `git status 失敗：${firstError(status.stderr, status.stdout)}` }
  return { top: normalizePath(top.stdout.trim()), entries: parseStatus(status.stdout) }
}

async function sessionRepoPaths($: Ctx, top: string): Promise<string[]> {
  const files: string[] = await read($, touched)
  return files.map(f => toRepoPath(top, f)).filter((p): p is string => p !== null)
}

// ---------- 便宜模型寫 commit 訊息 ----------

const MESSAGE_SYSTEM = [
  'You write git commit messages from a diff.',
  'Reply with only the commit message: a subject line of at most 72 characters, then optionally a blank line and a short body of bullet points.',
  'No code fences, no quotes, no explanations, no trailers such as Co-Authored-By.',
  'Match the language and conventions (for example Conventional Commits prefixes) of the recent commit subjects you are given; if none are given, write in English.',
].join('\n')

/** 去掉模型可能多包的 ``` 與前後空白 */
export function cleanModelMessage(text: string): string {
  let body = text.trim()
  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(body)
  if (fenced) body = (fenced[1] ?? '').trim()
  return body
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…（diff 過長，已截斷）` : text
}

export function buildMessagePrompt(input: { recent: string; stat: string; diff: string; untracked: string[] }): string {
  const sections = [
    input.recent.trim() ? `Recent commit subjects:\n${input.recent.trim()}` : 'Recent commit subjects: (none)',
    `Diff stat:\n${input.stat.trim() || '(none)'}`,
    input.untracked.length ? `New untracked files:\n${input.untracked.join('\n')}` : '',
    `Diff:\n${clip(input.diff, MAX_DIFF_CHARS) || '(no textual diff)'}`,
  ]
  return sections.filter(Boolean).join('\n\n')
}

async function generateMessage($: Ctx, generator: Generator, paths: readonly string[], entries: readonly StatusEntry[]): Promise<string | { error: string }> {
  const scope = ['--', ...paths]
  const git = (args: string[]) => $.process.run(['git', '--literal-pathspecs', ...args])
  let diff = await git(['diff', 'HEAD', ...scope])
  let stat = await git(['diff', 'HEAD', '--stat', ...scope])
  if (diff.exitCode !== 0) {
    // 還沒有任何 commit：沒有 HEAD 可比
    diff = await git(['diff', ...scope])
    stat = await git(['diff', '--stat', ...scope])
  }
  const recent = await $.process.run(['git', 'log', '-8', '--format=%s'])
  const wanted = new Set(paths.map(pathKey))
  const untracked = entries.filter(e => e.code === '??' && wanted.has(pathKey(e.path))).map(e => e.path)

  const prompt = buildMessagePrompt({
    recent: recent.exitCode === 0 ? recent.stdout : '',
    stat: stat.exitCode === 0 ? stat.stdout : '',
    diff: diff.exitCode === 0 ? diff.stdout : '',
    untracked,
  })
  if (generator === 'cursor') return askCursor($, prompt)
  const reply = await $.model.complete({ model: MESSAGE_MODEL, system: MESSAGE_SYSTEM, prompt, effort: 'low', maxTokens: 400, timeoutMs: 30000 })
  if (!reply.isAnswered) {
    const why = reply.reason === 'api-error' ? `API 錯誤 ${reply.status ?? ''}`.trim() : reply.reason === 'aborted' ? '逾時或被取消' : '模型沒有回覆內容'
    return { error: `產生 commit 訊息失敗：${why}` }
  }
  const message = cleanModelMessage(reply.text)
  return message ? message : { error: '產生 commit 訊息失敗：模型沒有回覆內容' }
}

/**
 * 啟動 cursor-agent 的 argv（不經 shell）。
 * Windows 上 `where cursor-agent` 找到的是 .cmd，改用同目錄的 .ps1 交給 PowerShell 執行，
 * 參數與 stdin 才能完整傳入；沒有 where.exe（macOS／Linux）就直接執行 cursor-agent。
 */
export function cursorArgv(whereOutput: string | null): string[] | null {
  if (whereOutput === null) return ['cursor-agent', ...CURSOR_ARGS]
  const found = whereOutput.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const cmd = found.find(l => /\.(cmd|bat)$/i.test(l))
  if (cmd) return ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', cmd.replace(/\.(cmd|bat)$/i, '.ps1'), ...CURSOR_ARGS]
  const exe = found[0]
  return exe ? [exe, ...CURSOR_ARGS] : null
}

/**
 * 找出啟動 cursor-agent 的 argv，找不到就回 null。只查有沒有安裝（不連網、不查登入），
 * 先試 Windows 的 where.exe，沒有就試 which；兩者都無法執行時無從判斷，直接用 cursor-agent。
 */
async function probeCursor($: Ctx): Promise<CursorProbe> {
  const where = await $.process.run(['where.exe', 'cursor-agent']).catch(() => null)
  if (where) return { argv: cursorArgv(where.exitCode === 0 ? where.stdout : '') }
  const which = await $.process.run(['which', 'cursor-agent']).catch(() => null)
  if (which) return { argv: cursorArgv(which.exitCode === 0 ? which.stdout : '') }
  return { argv: cursorArgv(null) }
}

/** 偵測並記下結果，給 band 決定要不要顯示 Cursor 相關按鈕 */
async function detectCursor($: Ctx): Promise<CursorProbe> {
  const probe = await probeCursor($)
  await update($, cursor, (): CursorProbe => probe)
  return probe
}

const CURSOR_HINT = '（可執行 cursor-agent login，或改用 Haiku）'

/** 用本機的 Cursor CLI 寫訊息：prompt 從 stdin 傳入（diff 很長時不受命令列長度限制） */
async function askCursor($: Ctx, prompt: string): Promise<string | { error: string }> {
  // 按下產生時重新偵測一次，session 中途才安裝或移除也能反映
  const { argv } = await detectCursor($)
  if (!argv) return { error: '找不到 cursor-agent：請先安裝 Cursor CLI，或改用 Haiku' }
  const input = `${MESSAGE_SYSTEM}\nDo not use any tools or read any files: everything you need is below.\n\n${prompt}\n`
  let result: Awaited<ReturnType<Ctx['process']['run']>>
  try {
    result = await $.process.run(argv, { stdin: input, timeoutMs: CURSOR_TIMEOUT_MS })
  } catch (err) {
    // 無法啟動（沒安裝）或逾時
    return { error: `執行 cursor-agent 失敗：${firstLine(err instanceof Error ? err.message : String(err), 120)}${CURSOR_HINT}` }
  }
  if (result.exitCode !== 0) return { error: `cursor-agent 失敗：${firstError(result.stderr, result.stdout)}${CURSOR_HINT}` }
  const message = cleanModelMessage(result.stdout)
  return message ? message : { error: '產生 commit 訊息失敗：cursor-agent 沒有回覆內容' }
}

/** 把 band 上的切換寫進設定（等同在 /config 改），模組會帶著新的 options 重新載入 */
async function switchGenerator($: Ctx, to: Generator): Promise<string | null> {
  const rows = await $.config.list()
  const row = rows.find(r => /^commit-button(@[^.]*)?\./.test(r.key) && r.key.endsWith(`.${GENERATOR_FIELD}`))
  if (!row) return '找不到 commit-button 的設定欄位'
  const result = await $.config.set({ key: row.key, value: to })
  return 'deny' in result && result.deny ? `無法切換：${String(result.deny)}` : null
}

// ---------- system prompt ----------

const WRAP_UP_TOOL = 'mcp__ccd_turn__wrap_up'

const POLICY_ID = 'commit-button:policy'

const FORMAT_RULES = [
  '# commit-button mod',
  'The commit-button mod is installed: when your final answer contains a suggested commit message in the format below, a Commit button appears above the prompt that runs `git add -A` and `git commit` locally, without another model turn.',
  'When a turn changed files in a git repository and that piece of work is finished (a feature done, a fix verified, a refactor complete), end your final answer with a suggested commit message in exactly this format: a line containing the words "commit message" (for example "Suggested commit message:", or its equivalent in the language you are answering in, keeping the English words "commit message"), followed by a ``` code block that holds only the message itself: no command, no quotes, no attribution trailers. Write it in the language and convention the project or the user prefers.',
  'Skip it when nothing changed, when the work is unfinished or failing, or when you already committed it yourself.',
].join('\n')

const WRAP_UP_RULES = `When you suggest a commit message, do not also ask whether to commit in ${WRAP_UP_TOOL}: no commit question in \`ask\`, and no commit button (\`action: "commit"\` or a reply label about committing) in \`actions\`. Use \`ask\` only for a different decision the user still has to make; with none, send the recap alone.`

/** 依本回合可用的工具組出 system prompt 段落：格式要求一律加，wrap_up 的規則只在有該工具時加 */
export function commitPolicy(tools: readonly string[]) {
  const text = tools.includes(WRAP_UP_TOOL) ? `${FORMAT_RULES}\n${WRAP_UP_RULES}` : FORMAT_RULES
  return { id: POLICY_ID, scope: 'session', text } as const
}

/** 會改檔案、且參數帶有檔案路徑的工具 */
const FILE_TOOLS: Record<string, string> = { Edit: 'file_path', Write: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' }

async function addTouched($: Ctx, paths: readonly string[]) {
  if (!paths.length) return
  await update($, touched, (list: string[]) => {
    const keys = new Set(list.map(pathKey))
    const added = paths.map(normalizePath).filter(p => !keys.has(pathKey(p)))
    return added.length ? [...list, ...added] : list
  })
}

export const register: Register = (on, options) => {
  // 設定改變時模組會重新載入，所以這裡讀一次即可
  const generator: Generator = options[GENERATOR_FIELD] === 'cursor' ? 'cursor' : 'haiku'
  const other: Generator = generator === 'cursor' ? 'haiku' : 'cursor'

  // 請 Claude 以固定格式附上建議的 commit message（不依賴使用者自己的 CLAUDE.md），
  // 並在桌面版不要於下一步提示框重複問 commit
  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    return { sections: [...result.sections.filter(s => s.id !== POLICY_ID), commitPolicy(e.tools)] }
  })

  // 續接舊對話時，從最近的回覆找回建議訊息
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const recent = await $.session.messages({ last: 6 })
    if (!('deny' in recent)) {
      const lastAssistant = [...recent].reverse().find(m => m.role === 'assistant')
      const message = lastAssistant ? extractCommitMessage(lastAssistant.text) : null
      await update($, pending, (): Pending | null => (message ? { message, source: 'claude' } : null))
    }
    // 每個 session（含 mod 重新載入）偵測一次 cursor-agent 是否安裝；失敗不影響 session
    await detectCursor($).catch(() => null)
    return started
  })

  // 記下 Claude（含 subagent）用檔案工具改過的檔案
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    const key = FILE_TOOLS[e.tool]
    const path = key ? (e as unknown as Record<string, unknown>)[key] : undefined
    if (typeof path === 'string' && /^([a-zA-Z]:)?[\\/]/.test(path) && !('deny' in result && result.deny) && !result.isError) {
      await addTouched($, [path])
    }
    return result
  }).catch(($, e, next) => next(e)) // 只是記錄，失敗也不能擋下工具

  // 主回合開始前記下已存在的變更，回合結束時多出來的就算本 session 改的（例如 Bash 改到的檔案）
  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      const status = await $.process.run(STATUS_ARGV).catch(() => null)
      const entries = status && status.exitCode === 0 ? parseStatus(status.stdout) : null
      await update($, baseline, () => (entries ? entries.flatMap(x => (x.orig ? [x.path, x.orig] : [x.path])) : null))
    }
    return next(e)
  })

  // 每次主對話回合結束，以最新回覆決定是否顯示按鈕（沒有建議就收起，避免誤用舊訊息）
  on('turn.complete', async ($, e, next) => {
    if (!e.agentId && !e.isAborted) {
      const message = extractCommitMessage(e.answer)
      await update($, pending, (): Pending | null => (message ? { message, source: 'claude' } : null))

      const repo = await inspectRepo($).catch(() => null)
      if (repo && !('error' in repo)) {
        const before: string[] | null = await read($, baseline)
        if (before) {
          const known = new Set(before.map(pathKey))
          const fresh = repo.entries.flatMap(x => (x.orig ? [x.path, x.orig] : [x.path])).filter(p => !known.has(pathKey(p)))
          await addTouched($, fresh.map(p => `${repo.top}/${p}`))
        }
        const split = splitChanges(repo.entries, await sessionRepoPaths($, repo.top))
        await update($, changes, (): Changes | null => (split.session.length || split.others.length ? split : null))
      } else {
        await update($, changes, () => null)
      }
      await update($, baseline, () => null)
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current: Pending | null = await read($, pending)
    const found: Changes | null = await read($, changes)
    const sessionCount = found?.session.length ?? 0
    const otherCount = found?.others.length ?? 0
    if (e.props.hasSurvey || (current === null && sessionCount === 0)) return next(e)

    const state: Busy = await read($, busy)
    const { Box, Button, Text } = $.ui.resolve(e)

    const dismiss = async () => {
      await update($, pending, () => null)
      await update($, changes, () => null)
    }

    /** onlySession：只提交本 session 的檔案；否則 git add -A 全部提交 */
    const commit = async (onlySession: boolean) => {
      if (await read($, busy)) return
      const message: string | undefined = (await read($, pending))?.message
      if (!message) return
      await update($, busy, (): Busy => 'commit')
      try {
        const repo = await inspectRepo($)
        if ('error' in repo) {
          $.ui.toast(repo.error)
          return
        }
        if (!repo.entries.length) {
          $.ui.toast('沒有變更可以 commit')
          await dismiss()
          return
        }
        let paths: string[] | null = null
        if (onlySession) {
          paths = splitChanges(repo.entries, await sessionRepoPaths($, repo.top)).session
          if (!paths.length) {
            $.ui.toast('本 session 的檔案沒有未提交的變更')
            return
          }
        }
        const scope = paths ? ['--', ...paths] : []
        const add = await $.process.run(paths ? ['git', '--literal-pathspecs', 'add', '-A', ...scope] : ['git', 'add', '-A'])
        if (add.exitCode !== 0) {
          $.ui.toast(`git add 失敗：${firstError(add.stderr, add.stdout)}`)
          return
        }
        // 指定路徑時 git commit 只提交這些檔案，其他已 staged 的變更不會被帶進去
        const result = await $.process.run(paths ? ['git', '--literal-pathspecs', 'commit', '-F', '-', ...scope] : ['git', 'commit', '-F', '-'], { stdin: `${message}\n` })
        if (result.exitCode !== 0) {
          $.ui.toast(`git commit 失敗：${firstError(result.stderr, result.stdout)}`, { timeoutMs: 8000 })
          return
        }
        const head = await $.process.run(['git', 'log', '-1', '--format=%h'])
        $.ui.toast(`已 commit ${head.stdout.trim()}：${firstLine(message, 40)}`, { timeoutMs: 6000 })
        // 已提交的檔案不再算本 session 未提交的變更
        const done = new Set((paths ?? repo.entries.flatMap(x => (x.orig ? [x.path, x.orig] : [x.path]))).map(p => pathKey(`${repo.top}/${p}`)))
        await update($, touched, (list: string[]) => list.filter(f => !done.has(pathKey(f))))
        await dismiss()
      } catch (err) {
        $.ui.toast(`commit 失敗：${err instanceof Error ? err.message : String(err)}`, { timeoutMs: 8000 })
      } finally {
        await update($, busy, (): Busy => null)
      }
    }

    const generate = async () => {
      if (await read($, busy)) return
      await update($, busy, (): Busy => 'generate')
      try {
        const repo = await inspectRepo($)
        if ('error' in repo) {
          $.ui.toast(repo.error)
          return
        }
        const paths = splitChanges(repo.entries, await sessionRepoPaths($, repo.top)).session
        if (!paths.length) {
          $.ui.toast('本 session 的檔案沒有未提交的變更')
          await dismiss()
          return
        }
        const made = await generateMessage($, generator, paths, repo.entries)
        if (typeof made !== 'string') {
          $.ui.toast(made.error, { timeoutMs: 8000 })
          return
        }
        await update($, pending, (): Pending => ({ message: made, source: 'model', by: generator }))
      } catch (err) {
        $.ui.toast(`產生 commit 訊息失敗：${err instanceof Error ? err.message : String(err)}`, { timeoutMs: 8000 })
      } finally {
        await update($, busy, (): Busy => null)
      }
    }

    const toggle = async () => {
      if (await read($, busy)) return
      const error = await switchGenerator($, other).catch((err: unknown) => (err instanceof Error ? err.message : String(err)))
      $.ui.toast(error ?? `之後改用 ${GENERATOR_NAMES[other]} 產生 commit 訊息`)
    }

    const skip = (
      <Button key="dismiss" onPress={dismiss}>
        略過
      </Button>
    )

    /** 文字靠左、按鈕靠右；空間不足時按鈕整組換到第二行，極窄時按鈕列本身也能換行（actions 須傳陣列而非 Fragment，避免被包成 column Box） */
    const row = (info: RenderChildren, actions: RenderChildren) => (
      <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" alignItems="center" columnGap={1} rowGap="sm">
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          {info}
        </Box>
        <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={1} rowGap="xs">
          {actions}
        </Box>
      </Box>
    )

    if (current === null) {
      const probe: CursorProbe | null = await read($, cursor)
      // 還沒偵測完（null）時先當作可用，避免按鈕閃動；確定找不到才改變按鈕
      const isCursorMissing = probe !== null && probe.argv === null
      const summary = `本 session 有 ${sessionCount} 個檔案未 commit${otherCount ? `（另有 ${otherCount} 個其他變更）` : ''}`

      if (generator === 'cursor' && isCursorMissing) {
        return row(
          <Text dimColor>{`${summary}・找不到 cursor-agent`}</Text>,
          [
            <Button key="toggle-generator" variant="primary" onPress={toggle}>
              改用 Haiku
            </Button>,
            skip,
          ],
        )
      }

      const actions: RenderNode[] = [
        <Button key="generate" variant="primary" onPress={generate}>
          {state === 'generate' ? `${GENERATOR_NAMES[generator]} 產生中…` : `用 ${GENERATOR_NAMES[generator]} 產生 commit 訊息`}
        </Button>,
      ]
      // 找不到 cursor-agent 時不提供切到 Cursor
      if (!(other === 'cursor' && isCursorMissing)) {
        actions.push(
          <Button key="toggle-generator" onPress={toggle}>
            {`改用 ${GENERATOR_NAMES[other]}`}
          </Button>,
        )
      }
      actions.push(skip)
      return row(<Text dimColor>{summary}</Text>, actions)
    }

    const label = current.source === 'model' ? `${GENERATOR_NAMES[current.by ?? 'haiku']} 建議 commit：` : '建議 commit：'
    const isMixed = sessionCount > 0 && otherCount > 0
    const committing = state === 'commit'

    const commitActions: RenderNode[] = isMixed
      ? [
          <Button key="commit-session" variant="primary" onPress={() => commit(true)}>
            {committing ? 'Commit 中…' : `只 Commit 本 session（${sessionCount}）`}
          </Button>,
          <Button key="commit" onPress={() => commit(false)}>
            {`全部 Commit（${sessionCount + otherCount}）`}
          </Button>,
          skip,
        ]
      : [
          <Button key="commit" variant="primary" onPress={() => commit(false)}>
            {committing ? 'Commit 中…' : 'Commit'}
          </Button>,
          skip,
        ]

    return row(
      [<Text dimColor>{label}</Text>, <Text>{firstLine(current.message)}</Text>],
      commitActions,
    )
  })
}
