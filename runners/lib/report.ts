import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { digestOf } from './protocol.ts';
import { scoresForRun, validateResults, type RunResults } from './protocol-results.ts';
import { failureReport, leaderboard, type CaseOutcome } from './score.ts';

export function assertRunLock(dir: string, data: RunResults): void {
  const lock = JSON.parse(readFileSync(resolve(dir, 'protocol.lock.json'), 'utf8')) as unknown;
  if (digestOf(lock) !== digestOf(data.protocol)) throw new Error('结果协议与运行前锁清单不一致');
}

export function readRunResults(dir: string): RunResults {
  const data = JSON.parse(readFileSync(resolve(dir, 'results.json'), 'utf8')) as RunResults;
  if (data.protocol === undefined) throw new Error('旧榜只读：缺少 v1.1 协议记录');
  assertRunLock(dir, data);
  validateResults(data);
  return data;
}

function metricRows(data: RunResults): string[] {
  const rows = data.protocol.models.flatMap(({ id }) => data.protocol.manifest.cases.flatMap((caseDef) => {
    const attempts = data.results.filter(({ modelId, caseId }) => modelId === id && caseId === caseDef.id);
    if (attempts.length === 0) return [];
    const count = (outcome: CaseOutcome): number => attempts.filter((row) => row.outcome === outcome).length;
    const sum = (key: 'turns' | 'tokensInput' | 'tokensOutput' | 'durationSec'): number =>
      attempts.reduce((total, row) => total + row[key], 0);
    const statuses = attempts.map(({ repeatIndex, outcome }) => `${repeatIndex}:${outcome}`).join(', ');
    return [`| ${id} | ${caseDef.id} | ${count('pass')}/${attempts.length} | ${count('timeout')} | ${sum('turns')} | ${sum('tokensInput')} | ${sum('tokensOutput')} | ${sum('durationSec').toFixed(1)} | ${statuses} |`];
  }));
  return ['| 模型 | 用例 | 通过 | 超时 | 轮数 | 输入 token | 输出 token | 时长 (s) | 各槽分类 |',
    '|---|---|---|---|---|---|---|---|---|', ...rows];
}

export function renderRunReport(data: RunResults): string {
  const { scores, excluded } = scoresForRun(data);
  const { manifest, digest, models, runId, repair } = data.protocol;
  return [
    `# v${manifest.benchmarkVersion} ${manifest.mode}${repair ? ' · 补槽' : ''}`,
    `\n协议摘要：\`${digest}\` · 运行：\`${runId}\``,
    `\nOpenCode ${manifest.opencodeVersion} · 测试床 \`${manifest.mockRepoCommit}\` · ${manifest.cases.length} 题 · 重复 ${manifest.repeat} · 并发 ${manifest.concurrency}`,
    `\n模型与档位：${models.map(({ id, model, variant }) => `\`${id}=${model}${variant ? `#${variant}` : ''}\``).join('、')}`,
    ...excluded.map(({ modelId, reason }) => `- 未入排行：\`${modelId}\` ${reason}`),
    `\n\`\`\`\n${leaderboard(scores)}\n\`\`\``,
    '\n## 逐题结果\n',
    ...metricRows(data),
    `\n补槽历史：${data.repairs?.length ?? 0} 条（完整记录见 results.json）。\n`,
  ].join('\n');
}

export function writeFinalReports(outDir: string, data: RunResults): ReturnType<typeof scoresForRun> {
  assertRunLock(outDir, data);
  const { scores, excluded } = scoresForRun(data);
  const output = (name: string, content: string): void => writeFileSync(resolve(outDir, name), content);
  output('summary.md', renderRunReport(data));
  output('leaderboard.md', `# ${data.protocol.manifest.mode} Leaderboard\n\n\`\`\`\n${leaderboard(scores)}\n\`\`\`\n`);
  output('failures.md', failureReport(data.results));
  output('incomplete.md', ['# 未入排行\n', ...excluded.map(({ modelId, reason }) => `- \`${modelId}\`：${reason}`), ''].join('\n'));
  output('results.json.tmp', JSON.stringify({ ...data, scores }, null, 2));
  renameSync(resolve(outDir, 'results.json.tmp'), resolve(outDir, 'results.json'));
  return { scores, excluded };
}
