import { atom, read, update } from 'claude-code'
import type { Register, StateDollar } from 'claude-code'

import type { WfNode, WfRun } from '../types'

const PANE = 'workflow-graph'
const TITLE = 'Workflow'
// 欄位改了就換 tag，舊版存下來的值才不會被新程式誤讀。
const runs = atom({ plugin: 'workflow-graph', key: 'runs' } as const, [], {
  shape: 'runs-2',
})
const now = atom({ plugin: 'workflow-graph', key: 'now' } as const, 0)

// 同一批平行啟動的 agent 間隔很短；超過這個毫秒數就算下一層。
const SAME_ROW_MS = 1500

function parseMeta(script: unknown): { name?: string; phases: string[] } {
  if (typeof script !== 'string') return { phases: [] }
  const meta = script.match(/export\s+const\s+meta\s*=\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
  const name = meta.match(/name\s*:\s*['"`]([^'"`]+)['"`]/)?.[1]
  const phaseBlock = meta.match(/phases\s*:\s*\[([\s\S]*?)\]/)?.[1] ?? ''
  const phases = [...phaseBlock.matchAll(/title\s*:\s*['"`]([^'"`]+)['"`]/g)].map(m => m[1] ?? '')

  return { name, phases }
}

function formatMs(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`

  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

type Row = { phase?: string; nodes: WfNode[] }

type JournalLine = { type?: string; key?: string; agentId?: string; label?: string; phase?: string; result?: unknown }

// 讀 journal.jsonl，把 label、phase、resume 沿用的步驟補進 run。
function mergeJournal(run: WfRun, text: string, at: number): WfRun {
  const lines: JournalLine[] = []
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue
    try {
      lines.push(JSON.parse(raw) as JournalLine)
    } catch {}
  }
  const latestByKey = new Map<string, string>()
  const results = new Map<string, unknown>()
  for (const l of lines) {
    if (l.type === 'started' && l.key && l.agentId) latestByKey.set(l.key, l.agentId)
    if (l.type === 'result' && l.agentId) results.set(l.agentId, l.result)
  }
  // 同一個 agent() 被重跑時，舊的那個 agentId 作廢。
  const superseded = new Set<string>()
  for (const l of lines) {
    if (l.type === 'started' && l.key && l.agentId && latestByKey.get(l.key) !== l.agentId) superseded.add(l.agentId)
  }
  const nodes = run.nodes.filter(n => !superseded.has(n.agentId))
  let index = 0
  for (const l of lines) {
    if (l.type !== 'started' || !l.agentId || superseded.has(l.agentId)) continue
    index += 1
    const agentId = l.agentId
    const found = nodes.findIndex(n => n.agentId === agentId)
    const base: WfNode =
      found >= 0
        ? nodes[found]!
        : { agentId, index, label: l.label ?? `agent #${index}`, status: 'running', startedAt: at, isCached: true }
    let node: WfNode = { ...base, label: l.label ?? base.label, phase: l.phase ?? base.phase, key: l.key }
    if (results.has(agentId) && node.status === 'running') {
      node = { ...node, status: results.get(agentId) === null ? 'failed' : 'completed', endedAt: node.endedAt ?? at, tool: undefined }
    }
    if (found >= 0) nodes[found] = node
    else nodes.push(node)
  }

  return { ...run, nodes }
}

function toRows(run: WfRun): Row[] {
  const nodes = run.nodes
  if (nodes.length > 0 && nodes.every(n => n.phase)) {
    const order = [...run.phases]
    for (const n of nodes) if (!order.includes(n.phase!)) order.push(n.phase!)

    return order
      .map(phase => ({ phase, nodes: nodes.filter(n => n.phase === phase).sort((a, b) => a.index - b.index) }))
      .filter(r => r.nodes.length > 0)
  }

  return toTimeRows(nodes).map(row => ({ nodes: row }))
}

function toTimeRows(nodes: WfNode[]): WfNode[][] {
  const rows: WfNode[][] = []
  for (const node of [...nodes].sort((a, b) => a.startedAt - b.startedAt)) {
    const last = rows[rows.length - 1]
    const first = last?.[0]
    if (last && first && node.startedAt - first.startedAt <= SAME_ROW_MS) last.push(node)
    else rows.push([node])
  }

  return rows
}

function patchNode(list: WfRun[], agentId: string, fn: (n: WfNode) => WfNode): WfRun[] {
  return list.map(run =>
    run.nodes.some(n => n.agentId === agentId)
      ? { ...run, nodes: run.nodes.map(n => (n.agentId === agentId ? fn(n) : n)) }
      : run,
  )
}

type Dollar = StateDollar & {
  fs: { read: (path: string) => Promise<string>; stat: (path: string) => Promise<{ mtimeMs: number }> }
}

// 只從 journal 看到、沒有結果的 agent，transcript 這麼久沒動就當作已中斷。
const STALE_MS = 2 * 60 * 1000

async function syncJournal($: Dollar, runId: string, at: number): Promise<void> {
  const run = (await read($, runs)).find(r => r.runId === runId)
  if (!run?.journal) return
  let text: string
  try {
    text = await $.fs.read(run.journal)
  } catch {
    return
  }
  const merged = mergeJournal(run, text, at)
  // resume 前中斷的舊 agent 沒有結果也不會再動：看它的 transcript 多久沒寫。
  const dir = run.journal.replace(/\/journal\.jsonl$/, '')
  const stale = new Set<string>()
  const fresh = new Set<string>()
  for (const n of merged.nodes) {
    if (!n.isCached || (n.status !== 'running' && n.status !== 'stopped')) continue
    try {
      const { mtimeMs } = await $.fs.stat(`${dir}/agent-${n.agentId}.jsonl`)
      ;(at - mtimeMs > STALE_MS ? stale : fresh).add(n.agentId)
    } catch {}
  }
  await update($, runs, list => {
    const changed = list.map(r => {
      if (r.runId !== runId) return r
      const next = mergeJournal(r, text, at)

      return {
        ...next,
        nodes: next.nodes.map(n =>
          stale.has(n.agentId) && n.status === 'running'
            ? { ...n, status: 'stopped' as const }
            : fresh.has(n.agentId) && n.status === 'stopped'
              ? { ...n, status: 'running' as const }
              : n,
        ),
      }
    })

    return JSON.stringify(changed) === JSON.stringify(list) ? list : changed
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'workflow-graph',
      description: '開關 workflow 圖面板（可加 on / off）',
    })
    // 有 run 在跑時每秒更新一次時間，讓耗時跟著跳。
    $.clock.every(1000, async () => {
      const list = await read($, runs)
      const live = list.filter(r => r.status === 'running')
      if (live.length === 0) return
      const at = Date.now()
      for (const run of live) await syncJournal($, run.runId, at)
      await update($, now, () => at)
    })

    return next(e)
  })

  // 面板是不是開著；重新載入後從關著算起。
  let isOpen = false

  on('ui.close', ($, e, next) => {
    if (e.id === PANE) isOpen = false

    return next(e)
  })

  // /workflow-graph 切換開關；/workflow-graph on 或 off 指定。
  on('command.run', { command: 'workflow-graph' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const wantOpen = arg === 'on' ? true : arg === 'off' ? false : !isOpen
    if (wantOpen) {
      await $.ui.open({ id: PANE, title: TITLE })
      isOpen = true

      return { text: 'Workflow 面板已打開。' }
    }
    await $.ui.close({ id: PANE })
    isOpen = false

    return { text: 'Workflow 面板已關閉。' }
  })

  on('tool.call', { tool: 'Workflow' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const result = ran.result as {
      runId?: string
      taskId?: string
      workflowName?: string
      error?: string
      transcriptDir?: string
      scriptPath?: string
    }
    if (!result?.runId || result.error) return ran

    let script = (e as { script?: unknown }).script
    if (typeof script !== 'string' && result.scriptPath) {
      script = await $.fs.read(result.scriptPath).catch(() => undefined)
    }
    const meta = parseMeta(script)
    const startedAt = await $.clock.now()
    await update($, runs, list => {
      // 第一個 agent 可能比這裡早到，已經建好 run：保留它的節點，只補資料。
      const old = list.find(r => r.runId === result.runId)
      const run: WfRun = {
        runId: result.runId!,
        taskId: result.taskId ?? '',
        name: result.workflowName ?? meta.name ?? 'workflow',
        phases: meta.phases,
        startedAt: old ? Math.min(old.startedAt, startedAt) : startedAt,
        status: 'running',
        nodes: old?.nodes ?? [],
        journal: result.transcriptDir ? `${result.transcriptDir}/journal.jsonl` : undefined,
      }

      return [...list.filter(r => r.runId !== result.runId), run].slice(-10)
    })
    await syncJournal($, result.runId, startedAt)
    await update($, now, () => startedAt)
    void $.ui.open({ id: PANE, title: TITLE })
    isOpen = true

    return ran
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if (!e.workflow || !spawned.agentId) return spawned

    const { runId, agentIndex } = e.workflow
    const startedAt = await $.clock.now()
    const node: WfNode = {
      agentId: spawned.agentId,
      index: agentIndex,
      label: e.description || `agent #${agentIndex}`,
      status: 'running',
      startedAt,
    }
    await update($, runs, list => {
      const has = list.some(r => r.runId === runId)
      const withRun: WfRun[] = has
        ? list
        : [...list, { runId, taskId: '', name: 'workflow', phases: [], startedAt: node.startedAt, status: 'running', nodes: [] }]

      return withRun.map(r =>
        r.runId === runId
          ? {
              ...r,
              status: 'running' as const,
              endedAt: undefined,
              nodes: r.nodes.some(n => n.agentId === node.agentId)
                ? r.nodes.map(n => (n.agentId === node.agentId ? { ...n, startedAt, isCached: false } : n))
                : [...r.nodes, node],
            }
          : r,
      )
    })

    return spawned
  }).catch(($, e, next) => next(e))

  // 記下每個 workflow agent 目前在用哪個工具。
  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId) await update($, runs, list => patchNode(list, agentId, n => ({ ...n, tool: e.tool })))
    const ran = await next(e)
    if (agentId) await update($, runs, list => patchNode(list, agentId, n => (n.tool === e.tool ? { ...n, tool: undefined } : n)))

    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId) {
      const endedAt = await $.clock.now()
      const isFailed = e.reason !== 'answer' || /DAG_NODE_STATUS:\s*failed/.test(e.answer)
      await update($, runs, list =>
        patchNode(list, agentId, n => ({ ...n, status: isFailed ? 'failed' : 'completed', endedAt, tool: undefined })),
      )
    }

    return next(e)
  })

  // 主對話收到 workflow 的完成通知時，把整個 run 收尾。
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined && e.text) {
      const list = await read($, runs)
      const done = list.find(r => r.status === 'running' && (e.text.includes(r.runId) || (r.taskId && e.text.includes(r.taskId))))
      if (done) {
        const endedAt = await $.clock.now()
        const isFailed = /<status>\s*(failed|killed|error)/i.test(e.text)
        await update($, runs, all =>
          all.map(r => (r.runId === done.runId ? { ...r, status: isFailed ? ('failed' as const) : ('completed' as const), endedAt } : r)),
        )
      }
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, runs)
    const tick = Math.max(await read($, now), Date.now())
    const run = list[list.length - 1]

    if (!run) {
      return (
        <Box flexDirection="column">
          <Text dimColor>還沒有 workflow 在跑。</Text>
        </Box>
      )
    }

    const counted = run.nodes.filter(n => n.status !== 'stopped')
    const done = counted.filter(n => n.status !== 'running').length
    const running = counted.filter(n => n.status === 'running').length
    const failed = run.nodes.filter(n => n.status === 'failed').length
    const runEnd = run.endedAt ?? (running === 0 && run.nodes.length > 0 ? Math.max(...run.nodes.map(n => n.endedAt ?? 0)) : tick)
    const runColor = run.status === 'failed' || failed > 0 ? 'red' : run.status === 'completed' ? 'green' : 'cyan'
    const rows = toRows(run)

    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>{run.name}</Text>
          <Text dimColor>  {run.runId}</Text>
        </Text>
        <Text>
          <Text color={runColor}>{run.status}</Text>
          <Text> · {done}/{counted.length} done</Text>
          {running > 0 && <Text color="cyan"> · {running} running</Text>}
          {failed > 0 && <Text color="red"> · {failed} failed</Text>}
          <Text dimColor> · {formatMs(runEnd - run.startedAt)}</Text>
        </Text>
        {run.phases.length > 0 && <Text dimColor>phases: {run.phases.join(' → ')}</Text>}
        {rows.length === 0 && <Text dimColor>等第一個 agent 啟動…</Text>}
        {rows.map((row, i) => (
          <Box flexDirection="column">
            {i > 0 && <Text color="cyan">{'        ↓'}</Text>}
            {row.phase && <Text dimColor>{row.phase}</Text>}
            <Box flexDirection="row" flexWrap="wrap">
              {row.nodes.map(n => {
                const color = n.status === 'completed' ? 'green' : n.status === 'failed' ? 'red' : n.status === 'stopped' ? 'gray' : 'cyan'
                const icon = n.status === 'completed' ? '✓' : n.status === 'failed' ? '✗' : n.status === 'stopped' ? '◌' : '●'
                const took = n.isCached ? (n.status === 'running' ? '…' : n.status === 'stopped' ? '(上一輪)' : '(cached)') : formatMs((n.endedAt ?? tick) - n.startedAt)

                return (
                  <Box borderStyle="round" borderColor={color} paddingX={1} marginRight={1} flexDirection="column">
                    <Text bold>{n.label}</Text>
                    <Text color={color}>
                      {icon} {n.status}
                      {n.status === 'running' && n.tool ? ` ▶ ${n.tool}` : ''} {took}
                    </Text>
                  </Box>
                )
              })}
            </Box>
          </Box>
        ))}
        {list.length > 1 && <Text dimColor>（另有 {list.length - 1} 個較早的 run）</Text>}
      </Box>
    )
  })
}
