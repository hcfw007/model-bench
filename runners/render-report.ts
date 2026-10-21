/**
 * 把 results.json 渲染成一份完整排名报告（Markdown）。
 * 用法：node runners/render-report.ts reports/<dir>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { leaderboard, scoreModel, type CaseResult } from './lib/score.ts';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node runners/render-report.ts reports/<dir>');
  process.exit(1);
}

const root = resolve(import.meta.dirname, '..');
const outDir = resolve(root, dir);
const raw = JSON.parse(readFileSync(resolve(outDir, 'results.json'), 'utf8')) as {
  config: { weights: Record<string, number> };
  results: CaseResult[];
};

const weights = raw.config.weights;
const results = raw.results;
const modelIds = [...new Set(results.map((r) => r.modelId))];
const scores = modelIds.map((id) => scoreModel(id, results, weights));
const sorted = [...scores].sort((a, b) => b.total - a.total || a.tokens - b.tokens);

const layerName: Record<string, string> = {
  l0: 'L0 通道',
  l1: 'L1 单点',
  l2: 'L2 流水线',
  l3: 'L3 Harness',
};

const lines: string[] = [];
lines.push('# 跑分排名\n');
lines.push(`模型：${modelIds.join(' / ')}　用例：${new Set(results.map((r) => r.caseId)).size} 个\n`);
lines.push('## 总排名\n');
lines.push('```');
lines.push(leaderboard(scores));
lines.push('```\n');

lines.push('## 分层得分\n');
lines.push('| 模型 | 总分 | ' + Object.values(layerName).join(' | ') + ' | 通过 | 时长 |');
lines.push('|---|---|' + Object.keys(layerName).map(() => '---|').join('') + '---|---|');
for (const s of sorted) {
  const byLayer = Object.fromEntries(s.layers.map((l) => [l.layer, l.score.toFixed(1)]));
  const cells = Object.keys(layerName).map((k) => byLayer[k] ?? '—');
  lines.push(
    `| ${s.modelId} | **${s.total.toFixed(1)}** | ${cells.join(' | ')} | ${s.passed}/${s.cases} | ${Math.round(s.durationSec / 60)}m |`,
  );
}
lines.push('');

lines.push('## 逐用例结果\n');
const caseIds = [...new Set(results.map((r) => r.caseId))].sort();
lines.push('| 用例 | ' + modelIds.join(' | ') + ' |');
lines.push('|---|' + modelIds.map(() => '---|').join(''));
for (const cid of caseIds) {
  const cells = modelIds.map((m) => {
    const r = results.find((x) => x.caseId === cid && x.modelId === m);
    if (!r) return '—';
    return r.pass ? '✅' : r.violation ? '⛔' : `❌ ${r.turns}轮`;
  });
  lines.push(`| ${cid} | ${cells.join(' | ')} |`);
}
lines.push('');

lines.push('## 失败明细\n');
const failed = results.filter((r) => !r.pass);
if (failed.length === 0) {
  lines.push('无失败。\n');
} else {
  for (const r of failed) {
    const bad = r.assertions.filter((a) => !a.pass);
    lines.push(`### ${r.modelId} / ${r.caseId}`);
    for (const a of bad) {
      lines.push(`- \`${a.type}\` — ${a.detail.slice(0, 220)}`);
    }
    if (r.error) lines.push(`- error: ${r.error.slice(0, 200)}`);
    lines.push('');
  }
}

lines.push('## 成本\n');
lines.push('| 模型 | 输入 token | 输出 token | 会话数 |');
lines.push('|---|---|---|---|');
for (const s of sorted) {
  const rows = results.filter((r) => r.modelId === s.modelId);
  const tin = rows.reduce((n, r) => n + r.tokensInput, 0);
  const tout = rows.reduce((n, r) => n + r.tokensOutput, 0);
  lines.push(`| ${s.modelId} | ${tin.toLocaleString()} | ${tout.toLocaleString()} | ${rows.length} |`);
}
lines.push('');

writeFileSync(resolve(outDir, 'RANKING.md'), lines.join('\n'));
console.log(resolve(outDir, 'RANKING.md'));
