# workflow-graph

A Claude Code mod that shows your running Workflow as a live graph in a side pane: each step's status, the tool it is using right now, and how long it has run.

一個 Claude Code mod：在聊天旁邊開一個面板，即時顯示正在跑的 Workflow——每個步驟的狀態、目前在用哪個工具、跑了多久。

```
my-workflow  wf_1234abcd-567
running · 3/4 done · 1 running · 3m50s
Pick
╭──────────────────────╮
│ pick                 │
│ ✓ completed (cached) │
╰──────────────────────╯
        ↓
Fix
╭────────────────────────╮
│ fix:A                  │
│ ● running ▶ Bash 3m50s │
╰────────────────────────╯
```

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install workflow-graph --marketplace WarrenLin/claude-workflow-graph
```

Answer `y` to add the marketplace, then press Enter to pick the user scope.

From a shell:

```
claude plugin install workflow-graph --marketplace WarrenLin/claude-workflow-graph
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `WarrenLin/claude-workflow-graph`, then Add plugin.

## Use

- The pane opens by itself whenever a Workflow starts.
- `/workflow-graph` toggles the pane; `/workflow-graph on` or `/workflow-graph off` sets it.

What the pane shows:

| Mark | Meaning |
| --- | --- |
| `● running ▶ Bash 12s` | running, now using the Bash tool, 12 seconds so far |
| `✓ completed 1m05s` | finished |
| `✗ failed` | failed or aborted |
| `✓ completed (cached)` | reused from an earlier attempt on a resumed run |
| `◌ stopped (上一輪)` | an agent from an earlier attempt that never finished |

Steps are grouped by the `phase` the workflow script gives each `agent()`; without phases, agents that start together share a row.

## Limits

- The arrows follow phase order (or start time), not real data dependencies.
- The run is marked done when the main conversation receives the workflow's completion notice.
- A pane reloaded in the middle of a run picks the run up again only at the next Workflow call.

## License

MIT
