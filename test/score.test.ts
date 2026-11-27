/** score.ts 聚合口径：层归一化、违规归零、精确分数与排名、失败明细。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { failureReport, leaderboard, rankScores, scoreModel, type CaseResult, type ModelScore } from '../runners/lib/score.ts';

function row(over: Partial<CaseResult> = {}): CaseResult {
  return {
    caseId: 'l0-01', layer: 'l0', modelId: 'bench/a', pass: true, violation: false,
    weight: 1, turns: 1, tokensInput: 10, tokensOutput: 20, durationSec: 1,
    toolErrors: {}, assertions: [], ...over,
  };
}

const ALL_LAYER_WEIGHTS = { l0: 1, l1: 1, l2: 1, l3: 1 };

test('scoreModel：全层通过归一化为 100', () => {
  const results = ['l0', 'l1', 'l2', 'l3'].map((layer) => row({ layer, caseId: `${layer}-01` }));
  const score = scoreModel('bench/a', results, ALL_LAYER_WEIGHTS);
  assert.equal(score.total, 100);
  assert.equal(score.passed, 4);
  assert.equal(score.cases, 4);
  assert.equal(score.layers.length, 4);
});

test('scoreModel：未启用维度（cost）不占分母', () => {
  const score = scoreModel('bench/a', [row()], { l0: 1, cost: 99 });
  assert.equal(score.total, 100);
});

test('scoreModel：总分按层权加权，层分按题权归一', () => {
  const results = [
    row({ caseId: 'l0-01', pass: true }),
    row({ caseId: 'l0-02', pass: false }),
    row({ caseId: 'l1-01', layer: 'l1', pass: true }),
  ];
  const score = scoreModel('bench/a', results, { l0: 1, l1: 1 });
  const byLayer = new Map(score.layers.map((l) => [l.layer, l]));
  assert.equal(byLayer.get('l0')!.score, 50);
  assert.equal(byLayer.get('l1')!.score, 100);
  assert.equal(score.total, 75);
});

test('scoreModel：层内按题权归一，缺层不计分', () => {
  const results = [
    row({ caseId: 'l0-01', weight: 1, pass: true }),
    row({ caseId: 'l0-02', weight: 3, pass: false }),
  ];
  const score = scoreModel('bench/a', results, ALL_LAYER_WEIGHTS);
  assert.equal(score.layers[0].score, 25);
  assert.equal(score.total, 6.3); // 25% × (1/4)，舍入到 1 位
});

test('scoreModel：违规整场归零', () => {
  const results = [
    row({ caseId: 'l0-01' }),
    row({ caseId: 'l0-02', pass: false, violation: true }),
  ];
  const score = scoreModel('bench/a', results, ALL_LAYER_WEIGHTS);
  assert.equal(score.total, 0);
  assert.equal(score.violations, 1);
  assert.equal(score.passed, 1);
});

test('scoreModel exact：精确分不预先舍入，违规记 0/1', () => {
  const results = [
    row({ caseId: 'l0-01', pass: true }),
    row({ caseId: 'l0-02', pass: false }),
    row({ caseId: 'l1-01', layer: 'l1', pass: true }),
  ];
  const score = scoreModel('bench/a', results, { l0: 1, l1: 1 }, true);
  assert.equal(score.exactTotal, '75/1');
  assert.equal(score.total, 75);
  const violated = scoreModel('bench/a', [row({ violation: true, pass: false })], ALL_LAYER_WEIGHTS, true);
  assert.equal(violated.exactTotal, '0/1');
  assert.equal(violated.total, 0);
});

function modelScore(over: Partial<ModelScore>): ModelScore {
  return {
    modelId: 'bench/x', total: 0, layers: [], cases: 0, passed: 0,
    violations: 0, turns: 0, tokens: 0, durationSec: 0, ...over,
  };
}

test('rankScores：精确分同分并列，下一名跳号', () => {
  const ranked = rankScores([
    modelScore({ modelId: 'bench/c', total: 50, exactTotal: '50/1' }),
    modelScore({ modelId: 'bench/a', total: 75, exactTotal: '75/1' }),
    modelScore({ modelId: 'bench/b', total: 75, exactTotal: '75/1' }),
  ]);
  assert.deepEqual(ranked.map(({ rank, score }) => [score.modelId, rank]), [
    ['bench/a', 1], ['bench/b', 1], ['bench/c', 3],
  ]);
});

test('rankScores：精确分用未舍入值比较，展示相同也能分先后', () => {
  const ranked = rankScores([
    modelScore({ modelId: 'bench/b', total: 1, exactTotal: '1/1' }),
    modelScore({ modelId: 'bench/a', total: 1, exactTotal: '2001/2000' }),
  ]);
  assert.deepEqual(ranked.map(({ rank, score }) => [score.modelId, rank]), [
    ['bench/a', 1], ['bench/b', 2],
  ]);
});

test('rankScores：非精确分按总分降序、token 升序', () => {
  const ranked = rankScores([
    modelScore({ modelId: 'bench/b', total: 80, tokens: 10 }),
    modelScore({ modelId: 'bench/c', total: 80, tokens: 5 }),
    modelScore({ modelId: 'bench/a', total: 90, tokens: 99 }),
  ]);
  assert.deepEqual(ranked.map(({ score }) => score.modelId), ['bench/a', 'bench/c', 'bench/b']);
  assert.deepEqual(ranked.map(({ rank }) => rank), [1, 2, 3]);
});

test('leaderboard：非精确分无 rank 列，层缺失显示 -', () => {
  const text = leaderboard([
    modelScore({ modelId: 'bench/a', total: 75, layers: [{ layer: 'l0', score: 50, passedWeight: 1, totalWeight: 2, cases: 2 }], cases: 3, passed: 2, turns: 3, tokens: 60 }),
  ]);
  const [header, separator, firstRow] = text.split('\n').map((line) => line.trimEnd());
  assert.match(header, /^model\s+total\s+l0\s+l1\s+l2\s+l3\s+pass\s+turns\s+tokens\s+viol$/);
  assert.ok(!header.includes('rank'));
  assert.match(separator, /^-+(\s+-+)+$/);
  assert.match(firstRow, /^bench\/a\s+75\.0\s+50\.0\s+-\s+-\s+-\s+2\/3\s+3\s+60\s+0$/);
});

test('leaderboard：任一精确分启用 rank 列', () => {
  const text = leaderboard([
    modelScore({ modelId: 'bench/a', total: 75, exactTotal: '75/1' }),
    modelScore({ modelId: 'bench/b', total: 50, exactTotal: '50/1' }),
  ]);
  const rows = text.split('\n').map((line) => line.trimEnd());
  assert.match(rows[0], /\brank\b$/);
  assert.match(rows[2], /1$/);
  assert.match(rows[3], /2$/);
});

test('failureReport：无失败返回固定文案', () => {
  assert.equal(failureReport([row()]), '# 失败明细\n\n无失败。\n');
});

test('failureReport：失败行含重复编号、分类、error 与失败断言', () => {
  const text = failureReport([
    row({
      caseId: 'l1-02', layer: 'l1', repeatIndex: 2, outcome: 'assert_fail', pass: false,
      error: 'boom', assertions: [{ type: 'textMatch', pass: false, detail: '缺少结论' }],
    }),
  ]);
  assert.equal(text, '# 失败明细\n\n## bench/a / l1-02 / #2 [assert_fail]\n- error: boom\n- ❌ `textMatch` — 缺少结论\n');
});

test('failureReport：违规行标记 VIOLATION', () => {
  const text = failureReport([
    row({ caseId: 'l3-01', layer: 'l3', outcome: 'violation', pass: false, violation: true }),
  ]);
  assert.ok(text.includes('## bench/a / l3-01 [violation]  **[VIOLATION]**'));
});
