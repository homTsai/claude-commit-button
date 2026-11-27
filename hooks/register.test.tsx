import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { CURSOR_ARGS, cleanModelMessage, cursorArgv, parseStatus, splitChanges, toRepoPath } from './register'

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

const USAGE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

function turn(answer: string) {
  return { answer, durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' as const }
}

/** 假的 git：依子指令回應，status 的內容可在測試中途改 */
function fakeGit(repo: { status: string }) {
  const calls: Array<{ argv: string; stdin?: string }> = []
  const handler = (_: unknown, e: { argv: readonly string[]; init?: { stdin?: string } }) => {
    calls.push({ argv: e.argv.join(' '), stdin: e.init?.stdin })
    const sub = e.argv.slice(1).find(a => !a.startsWith('-')) ?? ''
    const isOneLog = e.argv.includes('-1')
    const stdout =
      sub === 'rev-parse' ? 'D:/repo\n'
      : sub === 'status' ? repo.status
      : sub === 'log' ? (isOneLog ? 'abc1234\n' : 'feat: 舊的訊息\n')
      : sub === 'diff' ? (e.argv.includes('--stat') ? ' new.ts | 3 +++\n' : 'diff --git a/new.ts b/new.ts\n+hello\n')
      : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  }
  return { calls, handler }
}

test('解析 git status -z：一般、未追蹤、改名', () => {
  expect(parseStatus(' M a.ts\0?? dir/b.ts\0R  new.ts\0old.ts\0')).toEqual([
    { code: ' M', path: 'a.ts' },
    { code: '??', path: 'dir/b.ts' },
    { code: 'R ', path: 'new.ts', orig: 'old.ts' },
  ])
  expect(parseStatus('')).toEqual([])
})

test('Windows 絕對路徑轉成 repo 相對路徑，不分大小寫', () => {
  expect(toRepoPath('D:/repo', 'd:\\Repo\\src\\a.ts')).toBe('src/a.ts')
  expect(toRepoPath('D:/repo', 'D:\\other\\a.ts')).toBeNull()
  expect(toRepoPath('/home/u/repo', '/home/u/repo/a.ts')).toBe('a.ts')
})

test('依本 session 的檔案分組，改名的兩個路徑一起歸類', () => {
  const entries = parseStatus(' M a.ts\0 M b.ts\0R  c2.ts\0c.ts\0')
  expect(splitChanges(entries, ['a.ts', 'c.ts'])).toEqual({ session: ['a.ts', 'c2.ts', 'c.ts'], others: ['b.ts'] })
})

test('去掉模型多包的程式碼區塊', () => {
  expect(cleanModelMessage('```text\nfeat: x\n\n- y\n```')).toBe('feat: x\n\n- y')
  expect(cleanModelMessage('  fix: z \n')).toBe('fix: z')
})

test('回覆含建議訊息時顯示按鈕，按下後 add + commit 並收起', async ($, on) => {
  const git = fakeGit({ status: ' M a.ts\0' })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('process.run', git.handler)
  on('ui.toast', () => ({ value: undefined }))

  await $.turn.complete(turn(ANSWER))
  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text', text: /DPH-111/ }))?.text).toContain('feat(agent)')

  git.calls.length = 0
  await ui.press({ key: 'commit' })
  expect(git.calls.map(c => c.argv)).toEqual([
    'git rev-parse --show-toplevel',
    'git status --porcelain -z --untracked-files=all',
    'git add -A',
    'git commit -F -',
    'git log -1 --format=%h',
  ])
  expect(git.calls[3]?.stdin).toBe('feat(agent): Agent 憑證支援重新命名 (DPH-111)\n')
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
  on('process.run', fakeGit({ status: ' M a.ts\0' }).handler)
  await $.turn.complete(turn('Done.\n\nSuggested commit message:\n\n```\nfix: handle empty input\n```\n'))
  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text', text: /fix: handle empty input/ }))?.text).toContain('fix:')
  await ui.unmount()
})

test('沒有建議訊息、本 session 也沒改檔案時不顯示按鈕', async ($, on) => {
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('process.run', fakeGit({ status: ' M someone-else.ts\0' }).handler)
  await $.turn.complete(turn('只是一般回答，沒有 commit。'))
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  await ui.unmount()
})

test('沒有變更時不 commit', async ($, on) => {
  const git = fakeGit({ status: '' })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('process.run', git.handler)
  on('ui.toast', () => ({ value: undefined }))
  await $.turn.complete(turn(ANSWER))
  const ui = await $.ui.mount(BAND)
  git.calls.length = 0
  await ui.press({ key: 'commit' })
  expect(git.calls.map(c => c.argv)).toEqual(['git rev-parse --show-toplevel', 'git status --porcelain -z --untracked-files=all'])
  await ui.unmount()
})

test('repo 另有其他變更時，可以只提交本 session 用 Edit 改過的檔案', async ($, on) => {
  const git = fakeGit({ status: ' M a.ts\0 M other.ts\0' })
  on('tool.call', () => ({ result: {} as never }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('process.run', git.handler)
  on('ui.toast', () => ({ value: undefined }))

  await $.tool.call({ tool: 'Edit', tool_use_id: 'u1', file_path: 'D:\\repo\\a.ts', old_string: 'x', new_string: 'y' } as never)
  await $.turn.complete(turn(ANSWER))
  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Button', key: 'commit' }))?.text).toContain('全部 Commit（2）')

  git.calls.length = 0
  await ui.press({ key: 'commit-session' })
  const argvs = git.calls.map(c => c.argv)
  expect(argvs).toContain('git --literal-pathspecs add -A -- a.ts')
  expect(argvs).toContain('git --literal-pathspecs commit -F - -- a.ts')
  expect(argvs).not.toContain('git add -A')
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  await ui.unmount()
})

test('沒有建議訊息但本 session 有新變更時，可請 Haiku 產生訊息', async ($, on) => {
  const repo = { status: ' M old.ts\0' }
  const git = fakeGit(repo)
  const asked: Array<{ model: string; prompt: string }> = []
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('process.run', git.handler)
  on('ui.toast', () => ({ value: undefined }))
  on('model.complete', (_, e) => {
    asked.push({ model: e.model, prompt: e.prompt })
    return { value: { isAnswered: true as const, text: '```\nfeat: 新增 new.ts\n```', usage: USAGE } }
  })

  await $.turn.start({ text: '幫我加檔案', turnId: 't' })
  repo.status = ' M old.ts\0?? new.ts\0' // 回合中以 Bash 新增了 new.ts
  await $.turn.complete(turn('好了，已新增。'))

  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text', text: /未 commit/ }))?.text).toContain('1 個檔案')
  await ui.press({ key: 'generate' })

  expect(asked[0]?.model).toBe('haiku')
  expect(asked[0]?.prompt).toContain('new.ts')
  expect(asked[0]?.prompt).toContain('feat: 舊的訊息')
  expect((await ui.find({ type: 'Text', text: /Haiku/ }))?.text).toContain('Haiku')
  expect((await ui.find({ type: 'Text', text: /新增 new\.ts/ }))?.text).toContain('feat:')

  git.calls.length = 0
  await ui.press({ key: 'commit-session' })
  expect(git.calls.map(c => c.argv)).toContain('git --literal-pathspecs commit -F - -- new.ts')
  expect(git.calls.find(c => c.argv.includes('commit'))?.stdin).toBe('feat: 新增 new.ts\n')
  await ui.unmount()
})

test('組出 cursor-agent 的 argv：Windows 的 .cmd 改用同目錄 .ps1，其他平台直接執行', () => {
  const ps1 = 'C:\\Users\\u\\AppData\\Local\\cursor-agent\\cursor-agent.ps1'
  expect(cursorArgv('C:\\Users\\u\\AppData\\Local\\cursor-agent\\cursor-agent.cmd\n')).toEqual([
    'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, ...CURSOR_ARGS,
  ])
  expect(cursorArgv('C:\\tools\\cursor-agent.exe\n')).toEqual(['C:\\tools\\cursor-agent.exe', ...CURSOR_ARGS])
  expect(cursorArgv(null)).toEqual(['cursor-agent', ...CURSOR_ARGS])
  expect(cursorArgv('')).toBeNull()
  // 固定用 auto，不沿用使用者在 Cursor 裡選的模型
  expect(CURSOR_ARGS.slice(CURSOR_ARGS.indexOf('--model'))).toEqual(['--model', 'auto'])
})

test('設定為 cursor 時，用 cursor-agent 產生訊息，prompt 從 stdin 傳入', { options: { messageGenerator: 'cursor' } }, async ($, on) => {
  const repo = { status: ' M old.ts\0' }
  const git = fakeGit(repo)
  const runs: Array<{ argv: readonly string[]; stdin?: string }> = []
  let isModelAsked = false
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('process.run', (_, e: { argv: readonly string[]; init?: { stdin?: string } }) => {
    if (e.argv[0] === 'git') return git.handler(_, e)
    runs.push({ argv: e.argv, stdin: e.init?.stdin })
    const stdout = e.argv[0] === 'where.exe' ? 'C:\\cursor-agent\\cursor-agent.cmd\n' : 'feat: 新增 new.ts\n'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('model.complete', () => {
    isModelAsked = true
    return { value: { isAnswered: true as const, text: 'x', usage: USAGE } }
  })

  await $.turn.start({ text: '幫我加檔案', turnId: 't' })
  repo.status = ' M old.ts\0?? new.ts\0'
  await $.turn.complete(turn('好了，已新增。'))

  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Button', key: 'generate' }))?.text).toContain('Cursor')
  expect((await ui.find({ type: 'Button', key: 'toggle-generator' }))?.text).toContain('改用 Haiku')
  await ui.press({ key: 'generate' })

  expect(isModelAsked).toBe(false)
  const agent = runs.find(r => r.argv[0] === 'powershell.exe')
  expect(agent?.argv).toContain('C:\\cursor-agent\\cursor-agent.ps1')
  expect(agent?.argv.slice(-2)).toEqual(['--model', 'auto'])
  expect(agent?.stdin).toContain('You write git commit messages')
  expect(agent?.stdin).toContain('new.ts')
  expect((await ui.find({ type: 'Text', text: /Cursor 建議/ }))?.text).toContain('Cursor')
  expect((await ui.find({ type: 'Text', text: /新增 new\.ts/ }))?.text).toContain('feat:')
  await ui.unmount()
})

test('cursor-agent 失敗時顯示錯誤、不產生訊息', { options: { messageGenerator: 'cursor' } }, async ($, on) => {
  const repo = { status: ' M old.ts\0' }
  const git = fakeGit(repo)
  const toasts: string[] = []
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('process.run', (_, e: { argv: readonly string[]; init?: { stdin?: string } }) => {
    if (e.argv[0] === 'git') return git.handler(_, e)
    const isWhere = e.argv[0] === 'where.exe'
    return { value: { exitCode: isWhere ? 0 : 1, stdout: isWhere ? 'C:\\c\\cursor-agent.cmd\n' : '', stderr: isWhere ? '' : 'Not logged in', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', (_, e: { text: string }) => {
    toasts.push(e.text)
    return { value: undefined }
  })

  await $.turn.start({ text: 'x', turnId: 't' })
  repo.status = ' M old.ts\0?? new.ts\0'
  await $.turn.complete(turn('好了。'))
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'generate' })
  expect(toasts.some(t => t.includes('cursor-agent 失敗') && t.includes('Not logged in'))).toBe(true)
  expect(await ui.find({ type: 'Button', key: 'commit' })).toBeUndefined()
  await ui.unmount()
})

test('band 上的切換按鈕把設定改成另一個產生器', async ($, on) => {
  const repo = { status: ' M old.ts\0' }
  const sets: Array<{ key: string; value: unknown }> = []
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('process.run', fakeGit(repo).handler)
  on('ui.toast', () => ({ value: undefined }))
  on('config.list', () => ({ value: [{ key: 'theme', label: 'Theme', kind: 'choice', value: 'dark', provider: { plugin: 'engine', tier: 'core' }, isLocked: false }, { key: 'commit-button.messageGenerator', label: '產生 commit 訊息的工具', kind: 'choice', value: 'haiku', options: ['haiku', 'cursor'], provider: { plugin: 'commit-button', tier: 'user' }, isLocked: false }] as never }))
  on('config.set', (_, e) => {
    sets.push({ key: e.key, value: e.value })
    return { value: e.value }
  })

  await $.turn.start({ text: 'x', turnId: 't' })
  repo.status = ' M old.ts\0?? new.ts\0'
  await $.turn.complete(turn('好了。'))
  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Button', key: 'generate' }))?.text).toContain('Haiku')
  await ui.press({ key: 'toggle-generator' })
  expect(sets).toEqual([{ key: 'commit-button.messageGenerator', value: 'cursor' }])
  await ui.unmount()
})

/** 偵測 cursor-agent 的測試：where.exe 依 isInstalled 回應，git 交給 fakeGit */
function probeRun(git: ReturnType<typeof fakeGit>, isInstalled: boolean) {
  const runs: string[] = []
  const handler = (_: unknown, e: { argv: readonly string[]; init?: { stdin?: string } }) => {
    if (e.argv[0] === 'git') return git.handler(_, e)
    runs.push(e.argv.join(' '))
    const isWhere = e.argv[0] === 'where.exe'
    const stdout = isWhere && isInstalled ? 'C:/cursor-agent/cursor-agent.cmd\n' : ''
    return { value: { exitCode: isWhere && !isInstalled ? 1 : 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  }
  return { runs, handler }
}

async function startWithNewFile($: Parameters<TestBody>[0], repo: { status: string }) {
  await $.session.start({ cwd: 'D:/repo', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'x', turnId: 't' })
  repo.status = ' M old.ts\0?? new.ts\0'
  await $.turn.complete(turn('好了。'))
}

test('session 開始時偵測 cursor-agent；沒安裝時不顯示「改用 Cursor」', async ($, on) => {
  const repo = { status: ' M old.ts\0' }
  const run = probeRun(fakeGit(repo), false)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({ value: [] as never }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('process.run', run.handler)

  await startWithNewFile($, repo)
  expect(run.runs).toContain('where.exe cursor-agent')
  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Button', key: 'generate' }))?.text).toContain('Haiku')
  expect(await ui.find({ type: 'Button', key: 'toggle-generator' })).toBeUndefined()
  await ui.unmount()
})

test('已安裝 cursor-agent 時顯示「改用 Cursor」', async ($, on) => {
  const repo = { status: ' M old.ts\0' }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({ value: [] as never }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('process.run', probeRun(fakeGit(repo), true).handler)

  await startWithNewFile($, repo)
  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Button', key: 'toggle-generator' }))?.text).toContain('改用 Cursor')
  await ui.unmount()
})

test('設定為 cursor 但找不到 cursor-agent 時，只提供「改用 Haiku」', { options: { messageGenerator: 'cursor' } }, async ($, on) => {
  const repo = { status: ' M old.ts\0' }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({ value: [] as never }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('process.run', probeRun(fakeGit(repo), false).handler)

  await startWithNewFile($, repo)
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Button', key: 'generate' })).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: 'toggle-generator' }))?.text).toContain('改用 Haiku')
  expect((await ui.find({ type: 'Text', text: /找不到 cursor-agent/ }))?.text).toContain('1 個檔案')
  await ui.unmount()
})

test('按鈕列橫向排列且窄螢幕可自動換行，按鈕直接放在 row Box 內', async ($, on) => {
  const repo = { status: ' M a.ts\0' }
  on('tool.call', () => ({ result: {} as never }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('process.run', fakeGit(repo).handler)

  const assertRowButtons = async (expectedKeys: string[]) => {
    const ui = await $.ui.mount(BAND)
    const root = await ui.drawn()
    expect(root.type).toBe('Box')
    if (root.type !== 'Box') throw new Error('預期根節點為 Box')
    expect(root.props?.flexDirection).toBe('row')
    expect(root.props?.flexWrap).toBe('wrap')
    expect(root.props?.rowGap).toBe('sm')
    const children = root.children ?? []
    expect(children).toHaveLength(2)
    const actionsBox = children[1]
    expect(typeof actionsBox === 'object' && actionsBox !== null && actionsBox.type === 'Box').toBe(true)
    if (typeof actionsBox !== 'object' || actionsBox === null || actionsBox.type !== 'Box') {
      throw new Error('預期右側為 Box')
    }
    expect(actionsBox.props?.flexDirection).toBe('row')
    expect(actionsBox.props?.flexWrap).toBe('wrap')
    expect(actionsBox.props?.rowGap).toBe('xs')
    expect(actionsBox.props?.flexShrink).not.toBe(0)
    const actionChildren = actionsBox.children ?? []
    expect(actionChildren.every(c => typeof c === 'object' && c !== null && c.type === 'Button')).toBe(true)
    expect(actionChildren.map(c => (typeof c === 'object' && c !== null && c.type === 'Button' ? c.props.key : null))).toEqual(expectedKeys)
    await ui.unmount()
  }

  // 1. 無建議訊息（產生按鈕）
  await $.turn.start({ text: '改檔', turnId: 't1' })
  repo.status = ' M a.ts\0?? new.ts\0'
  await $.turn.complete(turn('好了。'))
  await assertRowButtons(['generate', 'toggle-generator', 'dismiss'])

  // 2. 一般建議訊息（單一 Commit 按鈕）
  repo.status = ' M new.ts\0'
  await $.turn.complete(turn(ANSWER))
  await assertRowButtons(['commit', 'dismiss'])

  // 3. 混合變更（isMixed：只 Commit 本 session + 全部 Commit）
  await $.tool.call({ tool: 'Edit', tool_use_id: 'u1', file_path: 'D:\\repo\\a.ts', old_string: 'x', new_string: 'y' } as never)
  repo.status = ' M a.ts\0 M other.ts\0'
  await $.turn.complete(turn(ANSWER))
  await assertRowButtons(['commit-session', 'commit', 'dismiss'])
})
