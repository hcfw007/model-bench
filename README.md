# model-bench

**中文** | [English](README.en.md)

> ### 📊 [v1.0 排行](rankings/v1.0.md)
>
> <!-- RANKING:START -->
> | # | 模型 | 总分 |
> |---|---|---|
> | 1 | `kiro/claude-sonnet-5-5` | **100.0** |
> | 2 | `volc/deepseek-v4.1-flash` | **96.3** |
> | 3 | `kiro/claude-opus-5-5` | **96.3** |
> | 4 | `openai/gpt-6-luna` | **86.2** |
> | 5 | `openai/gpt-6.1-sol` | **85.7** |
> | 6 | `openai/gpt-6-astra` | **85.7** |
>
> 31 个用例 · 2026-10-23
> <!-- RANKING:END -->

一套在我真实 opencode 使用数据上反向设计出来的个人基准：1053 个会话、3651 轮输入、60036 条助手消息。

我不追求公平，只追求贴合自己的场景：多服务 monorepo、SOP 驱动、subagent 扇出、频繁换模型、必须收敛。

## 定位与边界

这是基于个人使用习惯做的基准，不是通用评测集。请不要拿它做横向对比。

**不能用来做：**

| 不适用 | 原因 |
|---|---|
| 横向对比不同模型 | L0–L3 的权重是照个人的工作流配的（58% 输入 ≤120 字符、87% 会话在同一个仓），换个团队结论就不成立 |
| 横向对比不同 harness | runner 只实现了 opencode adapter，读的是 `opencode.db` 的遥测格式；Claude Code / Codex / Cursor 跑不了 |
| 当作行业 benchmark 引用 | 样本只有 1053 个会话，全部来自同一个 monorepo，而且经过脱敏改写 |

**适合用来做：**

- **自己的模型选型**：同一套真实任务跨模型复跑，比返工轮次和工具错误，而不是比单项分数
- **opencode 的纵向回归**：升级或改配置后，验证 subagent / 压缩 / 热切换有没有退化
- **验证规则是否生效**：把反复出现的失败模式固化成 AGENTS.md 条款，再用对应 case 回归

结论只对"我自己"有效，而且只在同一时间点的同一套配置下可比。

## 设计依据

题型不是拍脑袋定的，是从会话历史里反推的：

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
| L1 单点 | 20 | 多服务定位、最小编辑、取证、缺陷定性不越界 |
| L2 流水线 | 40 | SOP 端到端，核心指标是返工轮次 |
| L3 Harness | 25 | subagent 扇出/二层嵌套、压缩恢复、权限边界、错误自愈 |
| 成本 | 5 | token 与时长，仅用于同分排序 |

分层输出，因为用途不同：

- `L0 + 成本` → 判断一条新渠道能不能上（我手工做过 22 次同类探针）
- `L1 + L2` → 跨模型比较，看同一任务谁的返工少
- `L3` → opencode 升级/改配置后的纵向回归

## 判分为什么能全自动

关键：opencode 自己把轨迹落库了。每个 case 跑完，从
`~/.local/share/opencode/opencode.db` 的 `session_v2` / `session_message` 里能拿到：

- 每次工具调用的名字、入参、状态（`completed` / `error`）
- 每轮的轮次序号、模型、token、agent 名
- `parent_id` → subagent 树、是否并行（用 `time_created` 重叠判断）
- `compaction` / `model-switched` 事件

所以判据分三类，全部可程序化：

1. **产物断言**：diff 文件集合、行数、必须出现/不得出现的符号、`go build` / `go test` / `tsc` 结果
2. **轨迹断言**：工具调用序列、read 失败次数、subagent 数量与并行度、轮次数、是否碰了禁止命令
3. **文本断言**：必须命中的关键 ID、必须回避的越界措辞（正则黑名单 + 否定语境豁免）

当前 31 个 case 全部硬断言，没有 LLM judge —— 需要主观打分的题一律不进这套基准，见 `judges/README.md`。

## 目录

```
bench.config.jsonc      模型清单、case 开关、并发上限
mockrepo/               脱敏 monorepo（submodule，独立仓）
  go-projects/            Kratos 风格三层结构，结构真实、依赖为零
  ts-projects/            NestJS / React 目录形状
  .tasks/                 跨 session 状态继承的素材
cases/l0..l3/            每个 case 一个 json（prompt + 环境 + 判据 + 权重）
runners/                 编排 / 采集 / 判分
judges/                  断言边界说明
fixtures/                伪造的日志、mongo 文档、用例树
reports/                 结论性文档（跑分基线目录不进版本控制，可重新生成）
```

## 跑起来

```bash
git clone --recursive https://github.com/hcfw007/model-bench.git
cd model-bench
node runners/selftest.ts                       # 校验断言与计分管线
node runners/run-bench.ts --dry-run            # 校验 31 个 case
node runners/run-bench.ts --layers l0 --models kiro/claude-opus-5-5,kiro/claude-sonnet-5-5
```

只依赖 Node 内置模块（`node:sqlite` + type stripping），不需要 `npm install`。

输出 `reports/<timestamp>/leaderboard.md` 与 `failures.md`。

每个用例的实测状态与已知限制见 [`reports/COVERAGE.md`](reports/COVERAGE.md)。

## 已知需要校准的地方

`runners/lib/runner.ts` 里的两处调用依赖 opencode CLI 的真实参数，换版本后需要确认：

1. `opencode run -m <provider/model#variant> "<prompt>"` — 模型参数格式
2. `opencode run --session <id> "<msg>"` — 续接同一会话

另外 `bench.config.jsonc` 里的档位引用是 `{file:~/.config/opencode/models/pro}`，
没有这个文件时直接填 `provider/model` 即可。

## 安全边界

mockrepo 是本地新 git 仓，不指向任何真实远端。每个 case 都强制检查：

- 未执行 `git push` / `git push --force`
- 未调用真实群发 / 真实消息接口
- 未修改 `~/.config/opencode`、业务仓路径、`~/.claude`

命中任意一条 → 该次运行判 0 分并标 `VIOLATION`，不进排行榜。
