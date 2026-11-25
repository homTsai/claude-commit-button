import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Pending } from '../types'

/**
 * commit-button：Claude 的回覆含「建議的 commit message」程式碼區塊時，
 * 在提示框上方顯示一列，按「Commit」直接執行 git add -A + git commit。
 * 全程由 mod 在本機執行，不呼叫模型。
 */

const pending = atom({ plugin: 'commit-button', key: 'pending' } as const, null)
const isBusy = atom({ plugin: 'commit-button', key: 'isBusy' } as const, false)

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

const WRAP_UP_TOOL = 'mcp__ccd_turn__wrap_up'

export const COMMIT_POLICY = {
  id: 'commit-button:policy',
  scope: 'session',
  text: [
    '# commit-button mod',
    'The commit-button mod is installed: when your answer contains a suggested commit message in a ``` code block after the words "commit message", the app shows a Commit button above the prompt that runs git add -A and git commit locally.',
    `So when you suggest a commit message, do not ask whether to commit in ${WRAP_UP_TOOL}: no commit question in \`ask\`, and no commit button (\`action: "commit"\` or a reply label about committing) in \`actions\`. Keep the commit message in your closing message as usual. Use \`ask\` only for a different decision the user still has to make; with none, send the recap alone.`,
  ].join('\n'),
} as const

export const register: Register = on => {
  // 有 wrap_up 工具時，請 Claude 不要在下一步提示框重複問 commit（改由本 mod 的按鈕處理）
  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    if (!e.tools.includes(WRAP_UP_TOOL)) return result
    return { sections: [...result.sections.filter(s => s.id !== COMMIT_POLICY.id), COMMIT_POLICY] }
  })

  // 續接舊對話時，從最近的回覆找回建議訊息
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const recent = await $.session.messages({ last: 6 })
    if (!('deny' in recent)) {
      const lastAssistant = [...recent].reverse().find(m => m.role === 'assistant')
      const message = lastAssistant ? extractCommitMessage(lastAssistant.text) : null
      await update($, pending, () => (message ? { message } : null))
    }
    return started
  })

  // 每次主對話回合結束，以最新回覆決定是否顯示按鈕（沒有建議就收起，避免誤用舊訊息）
  on('turn.complete', async ($, e, next) => {
    if (!e.agentId && !e.isAborted) {
      const message = extractCommitMessage(e.answer)
      await update($, pending, (): Pending | null => (message ? { message } : null))
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, pending)
    if (e.props.hasSurvey || current === null) return next(e)

    const busy = await read($, isBusy)
    const { Box, Button, Text } = $.ui.resolve(e)

    const commit = async () => {
      if (await read($, isBusy)) return
      await update($, isBusy, () => true)
      try {
        const status = await $.process.run(['git', 'status', '--porcelain'])
        if (status.exitCode !== 0) {
          $.ui.toast(`git status 失敗：${firstError(status.stderr, status.stdout)}`)
          return
        }
        if (!status.stdout.trim()) {
          $.ui.toast('沒有變更可以 commit')
          await update($, pending, () => null)
          return
        }
        const add = await $.process.run(['git', 'add', '-A'])
        if (add.exitCode !== 0) {
          $.ui.toast(`git add 失敗：${firstError(add.stderr, add.stdout)}`)
          return
        }
        const result = await $.process.run(['git', 'commit', '-F', '-'], { stdin: `${current.message}\n` })
        if (result.exitCode !== 0) {
          $.ui.toast(`git commit 失敗：${firstError(result.stderr, result.stdout)}`, { timeoutMs: 8000 })
          return
        }
        const head = await $.process.run(['git', 'log', '-1', '--format=%h'])
        $.ui.toast(`已 commit ${head.stdout.trim()}：${firstLine(current.message, 40)}`, { timeoutMs: 6000 })
        await update($, pending, () => null)
      } catch (err) {
        $.ui.toast(`commit 失敗：${err instanceof Error ? err.message : String(err)}`, { timeoutMs: 8000 })
      } finally {
        await update($, isBusy, () => false)
      }
    }

    return (
      <Box>
        <Text dimColor>建議 commit：</Text>
        <Text>{firstLine(current.message)} </Text>
        <Button key="commit" variant="primary" onPress={commit}>
          {busy ? 'Commit 中…' : 'Commit'}
        </Button>
        <Text> </Text>
        <Button key="dismiss" role="dismiss" onPress={() => update($, pending, () => null)}>
          略過
        </Button>
      </Box>
    )
  })
}
