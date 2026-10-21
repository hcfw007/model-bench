# Cases — 用例格式

一个 case 一个 JSON。所有判据都是**可程序化**的，不需要人看。

```jsonc
{
  "id": "l1-03",
  "layer": "l1",
  "weight": 1.0,
  "title": "编辑失败后 2 步内换策略",
  "why": "你历史上有 82 次 edit:error、68 次 apply_patch:error，根因多是 oldString 不唯一",
  "worktree": true,            // 是否基于独立 worktree 跑（默认 true）
  "prompt": "…",               // 原样喂给 opencode run
  "followUps": ["…"],          // 可选：按顺序追加的用户消息（模拟真实纠偏/评审往返）
  "hiddenTests": ["…"],        // 可选：从 cases/ 下拷贝进 worktree 的隐藏测试文件
  "allowedTurns": 10,          // 超过即判该项 0 分
  "assertions": [ … ],
  "gold": "参考解，写给人看"
}
```

## 断言 DSL

产物类：

| type | 字段 | 含义 |
|---|---|---|
| `cmd` | `run`, `expect: "exit0" \| "exitNonZero"`, `timeoutSec` | 执行命令判退出码 |
| `diffFiles` | `mustInclude[]`, `mustExclude[]` | 改动文件集合 |
| `diffLines` | `max`, `min` | 改动总行数（最小编辑能力） |
| `fileContains` | `path`, `pattern`（正则） | 文件内容必须命中 |
| `fileNotContains` | `path`, `pattern` | 文件内容必须不含 |
| `gitClean` | — | 工作区无未提交改动（可选） |

轨迹类（从 `opencode.db` 的 `session_message` 抽）：

| type | 字段 | 含义 |
|---|---|---|
| `turns` | `max` | 用户轮次数 |
| `toolCalls` | `name`, `max`/`min` | 某工具调用次数 |
| `toolErrors` | `name`, `max` | 某工具失败次数（read 猜路径是重点） |
| `toolSequence` | `mustCallAny[]`, `before` | 编辑前必须先做检索 |
| `subagents` | `min`, `parallel: true` | subagent 数量与并行度 |
| `nestedAgents` | `minDepth` | 子会话再开子会话的层数 |
| `compactionSurvived` | `mustRecall[]` | 压缩后仍能引用这些字符串 |
| `noForbidden` | — | 未命中 `bench.config.jsonc` 的 forbiddenCommands |
| `noEditsAfterTurn` | `after`, `max` | 第 N 轮之后不再出现编辑类工具调用（收敛纪律） |

文本类：

| type | 字段 | 含义 |
|---|---|---|
| `textMatch` | `must[]`, `mustAny[]`, `mustNot[]` | 必须全部命中 / 至少命中一个 / 不得命中 |
| `textRatioCJK` | `min` | 中文字符占比（语言纪律） |
| `exactText` | `value` | 完全相等（连通性探针） |

## 权重

`weight` 是层内相对权重，层总分按 `bench.config.jsonc` 的 `weights` 归一化。
同一层内所有 case 的 `weight` 之和不必等于 1。

## 反作弊

`noForbidden` 由 runner 强制注入到**每一个** case，无需在 case 里重复声明。
命中即整轮 `VIOLATION`。
