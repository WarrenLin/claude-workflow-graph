/** stopped：resume 前就中斷、沒有結果的舊 agent */
export type NodeStatus = 'running' | 'completed' | 'failed' | 'stopped'

export type WfNode = {
  agentId: string
  index: number
  label: string
  status: NodeStatus
  startedAt: number
  endedAt?: number
  /** 這個 agent 目前在跑的工具，例如 Write */
  tool?: string
  /** workflow 腳本裡 agent() 的 phase */
  phase?: string
  /** journal 裡這個 agent() 呼叫的 key；同 key 重跑時舊的那筆作廢 */
  key?: string
  /** 只從 journal 看到、沒收到啟動事件（resume 沿用的結果），耗時不明 */
  isCached?: boolean
}

export type WfRun = {
  runId: string
  taskId: string
  name: string
  phases: string[]
  startedAt: number
  endedAt?: number
  status: 'running' | 'completed' | 'failed'
  nodes: WfNode[]
  /** workflow 的 journal.jsonl 路徑，用來補上 label、phase 與 resume 沿用的步驟 */
  journal?: string
}

declare module 'claude-code' {
  interface PluginState {
    'workflow-graph': {
      runs: Shaped<WfRun[]>
      now: number
    }
  }
}
