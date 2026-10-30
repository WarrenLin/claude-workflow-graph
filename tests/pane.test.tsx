import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'workflow-graph',
  component: 'Pane',
  requestId: 'workflow-graph',
  props: {
    title: 'Workflow',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const SCRIPT = `export const meta = {
  name: 'demo',
  description: 'x',
  phases: [{ title: 'Build' }, { title: 'Verify' }],
}
await agent('a')`

test('畫出 workflow 的節點、狀態與目前工具', async ($, on) => {
  on('command.register', () => ({ value: { command: 'workflow-graph' } }))
  on('clock.now', () => ({ value: 1000 }))
  on('clock.every', () => ({ value: { cancel() {} } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', (_, e) =>
    e.tool === 'Workflow'
      ? { result: { status: 'async_launched', taskId: 't1', runId: 'wf_abc', workflowName: 'demo' } }
      : { result: {} },
  )
  on('agent.spawn', (_, e) => ({ model: 'x', agentId: e.description === 'settings' ? 'ag1' : 'ag2' }))
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Workflow', script: SCRIPT })
  await $.agent.spawn({ prompt: 'p', description: 'settings', workflow: { runId: 'wf_abc', agentIndex: 1 } } as never)
  await $.agent.spawn({ prompt: 'p', description: 'greeter', workflow: { runId: 'wf_abc', agentIndex: 2 } } as never)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'x', agentId: 'ag1', reason: 'answer' } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /phases/ }))?.text).toBe('phases: Build → Verify')
    expect((await ui.find({ type: 'Text', text: /1\/2 done/ }))?.text).toMatch(/running · 1\/2 done · 1 running/)
    expect((await ui.find({ type: 'Text', text: /✓ completed/ }))?.text).toMatch(/✓ completed/)
    expect((await ui.find({ type: 'Text', text: /● running/ }))?.text).toMatch(/● running/)
    await ui.unmount()
  }
})

const JOURNAL = [
  { type: 'launched' },
  { type: 'started', key: 'k1', agentId: 'old1', label: 'preflight', phase: 'Preflight' },
  { type: 'result', key: 'k1', agentId: 'old1', result: { ok: true } },
  { type: 'started', key: 'k2', agentId: 'dead', label: 'fix:A', phase: 'Fix' },
  { type: 'started', key: 'k2', agentId: 'live', label: 'fix:A', phase: 'Fix' },
]
  .map(l => JSON.stringify(l))
  .join('\n')

test('resume：agent 比 Workflow 結果早到也不會被蓋掉，沿用的步驟從 journal 補上', async ($, on) => {
  on('command.register', () => ({ value: { command: 'workflow-graph' } }))
  on('clock.now', () => ({ value: 1000 }))
  on('clock.every', () => ({ value: { cancel() {} } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('fs.read', (_, e) => ({ value: String((e as { path?: string }).path).endsWith('journal.jsonl') ? JOURNAL : '' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'x', agentId: 'live' }))
  on('tool.call', async (_, e) => {
    if (e.tool !== 'Workflow') return { result: {} }
    // 模擬：Workflow 還沒回傳，第一個 live agent 已經啟動。
    await $.agent.spawn({ prompt: 'p', description: 'fix:A', workflow: { runId: 'wf_r', agentIndex: 2 } } as never)

    return { result: { status: 'async_launched', taskId: 't', runId: 'wf_r', workflowName: 'bugfix', transcriptDir: '/x' } }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Workflow', scriptPath: '/x/s.js', resumeFromRunId: 'wf_r' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /done/ }))?.text).toMatch(/1\/2 done · 1 running/)
  expect((await ui.find({ type: 'Text', text: /cached/ }))?.text).toMatch(/✓ completed.*\(cached\)/)
  expect((await ui.find({ type: 'Text', text: /^Fix$/ }))?.text).toBe('Fix')
  await ui.unmount()
})
