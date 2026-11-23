import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, type ModelSpec } from './lib/config.ts';
import { loadCases, type CaseDef } from './lib/runner.ts';
import { runSerialModels } from './lib/run-serial.ts';
import { runParallelModels } from './lib/run-parallel.ts';
import { writeFinalReports } from './lib/report.ts';
import { leaderboard } from './lib/score.ts';
import { digestOf, expectedSlots, FORMAL_CONCURRENCY, FORMAL_REPEAT, type BenchMode, type ProtocolLock } from './lib/protocol.ts';
import { freezeProtocol, resolveIdentities, verifyWorkerInputs } from './lib/protocol-freeze.ts';
import { readRunResults } from './lib/report.ts';
import { makeRepairPlan, type RunResults } from './lib/protocol-results.ts';
import { validateFormal } from './lib/protocol-validate.ts';
import { assertMockRepoClean, mockRepoHead, mockRepoMain, normalizeWorkerConfig } from './lib/worker.ts';
import { contentDigest } from './lib/protocol-release.ts';

const SUPPORTED = new Set([
  'cmd', 'diffFiles', 'diffLines', 'diffAddedText', 'fileContains', 'fileNotContains',
  'turns', 'toolCalls', 'toolErrors', 'toolSequence', 'subagents', 'nestedAgents',
  'compactionSurvived', 'modelSwitches', 'timeout', 'tokens',
  'singleLeaderFanout', 'stuckSubagentIntervention',
  'textMatch', 'exactText', 'textRatioCJK', 'noForbidden',
  'noEditsAfterTurn', 'noToolErrorMatching', 'textMatchRegex', 'shellCommandMatches',
  'scenario', 'toolOrder', 'autoTagConclusion', 'testReport', 'reviewHandoff',
]);

const args = process.argv.slice(2);
const booleanFlags = new Set(['--dry-run', '--lock-only']);
const valueFlags = new Set(['--mode', '--repair', '--layers', '--cases', '--models', '--repeat', '--concurrency', '--out']);
const usedFlags = new Set<string>();
for (let index = 0; index < args.length; index += 1) {
  const flag = args[index];
  if (usedFlags.has(flag) || (!booleanFlags.has(flag) && !valueFlags.has(flag))) throw new Error(`无效或重复参数: ${flag}`);
  usedFlags.add(flag);
  if (valueFlags.has(flag)) {
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${flag} 缺少值`);
  }
}
function arg(name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const value = args[i + 1];
  if (!value || value.startsWith('--')) throw new Error(`--${name} 缺少值`);
  return value;
}
function list(name: string, fallback: string): string[] {
  return arg(name, fallback).split(',').map((s) => s.trim()).filter(Boolean);
}

const root = resolve(import.meta.dirname, '..');
const configPath = resolve(root, 'bench.config.jsonc');
const cfg = loadConfig(configPath);
const casesRoot = resolve(root, 'cases');
const isWorker = process.env.OPENCODE_BENCH_WORKER === '1';

function runWorker(): void {
  if (process.getuid?.() === 0 || process.geteuid?.() === 0) throw new Error('worker 不允许以 root 执行');
  const lock = JSON.parse(readFileSync(resolve(root, 'protocol.lock.json'), 'utf8')) as ProtocolLock;
  verifyWorkerInputs(root, cfg.bench.opencodeBin, lock);
  if (lock.manifest.mockRepoCommit !== mockRepoHead(cfg.bench.mockRepo)) throw new Error('worker 测试床提交不符');
  const model = lock.models.find(({ id }) => id === arg('models', ''));
  if (!model) throw new Error('worker 未选中锁定模型');
  const layers = [...new Set(lock.manifest.cases.map(({ layer }) => layer))];
  const available = new Map(loadCases(casesRoot, layers, []).map((caseDef) => [caseDef.id, caseDef]));
  const cases = lock.manifest.cases.map(({ id }) => {
    const caseDef = available.get(id);
    if (!caseDef) throw new Error(`worker 缺少用例 ${id}`);
    return lock.manifest.mode === 'formal' ? { ...caseDef, worktree: true } : caseDef;
  });
  runSerialModels({
    cfg, casesRoot, cases, specs: [model], repeat: lock.manifest.repeat,
    slots: expectedSlots(lock).filter(({ modelId }) => modelId === model.id),
    outDir: resolve(root, arg('out', 'out')),
  });
}

if (isWorker) {
  runWorker();
  process.exit(0);
}

const modeArg = arg('mode', 'trial');
if (modeArg !== 'trial' && modeArg !== 'formal') throw new Error('--mode 必须是 trial 或 formal');
const mode: BenchMode = modeArg;
const repairPath = arg('repair', '');
if (repairPath && (mode !== 'formal' || ['models', 'cases', 'layers'].some((name) => args.includes(`--${name}`)))) {
  throw new Error('补槽要求 --mode formal，模型/用例由主运行确定');
}
const base = repairPath ? readRunResults(resolve(root, repairPath)) : undefined;
const repair = base && makeRepairPlan(base);
const layers = list('layers', Object.keys(cfg.layers).filter((k) => cfg.layers[k]).join(','));
const only = list('cases', '');
if (mode === 'formal' && (args.includes('--layers') || args.includes('--cases'))) throw new Error('正式运行不能筛选用例');
const requested = [...new Set(repair
  ? base!.protocol.models.filter(({ id }) => repair.slots.some(({ modelId }) => modelId === id)).map(({ id }) => id)
  : list('models', cfg.models.map((m) => m.id).join(',')))];
const repeat = Number(arg('repeat', String(mode === 'formal' ? FORMAL_REPEAT : cfg.run.repeat)));
const dryRun = args.includes('--dry-run');
const concurrency = Number(arg('concurrency', String(mode === 'formal' ? FORMAL_CONCURRENCY : cfg.run.concurrency)));
if (![repeat, concurrency].every((value) => Number.isSafeInteger(value) && value > 0)) throw new Error('重复次数和并发必须为正整数');

const cases: CaseDef[] = loadCases(casesRoot, layers, only);
if (cases.length === 0) {
  console.error('没有匹配的 case。');
  process.exit(1);
}

const specs: ModelSpec[] = [];
for (const id of requested) {
  const spec = cfg.models.find((m) => m.id === id);
  if (spec) specs.push(spec);
  else throw new Error(`未知模型: ${id}`);
}

if (mode === 'formal') validateFormal({
  benchmarkVersion: cfg.bench.version, repeat, concurrency, weights: cfg.weights,
  cases: cases.map((c) => ({ id: c.id, layer: c.layer, weight: c.weight ?? 1, timeoutSec: c.timeoutSec ?? cfg.run.timeoutSec })),
  handoff: cfg.run.switchModel && cfg.run.switchFallback
    ? { primary: cfg.run.switchModel, fallback: cfg.run.switchFallback } : undefined,
}, resolveIdentities(specs));
if (base && digestOf(resolveIdentities(specs)) !== digestOf(base.protocol.models.filter(({ id }) => requested.includes(id)))) {
  throw new Error('当前模型身份或档位与主运行不一致');
}
const unsupported = cases.flatMap((caseDef) => caseDef.assertions
  .filter(({ type }) => !SUPPORTED.has(String(type))).map(({ type }) => `${caseDef.id}/${String(type)}`));
if (!dryRun && unsupported.length > 0) throw new Error(`不支持的断言: ${unsupported.join(', ')}`);
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
  console.log(`  模式: ${mode}；预计执行 ${repair?.slots.length ?? specs.length * cases.length * repeat} 个用例槽位`);
  console.log(`  并发: ${concurrency}${concurrency === 1 ? '（串行）' : '（每模型独立克隆 mockrepo）'}`);
  console.log(bad === 0 ? '\n  ✓ 所有断言类型可执行\n' : `\n  ✗ ${bad} 个 case 有问题\n`);
  process.exit(bad === 0 ? 0 : 1);
}

if (process.getuid?.() === 0 || process.geteuid?.() === 0) throw new Error('run-bench 不允许以 root 执行');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = resolve(root, arg('out', `reports/${mode}/${stamp}`));
if (existsSync(resolve(outDir, 'results.json')) || existsSync(resolve(outDir, 'protocol.lock.json'))) throw new Error('输出目录已有运行记录');

function writeLocalLock(): ProtocolLock {
  assertMockRepoClean(cfg.bench.mockRepo);
  const lock = freezeProtocol({
    root, mockRepoCommit: mockRepoMain(cfg.bench.mockRepo), mode, concurrency, repeat, layers, only,
    models: resolveIdentities(specs), normalizedConfig: normalizeWorkerConfig(configPath),
  });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'protocol.lock.json'), `${JSON.stringify(lock, null, 2)}\n`, { flag: 'wx' });
  return lock;
}

if (args.includes('--lock-only')) {
  if (repair) throw new Error('--lock-only 不接受补槽参数');
  const lock = writeLocalLock();
  console.log(`冻结内容摘要: ${contentDigest(lock)}\n锁清单: ${resolve(outDir, 'protocol.lock.json')}`);
  process.exit(0);
}

function runSerialTrial(): RunResults {
  const protocol = writeLocalLock();
  const startedAt = new Date();
  const results = runSerialModels({ cfg, casesRoot, cases, specs: [...protocol.models], repeat, outDir });
  const finishedAt = new Date();
  verifyWorkerInputs(root, cfg.bench.opencodeBin, protocol, normalizeWorkerConfig(configPath));
  if (mockRepoMain(cfg.bench.mockRepo) !== protocol.manifest.mockRepoCommit) throw new Error('串行测试床提交在试跑期间变化');
  return { protocol, config: cfg, results, meta: {
    mode: 'serial', concurrency, mockRepoCommit: protocol.manifest.mockRepoCommit,
    startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(),
    wallSec: Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000),
    workers: specs.map(({ id: modelId }) => ({ modelId, status: 'complete' })),
  } };
}

console.log(`${mode}｜并发 ${concurrency}｜模型 ${specs.length} 个｜${repair?.slots.length ?? specs.length * cases.length * repeat} 个用例槽位`);
const outcome = concurrency === 1 ? runSerialTrial() : { config: cfg, ...await runParallelModels({
  cfg, configPath, repoRoot: root, cases, specs, repeat, concurrency, layers, only, outDir, mode,
  repair, expectedDigest: base?.protocol.digest,
}) };
const { scores, excluded } = writeFinalReports(outDir, outcome);
if (outcome.meta.workers.some(({ status }) => status !== 'complete')
  || outcome.results.some(({ outcome: result }) => result === 'error' || result === 'missing_evidence')) process.exitCode = 1;
if (excluded.length > 0) console.error(`\n未入排行：${excluded.map(({ modelId, reason }) => `${modelId} (${reason})`).join(', ')}`);
console.log(`\n${leaderboard(scores)}\n报告目录: ${outDir}`);
