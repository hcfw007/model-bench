# model-bench

opencode 个人基准：用 `opencode run` 在 mockrepo 的 worktree 里跑 case，再从 `~/.local/share/opencode/opencode.db` 读轨迹做硬断言判分。

## 运行

- 零依赖，不要 `npm install`。直接 `node runners/*.ts`（Node 24 原生 type stripping + `node:sqlite`），import 必须带 `.ts` 后缀。
- 无 tsc / lint / 测试框架。改完 runner 的验证顺序：
  1. `node runners/selftest.ts`：纯逻辑，不调模型
  2. `node runners/run-bench.ts --dry-run`：校验所有 case 的断言类型
- `node runners/run-bench.ts` 会真实调用模型、消耗 token、写用户自己的 opencode.db，未经用户要求不要跑。缩小范围用 `--layers l0`、`--cases l1-05`（子串匹配）、`--models <id,...>`、`--repeat`、`--out reports/<dir>`。
- `--models` 取 `bench.config.jsonc` 里的官方 id（如 `kiro/claude-opus-5-5`）。`pro-opus` 这类旧别名会被当作未知模型跳过，旧 results.json 用 `migrate-model-ids.ts` 迁移。
- 执行是串行的。`run.concurrency`、`run.maxTurns` 只在类型里声明，代码没用到。

## 结果后处理（都读 `reports/<dir>/results.json`）

- `merge-results.ts <base> <overlay>`：只重跑个别 case 后并回完整结果，避免全量重跑。
- `sync-rankings.ts reports/<dir> [--version v1.0]`：重写 `README.md`、`README.en.md` 的 `<!-- RANKING:START/END -->` 块和 `rankings/<version>.md`。排行不要手改。
- `render-report.ts`、`analyze.ts <dir> [caseId]`（失败根因）、`latency.ts <caseId> <modelId>`。
- `reports/*/` 被 gitignore，只有 `reports/*.md` 结论文档入库。

## 加 / 改 case

- 格式与断言 DSL 见 `cases/README.md`。新增断言类型要同时改三处：`runners/lib/assert-artifacts.ts` 或 `assert-trajectory.ts` 的实现、`run-bench.ts` 里的 `SUPPORTED` 集合（否则 dry-run 报错）、`selftest.ts`。
- 只用硬断言，不加 LLM judge（约束见 `judges/README.md`）。
- `hiddenTests` 格式是 `相对 cases/ 的路径 -> worktree 内路径`。断言前会重新拷贝一次，源文件缺失直接抛错。
- `noForbidden` 由 runner 自动注入每个 case，不要在 case 里重复写。`allowedTurns` 也由 runner 转成轮次断言（结果里 type 为 `allowedTurns`），轮次只数根会话的用户消息，必须 ≥ `followUps` 数 + 1。
- 改 case 数量后，同步 README 中英版、`judges/README.md` 里写死的用例数。

## mockrepo（git submodule，独立仓）

- 测试床本身，有自己的 `mockrepo/AGENTS.md`（禁推送等硬约束，是被测模型看的）。
- runner 从 mockrepo 的 `main` 分支建 `.worktrees/bench_*` worktree 和 `bench/*` 分支，结束后删除，并清掉 case 期间新建的分支。不要在 mockrepo 的 `main` 上留未提交改动或额外分支，否则会污染所有 case。
- case 依赖 mockrepo 的具体代码和 git 历史（如 `l1-09` 代码考古），改 mockrepo 要按 case 的 gold 核对。

## 平台耦合（换 opencode 版本时先核对）

- 会话靠唯一 `--title` 关联，不靠 directory；spawn 必须显式设 `PWD=cwd`，并带 `--auto --standalone`。原因见 `reports/CALIBRATION.md`。
- 续接用 `opencode run --session <id>`，模型参数是 `-m provider/model#variant`。
- 轨迹解析依赖 `session_v2` / `session_message` 表结构（`runners/lib/trace.ts`）。
- `config.ts` 的 jsonc 解析只删整行 `//` 注释和尾逗号，行尾注释会让 JSON 解析失败。
