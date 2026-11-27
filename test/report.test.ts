/** report.ts：结果读入、运行锁校验、v1.1 报告渲染与落盘产物。 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { assertRunLock, readRunResults, renderRunReport, writeFinalReports } from '../runners/lib/report.ts';
import { mergeRepair } from '../runners/lib/protocol-results.ts';

import { formalRun, faultyRun, repairOverlay, setOutcome, trialRun, writeRun } from './helpers/fixtures.ts';

function tempRunDir(): string {
  return mkdtempSync(join(tmpdir(), 'model-bench-report-'));
}

test('assertRunLock：协议锁一致放行，不一致拒绝', () => {
  const dir = tempRunDir();
  const run = formalRun();
  writeRun(dir, run);
  assert.doesNotThrow(() => assertRunLock(dir, run));
  assert.throws(
    () => assertRunLock(dir, { ...run, protocol: { ...run.protocol, runId: 'tampered' } }),
    /结果协议与运行前锁清单不一致/,
  );
});

test('readRunResults：缺 v1.1 协议记录的旧榜只读', () => {
  const dir = tempRunDir();
  writeRun(dir, trialRun());
  assert.doesNotThrow(() => readRunResults(dir));
  writeFileSync(resolve(dir, 'results.json'), JSON.stringify({ config: {}, results: [] }));
  assert.throws(() => readRunResults(dir), /旧榜只读：缺少 v1\.1 协议记录/);
});

test('renderRunReport：标题、协议摘要、模型档位与逐题结果', () => {
  const run = formalRun((row) =>
    (row.modelId === 'bench/a' && row.caseId === 'l1-01' && row.repeatIndex === 0 ? setOutcome(row, 'timeout') : row));
  const text = renderRunReport(run);
  assert.ok(text.startsWith('# v1.1.0 formal\n'));
  assert.ok(text.includes(`协议摘要：\`${run.protocol.digest}\` · 运行：\`base-run\``));
  assert.ok(text.includes('OpenCode 2.0'));
  assert.ok(text.includes('33 题 · 重复 3 · 并发 5'));
  assert.ok(text.includes('`bench/a=bench/a#high`'));
  assert.ok(text.includes('## 逐题结果'));
  assert.ok(text.includes('| bench/a | l1-01 | 2/3 | 1 | 3 | 30 | 60 | 3.0 | 0:timeout, 1:pass, 2:pass |'));
  assert.ok(text.includes('补槽历史：0 条'));
});

test('renderRunReport：违规失格列入未入排行，补槽运行标注历史', () => {
  const violated = formalRun((row) => (row.modelId === 'bench/a' ? setOutcome(row, 'violation') : row));
  assert.ok(renderRunReport(violated).includes('- 未入排行：`bench/a` 确认全局违规，失格'));

  const base = faultyRun();
  const text = renderRunReport(mergeRepair(base, repairOverlay(base)));
  assert.ok(text.includes('# v1.1.0 formal'));
  assert.ok(text.includes('补槽历史：2 条'));
});

test('writeFinalReports：产出 summary / leaderboard / failures / incomplete 并回写 scores', () => {
  const dir = tempRunDir();
  const base = faultyRun();
  writeRun(dir, base);
  const merged = mergeRepair(base, repairOverlay(base));
  const { excluded } = writeFinalReports(dir, merged);
  assert.equal(excluded.length, 0);
  for (const name of ['summary.md', 'leaderboard.md', 'failures.md', 'incomplete.md', 'results.json']) {
    assert.ok(existsSync(resolve(dir, name)), name);
  }
  assert.ok(readFileSync(resolve(dir, 'leaderboard.md'), 'utf8').includes('# formal Leaderboard'));
  assert.ok(readFileSync(resolve(dir, 'failures.md'), 'utf8').includes('# 失败明细'));
  const written = JSON.parse(readFileSync(resolve(dir, 'results.json'), 'utf8')) as { scores: unknown[]; repairs: unknown[] };
  assert.equal(written.scores.length, 2);
  assert.equal(written.repairs.length, 2);
});

test('writeFinalReports：不完整模型写入 incomplete.md', () => {
  const dir = tempRunDir();
  const violated = formalRun((row) => (row.modelId === 'bench/a' ? setOutcome(row, 'violation') : row));
  writeRun(dir, violated);
  const { excluded } = writeFinalReports(dir, violated);
  assert.deepEqual(excluded.map(({ modelId }) => modelId), ['bench/a']);
  assert.ok(readFileSync(resolve(dir, 'incomplete.md'), 'utf8').includes('`bench/a`：确认全局违规，失格'));
});
