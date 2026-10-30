/** 统一的最终产物：完整结果、排行榜、失败明细、未完成清单。 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BenchConfig } from './config.ts';
import { failureReport, leaderboard, scoreModel, type CaseResult, type ModelScore } from './score.ts';
import type { RunMeta } from './parallel.ts';

export function writeFinalReports(opts: {
  outDir: string;
  cfg: BenchConfig;
  results: CaseResult[];
  meta: RunMeta;
  skipped: Array<{ modelId: string; reason: string }>;
}): ModelScore[] {
  const { outDir, cfg, results, meta, skipped } = opts;
  mkdirSync(outDir, { recursive: true });

  const modelIds = [...new Set(results.map((r) => r.modelId))];
  const scores = modelIds.map((id) => scoreModel(id, results, cfg.weights));

  writeFileSync(resolve(outDir, 'results.json'), JSON.stringify({ config: cfg, scores, results, meta }, null, 2));
  writeFileSync(resolve(outDir, 'leaderboard.md'), `# Leaderboard\n\n\`\`\`\n${leaderboard(scores)}\n\`\`\`\n`);
  writeFileSync(resolve(outDir, 'failures.md'), failureReport(results));

  const skippedReport = skipped.length === 0
    ? '# 未完成模型\n\n无。\n'
    : ['# 未完成模型\n', '以下模型缺少完整用例结果，已排除出评分与排行：\n',
      ...skipped.map((s) => `- \`${s.modelId}\`：${s.reason}`)].join('\n') + '\n';
  writeFileSync(resolve(outDir, 'incomplete.md'), skippedReport);
  return scores;
}
