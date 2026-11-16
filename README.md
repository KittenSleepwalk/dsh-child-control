# dsh-child-control

## 安全与状态说明（先读）

> **只在一台机器上验证过，不保证完全安全。**
>
> - 在作者本机运行一切正常；沙盒验证（`@kittensleepwalk/dsh-sandbox-gate`）也已通过。
> - 但**只试验了这一台机器**，没有在第二台机器、也没有在其它 DSH 版本上验证过。
> - 因此请把它当「能用但未充分验证」的插件：**安装前务必备份** `~/.dsh`（至少备份
>   `~/.dsh/profiles/<你的profile>` 和改过的配置），出问题直接整目录回滚。
>
> **推荐先安装 `@kittensleepwalk/dsh-sandbox-gate`**：它会先把每个待装插件放进一次性
> 沙盒副本里跑一遍（启动、冷重启、session、其它插件、硬件占用），过了才允许装进主机。
>
> ```bash
> pnpm add github:KittenSleepwalk/dsh-sandbox-gate
> ```

## 安装

```bash
# 方式一：直接从 GitHub 装（仓库根就是包根）
pnpm add github:KittenSleepwalk/dsh-child-control

# 方式二：本地 tarball
pnpm pack    # 产出 kittensleepwalk-dsh-child-control-0.1.0.tgz
pnpm add ./kittensleepwalk-dsh-child-control-0.1.0.tgz
```

本包不提供 `cordis.patch.yml`，装好后把包名 `@kittensleepwalk/dsh-child-control`
加进 DSH profile 的 `dsh.profile.bundles`，重启 DSH 生效。

要求：Node.js ≥ 20，DSH ≥ 0.2.0-rc.1。下文的 `%USERPROFILE%`、`D:\...` 之类是示例路径，按自己的环境替换。

DSH 子智能体 / 子进程管理器：**一键真正停止当前会话的全部子智能体**，并把当前会话的
完整子进程表单摆在会话标题栏，支持新增、发送提示词（开始会话）、停止、删除会话。

## 为什么需要它：两个既有停止入口都只停一层

| 入口 | 底层调用 | 实际效果 |
| --- | --- | --- |
| 对话框 Stop | `session.cancel` → `agent.cancel({kind:'user'},{keepInbox:true})` | 只中止**主会话当前这一轮**，`ctx.subagents` 里的子 Activation 完全不动，继续跑 |
| 模型的 `interrupt_agent` | `ctx.subagents.interrupt(childId, authority)` → `activation.handle.agent.cancel(...)` | 只中止**该子智能体当前这一轮**；不带 `keepInbox:false`，不 dispose Activation，**后代继续跑** |
| 子会话自己的 Stop | `subagents/interruptByParent` → 同上 | 同上，且父会话离线也能用 |

`ctx.subagents.interrupt` 的注释写明了它保留 Activation 与已发布后代：
“Unclaimed pending inbox work, the Activation, and published descendants are preserved”。
所以「让主会话停掉全部子智能体」在原生能力里根本没有对应入口。

真正停掉一个 continuable 子智能体只有一条原生路径：

```
ctx.subagents.drainContinuableChildren(parentAgent, childIds)
  → ContinuableActivationRegistry.drainChildren(parent, ids)
  → dispose(activation)                      // 孩子优先：先 dispose ownedChildren，再 dispose 自己
  → finishDisposal → handle.agent.cancel({kind:'parent'}) + handle.dispose()
```

它要求**精确的活父亲 Agent**，并且只释放该父亲 id 列表里的直接孩子；`drainDescendants` 版本
只被 ACP 会话销毁路径调用（`packages/acp/acp/src/session.ts`），Web 会话停止路径不经过它。
本插件把它按「深度从深到浅」补全成整棵树，因此一次按钮就能带走整片森林。

## 表单里的三种「进程」

1. **子智能体（会话后端）**：`ctx.subagents.listDescendants(rootId)`，读的是会话后端 +
   `subagent` 投影，冷会话也能列出（`mode: continuable | one-shot`，带 label）。
2. **子智能体（进程内驻留）**：`ctx.agents.list()` 里 `parentSession` 链能回溯到根的活 Agent，
   给出真实 `running / idle` 与 `live` 标记。两者按 id 取并集，再从根 DFS 成 pre-order。
3. **后台作业**：`ctx.jobs.list(agent)` 逐节点取，覆盖 bash 后台命令与一次性后台子智能体
   （`JobSnapshot.ownerSession` 就是它的父会话）。`stop-all` 会先 kill 作业再释放 Agent——
   `jobs.kill` 要求以**活着的 owner** 作为授权者，释放之后就没有授权者了。

## 路由（宿主端，仅接受回环来源）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/dsh-child-control/tree?sessionId=` | 完整子进程表（rows / jobs / 每节点诊断） |
| POST | `/dsh-child-control/stop-all` | 深→浅分组 `drainContinuableChildren`，再 kill 作业；`includeRoot` 可连主会话当前轮一起停 |
| POST | `/dsh-child-control/stop` | 停一个节点及其整棵子树 |
| POST | `/dsh-child-control/add` | `ctx.subagents.startContinuable({provider:'spawn', label, request:{prompt, parent}})`：新建子智能体并把注入提示词作为它的第一轮 |
| POST | `/dsh-child-control/prompt` | `ctx.subagents.prompt(...)`：给子智能体投递提示词；冷会话自动 resume（就是「开始会话」） |
| POST | `/dsh-child-control/session/delete` | 先真停止，确认不再驻留后把会话目录移入 `$DSH_HOME/child-control-trash/`（可恢复），并写备注 json |

## 自动级联

插件监听 `session/event`：当**根会话**（`header.parentSession === undefined`）出现
`turn/end { kind:'aborted', reason:{kind:'user'} }`（就是用户按了 Stop）时，自动停止它
的全部后代与它们的后台作业。这样「主会话停止 → 子智能体一起停」不再依赖模型自觉。
`DSH_CHILD_CONTROL_CASCADE=0` 可关闭。

## 环境变量

- `DSH_CHILD_CONTROL_PROVIDER`（默认 `spawn`）：`/add` 使用的 subagent provider（`spawn` / `fork`）。
- `DSH_CHILD_CONTROL_CASCADE`（默认开）：设 `0` 关闭主会话停止时的自动级联。

## 测试

```sh
node tests/host.integration.mjs
```

用真实 cordis Context + 真实 `@deepseek-ai/dsh-host-webserver` 起 HTTP 服务，挂载本插件后
用真请求断言路由契约、pre-order、深→浅释放顺序、作业先杀、越权保护与回收、级联触发条件。
`subagents / agents / jobs` 为契约桩（真实连续性/Agent/作业实现装不进单进程半边）。
