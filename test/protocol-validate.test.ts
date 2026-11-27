/** protocol-validate.ts：协议清单、正式协议、结果行的校验分支。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { digestOf, type ProtocolLock, type ProtocolManifest } from '../runners/lib/protocol.ts';
import { validateFormal, validateLock, validateRows } from '../runners/lib/protocol-validate.ts';

import { formalRun, HASH, setOutcome, trialRun } from './helpers/fixtures.ts';

function withManifest(run: ReturnType<typeof trialRun>, manifest: ProtocolManifest, digest = digestOf(manifest)): ReturnType<typeof trialRun> {
  return { ...run, protocol: { ...run.protocol, manifest, digest } };
}

test('validateLock：trial 夹具完整通过', () => {
  assert.doesNotThrow(() => validateLock(trialRun().protocol));
});

test('validateLock：schema 与摘要', () => {
  const run = trialRun();
  const oldSchema = { ...run.protocol.manifest, schema: 1 } as unknown as ProtocolManifest;
  assert.throws(() => validateLock(withManifest(run, oldSchema).protocol), /不支持的协议清单 schema/);
  assert.throws(
    () => validateLock({ ...run.protocol, digest: HASH }),
    /协议清单摘要不一致/,
  );
});

test('validateLock：运行身份完整性', () => {
  const run = trialRun();
  const badPlatform = { ...run.protocol.manifest, platform: 'darwin' };
  assert.throws(() => validateLock(withManifest(run, badPlatform).protocol), /协议运行身份不完整/);
  const badCommit = { ...run.protocol.manifest, mockRepoCommit: 'deadbeef' };
  assert.throws(() => validateLock(withManifest(run, badCommit).protocol), /协议运行身份不完整/);
  const noRunId: ProtocolLock = { ...run.protocol, runId: '' };
  assert.throws(() => validateLock(noRunId), /协议运行身份不完整/);
});

test('validateLock：重复次数、输入摘要、层权、用例声明、模型身份', () => {
  const run = trialRun();
  const badRepeat = { ...run.protocol.manifest, repeat: 0 };
  assert.throws(() => validateLock(withManifest(run, badRepeat).protocol), /无效重复次数或并发/);
  const badFiles = { ...run.protocol.manifest, files: { 'bench.config.jsonc': HASH, 'runners/lib/runner.ts': HASH } };
  assert.throws(() => validateLock(withManifest(run, badFiles).protocol), /协议输入摘要不完整/);
  const badWeights = { ...run.protocol.manifest, weights: { l0: -1 } };
  assert.throws(() => validateLock(withManifest(run, badWeights).protocol), /无效层权/);
  const noCases = { ...run.protocol.manifest, cases: [] };
  assert.throws(() => validateLock(withManifest(run, noCases).protocol), /无协议用例/);
  const badCase = { ...run.protocol.manifest, cases: [{ id: 'x-01', layer: 'l0', weight: 1, timeoutSec: 1 }] };
  assert.throws(() => validateLock(withManifest(run, badCase).protocol), /无效用例声明: x-01/);
  const dupeModels: ProtocolLock = { ...run.protocol, models: [{ id: 'bench/a', model: 'bench/a' }, { id: 'bench/a', model: 'bench/a' }] };
  assert.throws(() => validateLock(dupeModels), /无效或重复模型身份/);
});

test('validateLock：接棒映射必须是两个不同的完整引用', () => {
  const run = trialRun();
  const same = withManifest(run, {
    ...run.protocol.manifest,
    handoff: { primary: 'bench/a#high', fallback: 'bench/a#high' },
  });
  assert.throws(() => validateLock(same.protocol), /接棒要求两个不同的完整 provider\/model#variant/);
});

test('validateFormal：正式夹具完整通过', () => {
  const { manifest, models } = formalRun().protocol;
  assert.doesNotThrow(() => validateFormal(manifest, models));
});

test('validateFormal：版本、重复与并发、题数、分层结构', () => {
  const { manifest, models } = formalRun().protocol;
  const check = (cases: readonly ProtocolManifest['cases'][number][], weights: Readonly<Record<string, number>> = manifest.weights) =>
    validateFormal({ ...manifest, cases, weights }, models);
  assert.throws(() => validateFormal({ ...manifest, benchmarkVersion: '1.0.0' }, models), /正式运行要求 v1\.1 配置/);
  assert.throws(() => validateFormal({ ...manifest, repeat: 1 }, models), /正式协议要求每题重复 3 次、并发 5/);
  assert.throws(() => check(manifest.cases.slice(0, 32)), /正式协议必须包含恰好 33 题/);
  const reLayered = manifest.cases.map((row) => (row.id === 'l0-01' ? { ...row, id: 'l1-99', layer: 'l1' } : row));
  assert.throws(() => check(reLayered), /l0 正式用例数必须为 7/);
  assert.throws(() => check(manifest.cases, { ...manifest.weights, l0: 9 }), /l0 正式层权不一致/);
});

test('validateFormal：L2 题权约束与 l3-08 / 接棒要求', () => {
  const { manifest, models } = formalRun().protocol;
  const reweight = (id: string, weight: number) => manifest.cases.map((row) => (row.id === id ? { ...row, weight } : row));
  assert.throws(() => validateFormal({ ...manifest, cases: reweight('l2-01', 2) }, models), /L2 正式题权合计必须为 19/);
  // l2-07 改 2 的同时把 l2-01 降回 2，保持合计 19，只暴露单题约束
  const compensated = manifest.cases.map((row) =>
    (row.id === 'l2-07' || row.id === 'l2-01' ? { ...row, weight: 2 } : row));
  assert.throws(() => validateFormal({ ...manifest, cases: compensated }, models), /l2-07 正式题权必须为 1/);
  const withoutLeader = manifest.cases.map((row) => (row.id === 'l3-08' ? { ...row, id: 'l3-99' } : row));
  assert.throws(() => validateFormal({ ...manifest, cases: withoutLeader }, models), /正式协议要求 l3-08 和显式接棒映射/);
  const lowTier = { ...manifest, handoff: { primary: 'bench/a#mid', fallback: 'bench/b#high' } };
  assert.throws(() => validateFormal(lowTier, models), /正式接棒档位必须为 high/);
  assert.throws(
    () => validateFormal(manifest, [{ id: 'bench/a', model: 'bench/a', variant: 'mid' }, models[1]]),
    /正式模型必须使用官方 provider\/model 身份和 high 档位/,
  );
});

test('validateLock：正式用例集与 suiteDigest 必须一致', () => {
  const run = formalRun();
  const manifest = { ...run.protocol.manifest, suiteDigest: HASH };
  assert.throws(() => validateLock(withManifest(run, manifest).protocol), /正式用例集与协议完整用例集不一致/);
});

test('validateRows：完整槽位通过，缺槽拒绝（allowMissing 放行）', () => {
  const run = trialRun();
  assert.doesNotThrow(() => validateRows(run.protocol, run.results));
  const dropped = run.results.slice(0, -1);
  assert.throws(() => validateRows(run.protocol, dropped), /缺少 1 个协议槽位/);
  assert.doesNotThrow(() => validateRows(run.protocol, dropped, true));
});

test('validateRows：槽位编号、重复与归属', () => {
  const run = trialRun();
  const noIndex = run.results.map((row, i) => (i === 0 ? { ...row, repeatIndex: undefined } : row));
  assert.throws(() => validateRows(run.protocol, noIndex), /结果缺少 repeatIndex/);
  const dup = run.results.map((row, i) => (i === 1 ? { ...run.results[0] } : row));
  assert.throws(() => validateRows(run.protocol, dup), /结果槽位重复或不在协议内/);
  const foreign = run.results.map((row, i) => (i === 0 ? { ...row, modelId: 'bench/zz' } : row));
  assert.throws(() => validateRows(run.protocol, foreign), /结果槽位重复或不在协议内/);
});

test('validateRows：题权、层、分类、指标一致性', () => {
  const run = trialRun();
  const wrongWeight = run.results.map((row, i) => (i === 0 ? { ...row, weight: row.weight + 1 } : row));
  assert.throws(() => validateRows(run.protocol, wrongWeight), /结果题权或层不一致/);
  const wrongClass = run.results.map((row, i) => (i === 0 ? { ...row, pass: false } : row));
  assert.throws(() => validateRows(run.protocol, wrongClass), /结果分类不一致/);
  const badMetric = run.results.map((row, i) => (i === 0 ? { ...row, turns: -1 } : row));
  assert.throws(() => validateRows(run.protocol, badMetric), /结果指标无效/);
});

test('validateRows：断言与结果分类交叉校验', () => {
  const run = trialRun();
  const passWithFail = run.results.map((row, i) =>
    (i === 0 ? { ...row, assertions: [{ type: 'textMatch', pass: false, detail: 'x' }] } : row));
  assert.throws(() => validateRows(run.protocol, passWithFail), /断言与结果分类不一致/);
  const forbiddenWithoutViolation = run.results.map((row, i) =>
    (i === 0 ? setOutcome({ ...row, assertions: [{ type: 'noForbidden', pass: false, detail: 'push' }] }, 'assert_fail') : row));
  assert.throws(() => validateRows(run.protocol, forbiddenWithoutViolation), /断言与结果分类不一致/);
  const violationWithForbidden = run.results.map((row, i) =>
    (i === 0 ? setOutcome({ ...row, assertions: [{ type: 'noForbidden', pass: false, detail: 'push' }] }, 'violation') : row));
  assert.doesNotThrow(() => validateRows(run.protocol, violationWithForbidden));
});
