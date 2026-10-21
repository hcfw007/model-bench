/**
 * 合并两份 results.json：用 overlay 里的同名 (caseId, modelId) 结果覆盖 base。
 * 用途：修正某个 case 后只重跑它，再把新结果并回完整结果，避免全量重跑。
 *
 * 用法：node runners/merge-results.ts reports/base reports/overlay
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { failureReport, leaderboard, scoreModel, type CaseResult } from './lib/score.ts';

const [, , baseArg, overlayArg] = process.argv;
if (!baseArg || !overlayArg) {
  console.error('usage: node runners/merge-results.ts <baseDir> <overlayDir>');
  process.exit(1);
}

const root = resolve(import.meta.dirname, '..');
const basePath = resolve(root, baseArg, 'results.json');
const overlayPath = resolve(root, overlayArg, 'results.json');

const base = JSON.parse(readFileSync(basePath, 'utf8')) as {
  config: { weights: Record<string, number> };
  results: CaseResult[];
};
const overlay = JSON.parse(readFileSync(overlayPath, 'utf8')) as { results: CaseResult[] };

const key = (r: CaseResult) => `${r.modelId}::${r.caseId}`;
const merged = new Map(base.results.map((r) => [key(r), r]));
let replaced = 0;
for (const r of overlay.results) {
  if (merged.has(key(r))) replaced += 1;
  merged.set(key(r), r);
}

const results = [...merged.values()];
const modelIds = [...new Set(results.map((r) => r.modelId))];
const scores = modelIds.map((id) => scoreModel(id, results, base.config.weights));

const outDir = resolve(root, baseArg);
writeFileSync(resolve(outDir, 'results.json'), JSON.stringify({ config: base.config, scores, results }, null, 2));
writeFileSync(resolve(outDir, 'leaderboard.md'), `# Leaderboard\n\n\`\`\`\n${leaderboard(scores)}\n\`\`\`\n`);
writeFileSync(resolve(outDir, 'failures.md'), failureReport(results));

console.log(`merged: ${results.length} results, ${replaced} replaced`);
console.log(leaderboard(scores));
