/** parallel.ts：分区校验、合并顺序、不完整模型归因。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkPartition, incompleteReasons, orderResults } from '../runners/lib/parallel.ts';
import type { CaseResult } from '../runners/lib/score.ts';

function row(over: Partial<CaseResult> = {}): CaseResult {
  return {
    caseId: 'l0-01', layer: 'l0', modelId: 'bench/a', pass: true, violation: false,
    weight: 1, turns: 1, tokensInput: 1, tokensOutput: 1, durationSec: 1,
    toolErrors: {}, assertions: [], ...over,
  };
}

function complete(modelId: string, caseIds: string[], repeat: number): CaseResult[] {
  return Array.from({ length: repeat }, (_, repeatIndex) =>
    caseIds.map((caseId) => row({ modelId, caseId, repeatIndex }))).flat();
}

test('checkPartition：完整分区通过', () => {
  assert.deepEqual(checkPartition('bench/a', complete('bench/a', ['l0-01', 'l0-02'], 2), ['l0-01', 'l0-02'], 2), { ok: true });
});

test('checkPartition：无索引模式按出现次数核对', () => {
  const rows = [row(), row({ caseId: 'l0-02' })];
  assert.deepEqual(checkPartition('bench/a', rows, ['l0-01', 'l0-02'], 1), { ok: true });
});

test('checkPartition：用例清单重复直接拒绝', () => {
  const result = checkPartition('bench/a', [], ['l0-01', 'l0-01'], 1);
  assert.deepEqual(result, { ok: false, error: '用例重复: l0-01' });
});

test('checkPartition：混入其他模型拒绝', () => {
  const result = checkPartition('bench/a', [row({ modelId: 'bench/b' })], ['l0-01'], 1);
  assert.deepEqual(result, { ok: false, error: '结果含其他模型: bench/b' });
});

test('checkPartition：未执行用例拒绝', () => {
  const result = checkPartition('bench/a', [row({ caseId: 'l9-09' })], ['l0-01'], 1);
  assert.deepEqual(result, { ok: false, error: '结果含未执行用例: l9-09' });
});

test('checkPartition：无效重复编号拒绝', () => {
  const tooBig = checkPartition('bench/a', [row({ repeatIndex: 2 })], ['l0-01'], 2);
  assert.deepEqual(tooBig, { ok: false, error: '无效重复编号: l0-01/2' });
  const mixed = checkPartition('bench/a', [row({ repeatIndex: 0 }), row({ repeatIndex: undefined })], ['l0-01'], 1);
  assert.deepEqual(mixed, { ok: false, error: '无效重复编号: l0-01/undefined' });
});

test('checkPartition：槽位重复与用例超量分别拒绝', () => {
  const dupSlot = checkPartition('bench/a', [row({ repeatIndex: 0 }), row({ repeatIndex: 0 })], ['l0-01'], 2);
  assert.deepEqual(dupSlot, { ok: false, error: '结果槽位重复: ["bench/a","l0-01",0]' });
  const overflow = checkPartition('bench/a', [row(), row(), row()], ['l0-01'], 2);
  assert.deepEqual(overflow, { ok: false, error: '用例结果重复: l0-01' });
});

test('checkPartition：缺结果拒绝', () => {
  const result = checkPartition('bench/a', complete('bench/a', ['l0-01'], 2), ['l0-01', 'l0-02'], 2);
  assert.deepEqual(result, { ok: false, error: '缺少结果: l0-02' });
});

test('orderResults：按模型 → 轮次 → 用例合并', () => {
  const a0 = row({ caseId: 'l0-01', repeatIndex: 0 });
  const a1 = row({ caseId: 'l0-01', repeatIndex: 1 });
  const b0 = row({ caseId: 'l0-02', repeatIndex: 0 });
  const parts = new Map([
    ['bench/b', [b0]],
    ['bench/a', [a1, a0]],
  ]);
  const merged = orderResults(['bench/a', 'bench/b'], ['l0-01', 'l0-02'], 2, parts);
  assert.deepEqual(merged, [
    a0, // bench/a 轮 0 / l0-01
    // l0-02 缺行跳过
    a1, // bench/a 轮 1 / l0-01
    b0, // bench/b 轮 0 / l0-02
  ]);
});

test('orderResults：无索引模式按出现顺序取第 i 条，缺行不补齐', () => {
  const first = row({ caseId: 'l0-01' });
  const second = row({ caseId: 'l0-01', turns: 2 });
  const merged = orderResults(['bench/a'], ['l0-01'], 3, new Map([['bench/a', [first, second]]]));
  assert.deepEqual(merged, [first, second]);
});

test('incompleteReasons：缺失与显式失败的模型都归因，完整模型不列', () => {
  const reasons = incompleteReasons(
    ['bench/a', 'bench/b', 'bench/c'],
    new Map([['bench/a', [row()]]]),
    new Map([['bench/b', 'worker exit 1']]),
  );
  assert.deepEqual(reasons, [
    { modelId: 'bench/b', reason: 'worker exit 1' },
    { modelId: 'bench/c', reason: '无结果' },
  ]);
});
