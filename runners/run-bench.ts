import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, type ModelSpec } from './lib/config.ts';
import { loadCases, type CaseDef } from './lib/runner.ts';
import { runSerialModels } from './lib/run-serial.ts';
import { runParallelModels } from './lib/run-parallel.ts';
import { writeFinalReports } from './lib/report.ts';
import { leaderboard, type ModelScore } from './lib/score.ts';
import type { RunMeta } from './lib/parallel.ts';

const SUPPORTED = new Set([
  'cmd', 'diffFiles', 'diffLines', 'fileContains', 'fileNotContains',
  'turns', 'toolCalls', 'toolErrors', 'toolSequence', 'subagents', 'nestedAgents',
  'compactionSurvived', 'modelSwitches', 'timeout', 'tokens',
  'textMatch', 'exactText', 'textRatioCJK', 'noForbidden',
  'noEditsAfterTurn', 'noToolErrorMatching', 'textMatchRegex', 'shellCommandMatches',
]);

const args = process.argv.slice(2);
function arg(name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
function list(name: string, fallback: string): string[] {
  return arg(name, fallback).split(',').map((s) => s.trim()).filter(Boolean);
}

const root = resolve(import.meta.dirname, '..');
const configPath = resolve(root, 'bench.config.jsonc');
const cfg = loadConfig(configPath);
const layers = list('layers', Object.keys(cfg.layers).filter((k) => cfg.layers[k]).join(','));
const only = list('cases', '');
const requested = [...new Set(list('models', cfg.models.map((m) => m.id).join(',')))];
const repeat = Number(arg('repeat', String(cfg.run.repeat)));
const dryRun = args.includes('--dry-run');
const isWorker = process.env.OPENCODE_BENCH_WORKER === '1';
const concurrency = Math.max(1, Math.floor(Number(arg('concurrency', String(cfg.run.concurrency))) || 1));

const casesRoot = resolve(root, 'cases');
const cases: CaseDef[] = loadCases(casesRoot, layers, only);
if (cases.length === 0) {
  console.error('没有匹配的 case。');
  process.exit(1);
}

const specs: ModelSpec[] = [];
for (const id of requested) {
  const spec = cfg.models.find((m) => m.id === id);
  if (spec) specs.push(spec);
  else console.error(`跳过未知模型: ${id}`);
}
if (specs.length === 0) {
  console.error('没有可用模型。');
  process.exit(1);
}

if (dryRun) {
  let bad = 0;
  console.log(`\n${cfg.bench.name} v${cfg.bench.version} — dry run\n`);
  const byLayer: Record<string, CaseDef[]> = {};
  for (const c of cases) {
    (byLayer[c.layer] ??= []).push(c);
    const unknown = c.assertions.map((a) => String(a.type)).filter((t) => !SUPPORTED.has(t));
    if (unknown.length > 0) {
      bad += 1;
      console.error(`  ✗ ${c.id}: 不支持的断言 ${unknown.join(',')}`);
    }
  }
  for (const layer of Object.keys(byLayer).sort()) {
    const rows = byLayer[layer];
    const weight = rows.reduce((s, c) => s + (c.weight ?? 1), 0);
    console.log(`  ${layer.toUpperCase()}  ${String(rows.length).padStart(2)} cases  weight=${weight}`);
    for (const c of rows) console.log(`      - ${c.id}  ${c.title}`);
  }
  console.log(`\n  模型: ${specs.map((s) => s.id).join(', ')}`);
  console.log(`  预计执行: ${specs.length * cases.length * repeat} 次会话`);
  console.log(`  并行: ${concurrency}${concurrency > 1 ? '（每模型独立克隆 mockrepo）' : '（串行，不使用克隆）'}`);
  console.log(bad === 0 ? '\n  ✓ 所有断言类型可执行\n' : `\n  ✗ ${bad} 个 case 有问题\n`);
  process.exit(bad === 0 ? 0 : 1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = resolve(root, arg('out', `reports/${stamp}`));
mkdirSync(outDir, { recursive: true });
const startedAt = new Date();

if (!isWorker) console.log(`并行度 ${concurrency}｜模型 ${specs.length} 个｜用例 ${cases.length} 个｜重复 ${repeat} 次`);
let skipped: Array<{ modelId: string; reason: string }> = [];
let meta: RunMeta;
let scores: ModelScore[];

if (isWorker || concurrency === 1) {
  const results = runSerialModels({ cfg, casesRoot, cases, specs, repeat, outDir });
  const finishedAt = new Date();
  meta = {
    mode: 'serial',
    concurrency: 1,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    wallSec: Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000),
    workers: specs.map((s) => ({ modelId: s.id, status: 'complete' as const })),
  };
  scores = writeFinalReports({ outDir, cfg, results, meta, skipped });
} else {
  const outcome = await runParallelModels({
    cfg, configPath, repoRoot: root, cases, specs, repeat, concurrency, layers, only, outDir,
  });
  skipped = outcome.skipped;
  meta = outcome.meta;
  scores = writeFinalReports({ outDir, cfg, results: outcome.results, meta, skipped });
}

if (skipped.length > 0) {
  console.error(`\n${skipped.length} 个模型未完成，已排除出评分：${skipped.map((s) => s.modelId).join(', ')}`);
  process.exitCode = 1;
}

if (!isWorker) {
  console.log(`\n${leaderboard(scores)}\n`);
  console.log(`报告目录: ${outDir}`);
}
