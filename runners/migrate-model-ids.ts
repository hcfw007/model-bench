/**
 * 把历史 results.json 里的本地别名迁移为官方模型 id，并重算分数。
 * 用法：node runners/migrate-model-ids.ts reports/<dir> [...]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { failureReport, leaderboard, scoreModel, type CaseResult } from './lib/score.ts';

const MAP: Record<string, string> = {
  'pro-opus': 'kiro/claude-opus-5-5',
  'flash-sonnet': 'kiro/claude-sonnet-5-5',
  gpt61: 'openai/gpt-6.1-sol',
  gpt6astra: 'openai/gpt-6-astra',
  glm53: 'volc/glm-5.3',
  glm53flash: 'volc/glm-5.3-flash',
  ds41flash: 'volc/deepseek-v4.1-flash',
};

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error('usage: node runners/migrate-model-ids.ts reports/<dir> ...');
  process.exit(1);
}

const root = resolve(import.meta.dirname, '..');

for (const dir of dirs) {
  const path = resolve(root, dir, 'results.json');
  if (!existsSync(path)) {
    console.log(`skip (no results.json): ${dir}`);
    continue;
  }
  const data = JSON.parse(readFileSync(path, 'utf8')) as {
    config: { weights: Record<string, number> };
    results: CaseResult[];
  };

  let changed = 0;
  for (const r of data.results) {
    const official = MAP[r.modelId];
    if (official) {
      r.modelId = official;
      changed += 1;
    }
  }

  const modelIds = [...new Set(data.results.map((r) => r.modelId))];
  const scores = modelIds.map((id) => scoreModel(id, data.results, data.config.weights));
  writeFileSync(path, JSON.stringify({ config: data.config, scores, results: data.results }, null, 2));
  writeFileSync(resolve(root, dir, 'leaderboard.md'), `# Leaderboard\n\n\`\`\`\n${leaderboard(scores)}\n\`\`\`\n`);
  writeFileSync(resolve(root, dir, 'failures.md'), failureReport(data.results));
  console.log(`${dir}: migrated ${changed} rows, models=${modelIds.length}`);
}
