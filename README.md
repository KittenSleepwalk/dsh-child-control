<div align="center">

# dsh-child-control

**Stop every subagent of a session — for real, in one click.**

A subagent / child-process manager for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH), pinned to the session header.

<a href="https://github.com/KittenSleepwalk/dsh-child-control/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/KittenSleepwalk/dsh-child-control?style=flat-square"></a>
<a href="https://github.com/KittenSleepwalk/dsh-child-control/issues"><img alt="GitHub issues" src="https://img.shields.io/github/issues/KittenSleepwalk/dsh-child-control?style=flat-square"></a>
<a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-amber.svg?style=flat-square"></a>
<a href="https://github.com/KittenSleepwalk/dsh-child-control"><img alt="DSH >= 0.2.0-rc.1" src="https://img.shields.io/badge/DSH-%3E%3D0.2.0--rc.1-4d6bfe?style=flat-square"></a>
<img alt="Node >= 20" src="https://img.shields.io/badge/Node-%3E%3D20-339933?style=flat-square">

**English** · [简体中文](./README.zh-CN.md)

</div>

> [!WARNING]
> **Only verified on one machine — not guaranteed to be fully safe.**
>
> - It runs fine on the author's machine, and it passed sandbox verification through [`@kittensleepwalk/dsh-sandbox-gate`](https://github.com/KittenSleepwalk/dsh-sandbox-gate).
> - But it has **only been tried on that single machine** — never on a second machine, and never on other DSH versions.
> - Treat it as *works, but not thoroughly verified*: **back up `~/.dsh` before installing** (at least `~/.dsh/profiles/<your-profile>` and any config you edited), so a broken install can be rolled back by restoring a directory.
>
> **Install [`@kittensleepwalk/dsh-sandbox-gate`](https://github.com/KittenSleepwalk/dsh-sandbox-gate) first.** It installs each candidate plugin into a throwaway sandbox copy — boot, two cold restarts, sessions, other plugins, GPU contention — and only lets it reach the host after it passes.
>
> ```bash
> pnpm add github:KittenSleepwalk/dsh-sandbox-gate
> ```

---

## 🚀 Install

```bash
# 1) straight from GitHub (the repository root *is* the package root)
pnpm add github:KittenSleepwalk/dsh-child-control

# 2) or from a local tarball
pnpm pack    # produces kittensleepwalk-dsh-child-control-0.1.0.tgz
pnpm add ./kittensleepwalk-dsh-child-control-0.1.0.tgz
```

This package ships **no** `cordis.patch.yml`. After installing, add the package name
`@kittensleepwalk/dsh-child-control` to `dsh.profile.bundles` in your DSH profile and restart DSH.

Requirements: Node.js ≥ 20, DSH ≥ 0.2.0-rc.1. Paths such as `%USERPROFILE%` and `D:\...` below are examples — use your own.

## ✨ Why it exists: both stock stop paths only stop one layer

| Entry point | Underlying call | What actually happens |
| --- | --- | --- |
| Chat Stop | `session.cancel` → `agent.cancel({kind:'user'},{keepInbox:true})` | Only aborts **the current turn of the main session**; child Activations in `ctx.subagents` keep running |
| Model's `interrupt_agent` | `ctx.subagents.interrupt(childId, authority)` → `activation.handle.agent.cancel(...)` | Only aborts **that child's current turn**; `keepInbox` is not set to `false`, the Activation is not disposed, **descendants keep running** |
| Child session's own Stop | `subagents/interruptByParent` → same as above | Same, and it also works while the parent is offline |

The comment on `ctx.subagents.interrupt` states it plainly: *"Unclaimed pending inbox work, the Activation, and published descendants are preserved."*
So "make the main session stop all its subagents" simply has no native entry point.

There is exactly one native path that truly stops a continuable child:

```
ctx.subagents.drainContinuableChildren(parentAgent, childIds)
  → ContinuableActivationRegistry.drainChildren(parent, ids)
  → dispose(activation)                      // children first: dispose ownedChildren, then self
  → finishDisposal → handle.agent.cancel({kind:'parent'}) + handle.dispose()
```

It requires an **exact, live parent agent**, and only releases the direct children listed under that parent id. The `drainDescendants` variant is only called by the ACP session-destroy path (`packages/acp/acp/src/session.ts`); the Web stop path never reaches it. This plugin completes it into a whole tree, deepest-first — so one button takes the entire forest down.

## 📋 The three kinds of "process" in the table

1. **Subagent (session backend)** — `ctx.subagents.listDescendants(rootId)`: reads the session backend plus the `subagent` projection, so cold sessions are listed too (`mode: continuable | one-shot`, with a label).
2. **Subagent (in-process)** — live agents in `ctx.agents.list()` whose `parentSession` chain reaches the root, giving a real `running / idle` state and a `live` marker. The two sources are unioned by id, then DFS'd from the root into pre-order.
3. **Background jobs** — `ctx.jobs.list(agent)` per node, covering background bash commands and one-shot background subagents (`JobSnapshot.ownerSession` is their parent session). `stop-all` kills jobs *before* releasing agents — `jobs.kill` requires a **live owner** as the authority, and after release there is none.

## 🌐 Host routes (loopback sources only)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/dsh-child-control/tree?sessionId=` | Full child-process table (rows / jobs / per-node diagnostics) |
| POST | `/dsh-child-control/stop-all` | deepest→shallowest grouped `drainContinuableChildren`, then kill jobs; `includeRoot` also stops the main session's current turn |
| POST | `/dsh-child-control/stop` | Stop one node and its whole subtree |
| POST | `/dsh-child-control/add` | `ctx.subagents.startContinuable({provider:'spawn', label, request:{prompt, parent}})`: create a subagent and use the injected prompt as its first turn |
| POST | `/dsh-child-control/prompt` | `ctx.subagents.prompt(...)`: deliver a prompt to a subagent; cold sessions are resumed automatically (that is "start the session") |
| POST | `/dsh-child-control/session/delete` | Truly stop first, confirm it is no longer resident, then move the session directory into `$DSH_HOME/child-control-trash/` (recoverable) with a note JSON |

## 🔁 Auto-cascade

The plugin listens on `session/event`: when a **root session** (`header.parentSession === undefined`) emits
`turn/end { kind:'aborted', reason:{kind:'user'} }` — i.e. the user pressed Stop — it automatically stops all of its descendants and their background jobs.
So "main session stops → subagents stop too" no longer depends on the model remembering.
Set `DSH_CHILD_CONTROL_CASCADE=0` to disable it.

## ⚙️ Environment variables

- `DSH_CHILD_CONTROL_PROVIDER` (default `spawn`) — subagent provider used by `/add` (`spawn` / `fork`).
- `DSH_CHILD_CONTROL_CASCADE` (default on) — set to `0` to disable auto-cascade on main-session stop.

## 🧪 Testing

```sh
node tests/host.integration.mjs
```

Starts a real HTTP server with a real cordis `Context` and a real `@deepseek-ai/dsh-host-webserver`, mounts this plugin, then asserts with real requests: route contracts, pre-order, deepest→shallowest release order, jobs-killed-first, privilege and recycle protection, and cascade trigger conditions.
`subagents / agents / jobs` are contract stubs (the real continuity / agent / job implementations do not fit into one half of a single process).

## 📄 License

[MIT](./LICENSE) © 2026 KittenSleepwalk

