import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, resolveModelRef } from './lib/config.ts';
import { loadCases, runCase, type CaseDef } from './lib/runner.ts';
import { failureReport, leaderboard, scoreModel, type CaseResult } from './lib/score.ts';

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
const cfg = loadConfig(resolve(root, 'bench.config.jsonc'));
const layers = list('layers', Object.keys(cfg.layers).filter((k) => cfg.layers[k]).join(','));
const only = list('cases', '');
const modelIds = list('models', cfg.models.map((m) => m.id).join(','));
const repeat = Number(arg('repeat', String(cfg.run.repeat)));
const dryRun = args.includes('--dry-run');

const casesRoot = resolve(root, 'cases');
const cases: CaseDef[] = loadCases(casesRoot, layers, only);

if (cases.length === 0) {
  console.error('没有匹配的 case。');
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
  console.log(`\n  模型: ${modelIds.join(', ')}`);
  console.log(`  预计执行: ${modelIds.length * cases.length * repeat} 次会话`);
  console.log(bad === 0 ? '\n  ✓ 所有断言类型可执行\n' : `\n  ✗ ${bad} 个 case 有问题\n`);
  process.exit(bad === 0 ? 0 : 1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = resolve(root, arg('out', `reports/${stamp}`));
mkdirSync(outDir, { recursive: true });

const results: CaseResult[] = [];
const total = modelIds.length * cases.length * repeat;
let done = 0;

for (const modelId of modelIds) {
  const spec = cfg.models.find((m) => m.id === modelId);
  if (!spec) {
    console.error(`跳过未知模型: ${modelId}`);
    continue;
  }
  const modelRef = resolveModelRef(spec.model) + (spec.variant ? `#${spec.variant}` : '');
  for (let r = 0; r < repeat; r++) {
    for (const c of cases) {
      done += 1;
      process.stdout.write(`[${done}/${total}] ${modelId} ${c.id} ... `);
      try {
        const res = runCase({ cfg, casesRoot, caseDef: c, modelId, modelRef, idx: r });
        results.push(res);
        console.log(`${res.pass ? 'PASS' : 'FAIL'} (${res.turns}轮 ${res.durationSec}s)`);
      } catch (e) {
        console.log(`ERROR ${(e as Error).message}`);
        results.push({
          caseId: c.id, layer: c.layer, modelId, pass: false, violation: false,
          weight: c.weight ?? 1, turns: 0, tokensInput: 0, tokensOutput: 0, durationSec: 0,
          toolErrors: {}, assertions: [], error: (e as Error).message,
        });
      }
      writeFileSync(resolve(outDir, 'results.partial.json'), JSON.stringify(results, null, 2));
    }
  }
}

const scores = modelIds.map((id) => scoreModel(id, results, cfg.weights));
writeFileSync(resolve(outDir, 'results.json'), JSON.stringify({ config: cfg, scores, results }, null, 2));
writeFileSync(resolve(outDir, 'leaderboard.md'), `# Leaderboard\n\n\`\`\`\n${leaderboard(scores)}\n\`\`\`\n`);
writeFileSync(resolve(outDir, 'failures.md'), failureReport(results));

console.log(`\n${leaderboard(scores)}\n`);
console.log(`报告目录: ${outDir}`);
