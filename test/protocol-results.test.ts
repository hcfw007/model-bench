/** protocol-results.ts：运行一致性校验、补槽计划与合并、入排行/发布口径。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { digestOf } from '../runners/lib/protocol.ts';
import {
  makeRepairPlan, mergeRepair, publicationScores, scoresForRun, validateResults,
} from '../runners/lib/protocol-results.ts';
import type { CaseResult } from '../runners/lib/score.ts';

import { faultyRun, formalRun, repairOverlay, resultsDigest, setOutcome, trialRun } from './helpers/fixtures.ts';

test('validateResults：trial 与 formal 夹具都自洽', () => {
  assert.doesNotThrow(() => validateResults(trialRun()));
  assert.doesNotThrow(() => validateResults(formalRun()));
});

test('validateResults：运行记录与协议清单交叉校验', () => {
  const base = formalRun();
  const cases: Array<[string, ReturnType<typeof formalRun>]> = [
    ['config.bench.version', { ...base, config: { ...base.config, bench: { ...base.config.bench, version: '1.0.0' } } }],
    ['config.weights', { ...base, config: { ...base.config, weights: { ...base.config.weights, l0: 9 } } }],
    ['meta.concurrency', { ...base, meta: { ...base.meta, concurrency: 3 } }],
    ['meta.mockRepoCommit', { ...base, meta: { ...base.meta, mockRepoCommit: 'b'.repeat(40) } }],
    ['meta.mode', { ...base, meta: { ...base.meta, mode: 'serial' } }],
    ['meta.workers', { ...base, meta: { ...base.meta, workers: [] } }],
  ];
  for (const [label, broken] of cases) {
    assert.throws(() => validateResults(broken), /运行记录与协议清单不一致/, label);
  }
});

test('validateResults：接棒配置必须与锁定映射一致', () => {
  const base = formalRun();
  const broken = { ...base, config: { ...base.config, run: { ...base.config.run, switchModel: 'bench/b#high' } } };
  assert.throws(() => validateResults(broken), /运行接棒配置与锁定映射不一致/);
});

test('makeRepairPlan：只选 error / missing_evidence 槽位，摘要即基线', () => {
  const base = faultyRun();
  const plan = makeRepairPlan(base);
  assert.equal(plan.baseDigest, resultsDigest(base));
  assert.deepEqual(
    plan.slots.map(({ modelId, caseId, repeatIndex }) => [modelId, caseId, repeatIndex]),
    [['bench/a', 'l1-01', 0], ['bench/b', 'l2-01', 1]],
  );
});

test('makeRepairPlan：仅接受带故障槽位的正式主运行', () => {
  assert.throws(() => makeRepairPlan(trialRun()), /补槽只接受正式主运行/);
  assert.throws(() => makeRepairPlan(formalRun()), /没有可补跑的故障槽位/);
  assert.throws(() => makeRepairPlan(repairOverlay(faultyRun())), /补槽只接受正式主运行/);
});

test('mergeRepair：只替换故障槽位，其余结果原样保留并留痕', () => {
  const base = faultyRun();
  const overlay = repairOverlay(base);
  const merged = mergeRepair(base, overlay);
  assert.doesNotThrow(() => validateResults(merged));
  assert.equal(merged.repairs?.length, 2);
  for (const attempt of merged.repairs ?? []) {
    const before = base.results.find((row) => row.caseId === attempt.previous.caseId
      && row.modelId === attempt.previous.modelId && row.repeatIndex === attempt.previous.repeatIndex);
    assert.deepEqual(attempt.previous, before);
    assert.equal(attempt.replacement.outcome, 'pass');
    assert.equal(attempt.runId, 'repair-run');
    assert.equal(attempt.baseDigest, resultsDigest(base));
  }
  const replaced = merged.results.filter((row) => row.outcome === 'pass').length;
  assert.equal(replaced, base.results.filter((row) => row.outcome === 'pass').length + 2);
});

test('mergeRepair：只接受同协议同基线的补槽产物', () => {
  const base = faultyRun();
  const overlay = repairOverlay(base);

  const noPlan = { ...base, protocol: { ...base.protocol, runId: 'other-run' } };
  assert.throws(() => mergeRepair(base, noPlan), /补槽产物不是此基线的同协议运行/);

  const sameRun = { ...overlay, protocol: { ...overlay.protocol, runId: base.protocol.runId } };
  assert.throws(() => mergeRepair(base, sameRun), /补槽产物不是此基线的同协议运行/);

  const manifest = { ...overlay.protocol.manifest, opencodeVersion: '2.1' };
  const otherDigest = { ...overlay, protocol: { ...overlay.protocol, manifest, digest: digestOf(manifest) } };
  assert.throws(() => mergeRepair(base, otherDigest), /补槽产物不是此基线的同协议运行/);

  const reversed = {
    ...overlay,
    protocol: { ...overlay.protocol, models: [...overlay.protocol.models].reverse() },
  };
  assert.throws(() => mergeRepair(base, reversed), /补槽模型身份或档位变化/);
});

test('mergeRepair：不能覆盖已判定槽位', () => {
  const base = faultyRun();
  const overlay = repairOverlay(base);
  const extra = base.results.find((row) => row.modelId === 'bench/a' && row.caseId === 'l0-01' && row.repeatIndex === 0)!;
  const greedy = {
    ...overlay,
    protocol: {
      ...overlay.protocol,
      repair: {
        baseDigest: overlay.protocol.repair!.baseDigest,
        slots: [...overlay.protocol.repair!.slots, { modelId: extra.modelId, caseId: extra.caseId, repeatIndex: extra.repeatIndex! }],
      },
    },
    results: [...overlay.results, extra],
  };
  assert.throws(() => mergeRepair(base, greedy), /不能覆盖已判定槽位/);
});

test('mergeRepair：合并结果的补槽历史被篡改则校验失败', () => {
  const base = faultyRun();
  const merged = mergeRepair(base, repairOverlay(base));
  const attempts = [...(merged.repairs ?? [])];
  const incoherent = {
    ...merged,
    repairs: attempts.map((attempt, index) => (index === 0 ? { ...attempt, sourceDigest: 'b'.repeat(64) } : attempt)),
  };
  assert.throws(() => validateResults(incoherent), /补槽历史不连贯/);
  const wrongBaseline = {
    ...merged,
    repairs: attempts.map((attempt, index) =>
      (index === 0 ? { ...attempt, previous: { ...attempt.previous, turns: 99 } as CaseResult } : attempt)),
  };
  assert.throws(() => validateResults(wrongBaseline), /补槽前基线摘要不一致/);
});

test('scoresForRun：违规失格、待补槽位与补槽运行不单独计分', () => {
  const violated = formalRun((row) => (row.modelId === 'bench/a' ? setOutcome(row, 'violation') : row));
  const withViolation = scoresForRun(violated);
  assert.deepEqual(withViolation.excluded, [{ modelId: 'bench/a', reason: '确认全局违规，失格' }]);
  assert.deepEqual(withViolation.scores.map(({ modelId }) => modelId), ['bench/b']);

  const pending = scoresForRun(faultyRun());
  assert.deepEqual(pending.excluded.map(({ modelId, reason }) => [modelId, reason]), [
    ['bench/a', '1 个故障槽位待补'],
    ['bench/b', '1 个故障槽位待补'],
  ]);
  assert.equal(pending.scores.length, 0);

  const repaired = scoresForRun(repairOverlay(faultyRun()));
  assert.deepEqual(repaired.excluded.map(({ reason }) => reason), ['补槽运行不单独计分', '补槽运行不单独计分']);

  const clean = scoresForRun(formalRun());
  assert.equal(clean.excluded.length, 0);
  assert.equal(clean.scores.length, 2);
  assert.ok(clean.scores[0].exactTotal !== undefined);
});

test('publicationScores：只发布无故障的正式主运行', () => {
  assert.doesNotThrow(() => publicationScores(formalRun()));
  assert.throws(() => publicationScores(trialRun()), /只发布正式主运行/);
  assert.throws(() => publicationScores(repairOverlay(faultyRun())), /只发布正式主运行/);
  assert.throws(() => publicationScores(faultyRun()), /仍有未解决故障或不完整结果，拒绝发布/);
  const allViolated = formalRun((row) => setOutcome(row, 'violation'));
  assert.throws(() => publicationScores(allViolated), /没有合格模型，拒绝发布/);
});
