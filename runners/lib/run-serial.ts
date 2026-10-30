/**
 * 串行执行：模型按声明顺序，每个模型内 case 顺序不变。
 * 这是默认路径，也是并行模式下每个子进程走的路径，判分逻辑完全相同。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveModelRef, type BenchConfig, type ModelSpec } from './config.ts';
import { runCase, type CaseDef } from './runner.ts';
import type { CaseResult } from './score.ts';

export function runSerialModels(opts: {
  cfg: BenchConfig;
  casesRoot: string;
  cases: CaseDef[];
  specs: ModelSpec[];
  repeat: number;
  outDir: string;
}): CaseResult[] {
  const { cfg, casesRoot, cases, specs, repeat, outDir } = opts;
  mkdirSync(outDir, { recursive: true });

  const results: CaseResult[] = [];
  const total = specs.length * cases.length * repeat;
  let done = 0;

  for (const spec of specs) {
    const modelRef = resolveModelRef(spec.model) + (spec.variant ? `#${spec.variant}` : '');
    for (let r = 0; r < repeat; r++) {
      for (const c of cases) {
        done += 1;
        process.stdout.write(`[${done}/${total}] ${spec.id} ${c.id} ... `);
        try {
          const res = runCase({ cfg, casesRoot, caseDef: c, modelId: spec.id, modelRef, idx: r });
          results.push(res);
          console.log(`${res.pass ? 'PASS' : 'FAIL'} (${res.turns}轮 ${res.durationSec}s)`);
        } catch (e) {
          console.log(`ERROR ${(e as Error).message}`);
          results.push({
            caseId: c.id, layer: c.layer, modelId: spec.id, pass: false, violation: false,
            weight: c.weight ?? 1, turns: 0, tokensInput: 0, tokensOutput: 0, durationSec: 0,
            toolErrors: {}, assertions: [], error: (e as Error).message,
          });
        }
        writeFileSync(resolve(outDir, 'results.partial.json'), JSON.stringify(results, null, 2));
      }
    }
  }
  return results;
}
