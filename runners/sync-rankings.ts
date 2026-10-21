/**
 * 从跑分结果生成排行榜，写回所有带锚点的文件。
 *
 * 用法：
 *   node runners/sync-rankings.ts reports/<dir> [--version v1.0]
 *
 * 更新：
 *   - README.md / README.en.md 的首屏排行块（RANKING 锚点之间）
 *   - rankings/<version>.md 的排行榜块
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { scoreModel, type CaseResult } from './lib/score.ts';

const args = process.argv.slice(2);
const dirArg = args.find((a) => !a.startsWith('--'));
const versionIdx = args.indexOf('--version');
const version = versionIdx >= 0 ? args[versionIdx + 1] : 'v1.0';

if (!dirArg) {
  console.error('usage: node runners/sync-rankings.ts reports/<dir> [--version v1.0]');
  process.exit(1);
}

const root = resolve(import.meta.dirname, '..');
const data = JSON.parse(readFileSync(resolve(root, dirArg, 'results.json'), 'utf8')) as {
  config: { weights: Record<string, number> };
  results: CaseResult[];
};

const modelIds = [...new Set(data.results.map((r) => r.modelId))];
const scores = modelIds.map((id) => scoreModel(id, data.results, data.config.weights));
scores.sort((a, b) => b.total - a.total || a.tokens - b.tokens);

const caseCount = new Set(data.results.map((r) => r.caseId)).size;
const today = new Date().toISOString().slice(0, 10);

function table(zh: boolean): string {
  const head = zh ? '| # | 模型 | 总分 |' : '| # | Model | Score |';
  const sep = '|---|---|---|';
  const rows = scores.map((s, i) => `| ${i + 1} | \`${s.modelId}\` | **${s.total.toFixed(1)}** |`);
  const tail = zh
    ? `\n${caseCount} 个用例 · ${today}`
    : `\n${caseCount} cases · ${today}`;
  return [head, sep, ...rows, tail].join('\n');
}

/** 把文本包进 blockquote，用于 README 首屏 */
function quoted(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? `> ${line}` : '>'))
    .join('\n');
}

interface Patch {
  file: string;
  body: string;
}

const patches: Patch[] = [
  { file: 'README.md', body: quoted(table(true)) },
  { file: 'README.en.md', body: quoted(table(false)) },
  { file: `rankings/${version}.md`, body: table(true) + '\n\n同分时按输入 token 升序排列。' },
];

for (const { file, body } of patches) {
  const path = resolve(root, file);
  if (!existsSync(path)) {
    console.log(`skip (missing): ${file}`);
    continue;
  }
  const src = readFileSync(path, 'utf8');
  const re = /(<!-- RANKING:START -->)[\s\S]*?(<!-- RANKING:END -->)/;
  if (!re.test(src)) {
    console.log(`skip (no anchor): ${file}`);
    continue;
  }
  // README 用 blockquote 包裹，结束标记也要带上 >
  const tail = file.startsWith('README') ? '> $2' : '$2';
  const next = src.replace(re, `$1\n${body}\n${tail}`);
  writeFileSync(path, next);
  console.log(`updated: ${file}`);
}

console.log(`\n${scores.length} models, ${caseCount} cases`);
for (const s of scores) console.log(`  ${s.total.toFixed(1).padStart(6)}  ${s.modelId}`);
