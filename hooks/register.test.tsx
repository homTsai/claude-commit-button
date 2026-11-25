import { expect, test } from 'claude-code/testing'

const BAND = { plugin: 'commit-button', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} } } as const

const ANSWER = [
  '完成了。',
  '',
  '建議的 commit message：',
  '',
  '```',
  'feat(agent): Agent 憑證支援重新命名 (DPH-111)',
  '```',
  '',
  '[Context Tip: ...]',
].join('\n')

function turn(answer: string) {
  return { answer, durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' as const }
}

test('回覆含建議訊息時顯示按鈕，按下後 add + commit 並收起', async ($, on) => {
  const calls: Array<{ argv: readonly string[]; stdin?: string }> = []
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('process.run', (_, e) => {
    calls.push({ argv: e.argv, stdin: e.init?.stdin })
    const stdout = e.argv[1] === 'status' ? ' M a.ts\n' : e.argv[1] === 'log' ? 'abc1234\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', () => ({ value: undefined }))

  await $.turn.complete(turn(ANSWER))
  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text', text: /DPH-111/ }))?.text).toContain('feat(agent)')

  await ui.press({ key: 'commit' })
  expect(calls.map(c => c.argv.join(' '))).toEqual(['git status --porcelain', 'git add -A', 'git commit -F -', 'git log -1 --format=%h'])
  expect(calls[2]?.stdin).toBe('feat(agent): Agent 憑證支援重新命名 (DPH-111)\n')
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  await ui.unmount()
})

test('system prompt 一律要求固定格式；有 wrap_up 工具時才加不重複詢問的規則', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
  const base = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['desktop'] as const, outputStyle: null, traits: [] }

  const withTool = await $.prompt.compose({ ...base, tools: ['Bash', 'mcp__ccd_turn__wrap_up'] })
  expect(withTool.sections.map(s => s.id)).toEqual(['intro', 'commit-button:policy'])
  expect(withTool.sections[1]?.scope).toBe('session')
  expect(withTool.sections[1]?.text).toContain('code block that holds only the message')
  expect(withTool.sections[1]?.text).toContain('mcp__ccd_turn__wrap_up')

  const without = await $.prompt.compose({ ...base, tools: ['Bash'] })
  expect(without.sections.map(s => s.id)).toEqual(['intro', 'commit-button:policy'])
  expect(without.sections[1]?.text).toContain('code block that holds only the message')
  expect(without.sections[1]?.text).not.toContain('mcp__ccd_turn__wrap_up')
})

test('英文格式的建議訊息也能顯示按鈕', async ($, on) => {
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.turn.complete(turn('Done.\n\nSuggested commit message:\n\n```\nfix: handle empty input\n```\n'))
  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text', text: /fix: handle empty input/ }))?.text).toContain('fix:')
  await ui.unmount()
})

test('沒有建議訊息的回合不顯示按鈕', async ($, on) => {
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.turn.complete(turn('只是一般回答，沒有 commit。'))
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  await ui.unmount()
})

test('沒有變更時不 commit', async ($, on) => {
  const argvs: string[] = []
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('process.run', (_, e) => {
    argvs.push(e.argv.join(' '))
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', () => ({ value: undefined }))
  await $.turn.complete(turn(ANSWER))
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'commit' })
  expect(argvs).toEqual(['git status --porcelain'])
  await ui.unmount()
})
