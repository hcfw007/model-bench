# 排行索引

**中文** | [English](README.en.md)

model-bench 的历史跑分记录。每个版本对应一组固定的用例与权重，跨版本分数不可直接比较。

## 版本规则

| 变更 | 版本动作 |
|---|---|
| 新增模型、重跑同一套用例 | 更新该版本表格，不改版本号，标注重跑日期 |
| 增删用例、调整断言口径 | 升 minor（1.0 → 1.1） |
| 调整层权重、重构评分方式 | 升 minor，并在表格里注明 |
| 更换测试床结构或不兼容改造 | 升 major（1.x → 2.0） |

某个版本一旦发布，其用例集合与权重就冻结。要改题，就开新版本，不要就地修改历史表格。

## 版本列表

| 版本 | 用例数 | 发布日期 | 链接 |
|---|---|---|---|
| v1.0 | 31 | 2026-10-22 | [v1.0.md](v1.0.md) |

## 新增模型的步骤

```bash
# 1. 在 bench.config.jsonc 的 models 里加一条
# 2. 用同一版本跑全量
node runners/run-bench.ts --models <新模型 id> --out reports/<日期>-<模型>

# 3. 合并到该版本的总结果
node runners/merge-results.ts reports/<版本主结果目录> reports/<日期>-<模型>

# 4. 重新渲染完整报告
node runners/render-report.ts reports/<版本主结果目录>

# 5. 把排行榜同步回 README 首屏与该版本的 md（锚点之间自动替换）
node runners/sync-rankings.ts reports/<版本主结果目录> --version v1.0
```

第 5 步会更新三处，不要手改：

- `README.md` 首屏排行块
- `README.en.md` 首屏排行块
- `rankings/v1.0.md` 的排行榜

它们都带 `<!-- RANKING:START -->` / `<!-- RANKING:END -->` 锚点。

只有一个模型跑过某版本时，表格里其他模型的分列留空，不要用不同版本的分数填补。
