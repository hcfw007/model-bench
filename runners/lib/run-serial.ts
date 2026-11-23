/**
 * 串行执行：模型按声明顺序，每个模型内 case 顺序不变。
 * 这是默认路径，也是并行模式下每个子进程走的路径，判分逻辑完全相同。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveModelRef, type BenchConfig, type ModelSpec } from './config.ts';
import { requireSafeExecution, runCase, type CaseDef, type CaseResult } from './runner.ts';

export interface SerialSlot {
  readonly modelId?: string;
  readonly caseId: string;
  readonly repeatIndex: number;
}

interface SerialRunOptions {
  cfg: BenchConfig;
  casesRoot: string;
  cases: CaseDef[];
  specs: ModelSpec[];
  repeat: number;
  outDir: string;
  slots?: readonly SerialSlot[];
}

function selectSlots(opts: SerialRunOptions): ReadonlySet<string> | undefined {
  const { cases, specs, repeat, slots } = opts;
  if (!Number.isSafeInteger(repeat) || repeat < 1) throw new Error('repeat must be a positive integer');
  const modelIds = new Set(specs.map(({ id }) => id));
  const caseIds = new Set(cases.map(({ id }) => id));
  if (modelIds.size !== specs.length || caseIds.size !== cases.length) {
    throw new Error('serial model IDs and case IDs must be unique');
  }
  if (slots === undefined) return undefined;
  const keys = new Set<string>();
  for (const { modelId, caseId, repeatIndex } of slots) {
    const model = modelId === undefined && specs.length === 1 ? specs[0].id : modelId;
    if (!model || !modelIds.has(model)) throw new Error(`invalid slot modelId: ${modelId ?? '(omitted)'}`);
    if (!caseIds.has(caseId)) throw new Error(`invalid slot caseId: ${caseId}`);
    if (!Number.isSafeInteger(repeatIndex) || repeatIndex < 0 || repeatIndex >= repeat) {
      throw new Error(`invalid slot repeatIndex: ${repeatIndex}`);
    }
    const key = JSON.stringify([model, caseId, repeatIndex]);
    if (keys.has(key)) throw new Error(`duplicate slot: ${key}`);
    keys.add(key);
  }
  return keys;
}

export function runSerialModels(opts: SerialRunOptions): CaseResult[] {
  const { cfg, casesRoot, cases, specs, repeat, outDir } = opts;
  const selected = selectSlots(opts);
  const total = selected?.size ?? specs.length * cases.length * repeat;
  if (total === 0) return [];
  requireSafeExecution();
  mkdirSync(outDir, { recursive: true });

  const results: CaseResult[] = [];
  let done = 0;

  for (const spec of specs) {
    let modelRef: string | undefined;
    for (let r = 0; r < repeat; r++) {
      for (const c of cases) {
        if (selected && !selected.has(JSON.stringify([spec.id, c.id, r]))) continue;
        modelRef ??= resolveModelRef(spec.model) + (spec.variant ? `#${spec.variant}` : '');
        done += 1;
        process.stdout.write(`[${done}/${total}] ${spec.id} ${c.id} ... `);
        const res = runCase({ cfg, casesRoot, caseDef: c, modelId: spec.id, modelRef, idx: r });
        results.push(res);
        process.stdout.write(`${res.outcome.toUpperCase()} (${res.turns}轮 ${res.durationSec}s)\n`);
        writeFileSync(resolve(outDir, 'results.partial.json'), JSON.stringify(results, null, 2));
      }
    }
  }
  return results;
}
