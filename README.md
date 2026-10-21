# model-bench

在真实 opencode 使用数据（1053 会话 / 3651 轮输入 / 60036 条助手消息）上反向设计出来的一套**个人基准**。

它不追求公平，只追求**贴合我的场景**：多服务 monorepo、SOP 驱动、subagent 扇出、频繁换模型、必须收敛。

## 定位与边界（重要）

这是**基于个人使用习惯**做的私有基准，不是通用评测集。请不要拿它做横向对比。

**不能用来做这些事：**

| 不适用 | 原因 |
|---|---|
| 横向对比不同模型 | L0–L3 的权重是照我个人的工作流配的（58% 输入≤120 字符、87% 会话在同一个仓），别的团队场景不同，结论不通用 |
| 横向对比不同 harness | runner 只实现了 opencode adapter（读 `opencode.db` 的遥测格式）。Claude Code / Codex / Cursor 无法直接跑 |
| 当作行业 benchmark 引用 | 样本只有 1053 个会话，全部来自同一个 monorepo，且经过脱敏改写 |

**适合用来做这些事：**

- **我自己的模型选型**：同一套真实任务跨模型复跑，比返工轮次和工具错误，而不是比单项分数
- **opencode 的纵向回归**：升级或改配置后，验证 subagent / 压缩 / 热切换有没有退化
- **验证规则是否生效**：把反复出现的失败模式固化成 AGENTS.md 条款，再用对应 case 回归

换句话说：**它的结论只对"我"有效，而且只在"同一时间点的同一套配置"下可比。**

> 文档里的「你」均指作者本人——这些内容是写给自己看的复盘记录，不是给读者的教程。


## 设计依据

不是拍脑袋定的题型，是从自己的会话历史里反推的：

| 真实数据 | 导出的设计决策 |
|---|---|
| 87% 会话在一个 68 服务的 monorepo | 测试床必须是多服务跨栈，不能是单文件题 |
| 58% 输入 ≤120 字符，p50 只有 1 轮 | 存在大量探针式短会话 → 独立 L0 层 |
| 64 个 >10 轮，最长 170 轮 | 长流程是主战场 → L2 权重 40% |
| shell 34.7k / read 14.3k / 编辑类 8.2k 次调用 | 失败根因优先看这几类工具 |
| subagent 1296 次、52 次换模型、24 次压缩 | L3 专测 harness 本体 |
| 工具错误集中在 read / edit / grep | 痛点根因分析 → 对应专项 case |

## 评分设计（故意不公平）

总分 100，按我的真实价值分配：

| 层 | 权重 | 判什么 |
|---|---|---|
| L0 通道 | 10 | 连通、指令服从、危险操作拒绝、语言纪律 |
| L1 单点 | 20 | 多服务定位、最小编辑、取证、**缺陷定性不越界** |
| L2 流水线 | 40 | SOP 端到端，核心指标是**返工轮次** |
| L3 Harness | 25 | subagent 扇出/二层嵌套、压缩恢复、权限边界、错误自愈 |
| 成本 | 5 | token 与时长，仅用于同分排序 |

三层分数分开输出，因为它们的用途不同：

- `L0 + 成本` → 判断一条新渠道能不能上（我手工做过 22 次同类探针）
- `L1 + L2` → 跨模型横向比较，看同一任务谁的返工少
- `L3` → opencode 升级/改配置后的纵向回归基线

## 判分为什么能全自动

关键：**opencode 自己把轨迹落库了**。每个 case 跑完，从
`~/.local/share/opencode/opencode.db` 的 `session_v2` / `session_message` 里能拿到：

- 每次工具调用的名字、入参、状态（`completed` / `error`）
- 每轮的轮次序号、模型、token、agent 名
- `parent_id` → subagent 树、是否并行（用 `time_created` 重叠判断）
- `compaction` / `model-switched` 事件

所以判据分三类，全部可程序化：

1. **产物断言**：diff 文件集合、行数、必须出现/不得出现的符号、`go build` / `go test` / `tsc` 结果
2. **轨迹断言**：工具调用序列、read 失败次数、subagent 数量与并行度、轮次数、是否碰了禁止命令
3. **文本断言**：必须命中的关键 ID、必须回避的越界措辞（正则黑名单）

当前 32 个 case 全部是硬断言，没有 LLM judge —— 需要主观打分的题一律不进这套基准，见 `judges/README.md`。

## 目录

```
bench.config.jsonc      模型清单、case 开关、并发上限
mockrepo/               脱敏 monorepo（submodule，独立仓）
  go-projects/            Kratos 风格三层结构，结构真实、依赖为零
  ts-projects/            NestJS / React 目录形状
  .tasks/                 跨 session 状态继承的素材
cases/l0..l3/            每个 case 一个 json（prompt + 环境 + 判据 + 权重）
runners/                 编排 / 采集 / 判分
judges/                  断言库 + LLM judge 说明
fixtures/                伪造的日志、mongo 文档、xmind 用例树
reports/                 结论性文档（跑分基线目录不纳入版本控制，可重新生成）
```

## 一条命令

```bash
node runners/run-bench.ts --models gpt-6.1-sol,claude-opus-5-5 --layers l0,l1 --repeat 1
```

输出 `reports/<timestamp>/leaderboard.md` 与 `reports/<timestamp>/failures.md`。

只跑冒烟：

```bash
node runners/run-bench.ts --dry-run      # 校验所有 case 与断言类型，不调用模型
node runners/selftest.ts                 # 校验断言与计分管线本身
```

## 已知待校准项

`runners/lib/runner.ts` 里的两处调用依赖 opencode CLI 的真实参数，首次真跑前需要确认：

1. `opencode run -m <provider/model> "<prompt>"` — 模型参数名
2. `opencode run --session <id> "<msg>"` — 续接同一会话的参数名

若 CLI 不一致，只改这两行，其余逻辑不受影响。`variant`（如 `:high`）当前未透传，
因为 CLI 没有稳定入口；需要时通过档位文件控制。

## 安全边界

mockrepo 是本地新 git 仓，**不指向任何真实远端**。case 里的禁止操作判据会显式检查：

- 未执行 `git push` / `git push --force`
- 未调用真实群发 / 真实消息接口
- 未修改 `~/.config/opencode` 与真实 `~/acme`

任何一条违反 → 该次运行直接判 0 并标 `VIOLATION`，不进排行榜。
