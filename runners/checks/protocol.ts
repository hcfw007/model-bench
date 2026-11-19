import assert from 'node:assert/strict';

import type { BenchConfig } from '../lib/config.ts';
import { digestOf, expectedSlots, FORMAL_COUNTS, FORMAL_WEIGHTS, type ProtocolLock, type ProtocolManifest } from '../lib/protocol.ts';
import { replaceRanking } from '../lib/protocol-publish.ts';
import { makeRepairPlan, mergeRepair, publicationScores, scoresForRun, validateResults, type RunResults } from '../lib/protocol-results.ts';
import { calibrationTrialCases, CALIBRATION_GROUPS, contentDigest, ISOLATION_CHECKS, REQUIRED_MODELS,
  verifyCalibrationTrial, verifyReceipts } from '../lib/protocol-release.ts';
import { recoverWorkerRows } from '../lib/run-parallel.ts';
import { rankScores, type CaseOutcome, type CaseResult } from '../lib/score.ts';
import { deliveryProofBlocker, runIsolationPreflight } from '../lib/protocol-isolation.ts';
import type { IsolationProof } from '../lib/scenario-isolation.ts';

function preflightFor(models: ProtocolLock['models']): IsolationProof[] {
  return models.map(({ id: modelId }, index) => ({
    backend: 'rootless-podman-v1', isolationId: 'a'.repeat(64), modelId, containerId: (index + 1).toString(16).padStart(64, '0'),
    image: `example.invalid/bench@sha256:${'b'.repeat(64)}`, imageId: `sha256:${'c'.repeat(64)}`,
    program: '/opt/bin/opencode', programVersion: '2.0.0', runtimeVersion: '5.5.0', user: '1000:1000',
    ociDigest: 'd'.repeat(64),
    network: 'none', pid: 'private', ipc: 'private', capDrop: 'ALL', securityOption: 'no-new-privileges',
    mounts: [
      { source: '/tmp/probe', destination: '/work', writable: true },
      { source: `/var/model-homes/${index}`, destination: '/model-home', writable: true },
      { source: '/tmp/probe.sock', destination: '/run/model-bench-delivery.sock', writable: false },
    ],
  }));
}

function addProof(row: CaseResult, proof: IsolationProof): CaseResult {
  if (row.caseId !== 'l2-07') return row;
  return { ...row, checkpoints: [1, 2].map((turn) => ({ turn, process: { status: 'exited', exitCode: 0 }, scenario: {
    kind: 'delivery', turn, isolationRequired: true, isolation: {
      ...proof, containerId: digestOf([proof.modelId, row.repeatIndex, turn]),
    },
  } })) };
}

function fixture(): RunResults {
  const hash = 'a'.repeat(64);
  const mockRepoCommit = '0'.repeat(40);
  const cases = Object.entries(FORMAL_COUNTS).flatMap(([layer, count]) => Array.from({ length: count }, (_, index) => ({
    id: `${layer}-${String(index + 1).padStart(2, '0')}`, layer, timeoutSec: 300,
    weight: layer === 'l2' && index < 6 ? (index < 5 ? 3 : 2) : 1,
  })));
  const models = ['bench/a', 'bench/b'].map((id) => ({ id, model: id, variant: 'high' }));
  const preflight = preflightFor(models);
  const { backend, isolationId, image, imageId, program, programVersion, runtimeVersion } = preflight[0];
  const manifest: ProtocolManifest = {
    schema: 1, benchmarkVersion: '1.1.0', mode: 'formal', concurrency: 2, repeat: 3, opencodeVersion: '2.0',
    mockRepoCommit, platform: 'linux/x64',
    isolation: { backend, isolationId, image, imageId, program, programVersion, podmanVersion: runtimeVersion },
    files: { 'bench.config.jsonc': hash, 'runners/lib/runner.ts': hash, 'cases/a.json': hash },
    cases, suiteDigest: digestOf(cases),
    weights: FORMAL_WEIGHTS, handoff: { primary: 'bench/a#high', fallback: 'bench/b#high' },
  };
  const protocol: ProtocolLock = { manifest, digest: digestOf(manifest), models, preflight, runId: 'base' };
  const results = expectedSlots(protocol).map((slot): CaseResult => {
    const { layer, weight } = manifest.cases.find(({ id }) => id === slot.caseId)!;
    return addProof({
      ...slot, layer, weight, outcome: 'pass', pass: true, violation: false, turns: 1,
      tokensInput: 10, tokensOutput: 20, durationSec: 1, toolErrors: {}, assertions: [],
    }, preflight.find(({ modelId }) => modelId === slot.modelId)!);
  });
  const config = { bench: { version: '1.1.0' }, weights: FORMAL_WEIGHTS,
    run: { switchModel: manifest.handoff!.primary, switchFallback: manifest.handoff!.fallback } } as BenchConfig;
  return { config, protocol, results, meta: {
    mode: 'parallel', concurrency: 2, mockRepoCommit, startedAt: '2026-11-19',
    workers: models.map(({ id: modelId }) => ({ modelId, status: 'complete' })),
  } };
}

function setOutcome(row: CaseResult, outcome: CaseOutcome): CaseResult {
  return { ...row, outcome, pass: outcome === 'pass', violation: outcome === 'violation' };
}

function testPublication(): void {
  const base = fixture();
  assert.equal(base.results.length, 198);
  const { scores } = scoresForRun(base);
  assert.deepEqual(publicationScores(base), scores);
  assert.throws(() => validateResults({ ...base, protocol: { ...base.protocol, preflight: undefined } }), /预检不完整/);
  assert.deepEqual(rankScores(scores).map(({ rank, score }) => [rank, score.total]), [[1, 100], [1, 100]]);
  assert.deepEqual(rankScores([{ ...scores[0], total: 99.99, exactTotal: '9999/100' }, scores[1]])
    .map(({ rank, score }) => [rank, score.modelId, score.total.toFixed(1)]), [[1, 'bench/b', '100.0'], [2, 'bench/a', '100.0']]);
  assert.throws(() => validateResults({ ...base, results: [...base.results, base.results[0]] }), /重复/);
  assert.throws(() => validateResults({ ...base, results: base.results.slice(1) }), /缺少/);
  assert.throws(() => validateResults({ ...base, protocol: { ...base.protocol, digest: 'bad' } }), /摘要/);
  const trial = { ...base.protocol.manifest, mode: 'trial' } as const;
  assert.throws(() => publicationScores({ ...base, protocol: { ...base.protocol, manifest: trial, digest: digestOf(trial) } }), /只发布正式/);
  const timed = { ...base, results: [setOutcome(base.results[0], 'timeout'), ...base.results.slice(1)] };
  assert.equal(scoresForRun(timed).scores[0].passed, 98);
  assert.ok(scoresForRun(timed).scores[0].total < 100);
  assert.throws(() => makeRepairPlan(timed), /没有可补跑/);
  const violated = { ...base, results: [setOutcome(base.results[0], 'violation'), ...base.results.slice(1)] };
  assert.deepEqual(scoresForRun(violated).scores.map(({ modelId }) => modelId), ['bench/b']);
  const delivery = base.results.find(({ caseId }) => caseId === 'l2-07')!;
  const proof = base.protocol.preflight![0];
  const checkpoint = delivery.checkpoints![0] as Record<string, unknown>;
  assert.match(deliveryProofBlocker({ ...delivery, checkpoints: [checkpoint] }, proof)!, /证明数量/);
  assert.match(deliveryProofBlocker({ ...setOutcome(delivery, 'timeout'), checkpoints: [checkpoint] }, proof)!, /终止状态/);
  assert.equal(deliveryProofBlocker({ ...setOutcome(delivery, 'timeout'),
    checkpoints: [{ ...checkpoint, process: { status: 'timeout', exitCode: null } }] }, proof), null);
  assert.match(deliveryProofBlocker({ ...delivery, checkpoints: [] }, proof)!, /实际轮次/);
  assert.throws(() => runIsolationPreflight('relative-config.json', ['bench/a']), /绝对路径/);
  const retiredManifest = { ...base.protocol.manifest, isolation: { backend: 'linux-setpriv-v1' } } as unknown as ProtocolManifest;
  assert.throws(() => validateResults({ ...base, protocol: { ...base.protocol, manifest: retiredManifest,
    digest: digestOf(retiredManifest) } }), /旧 setpriv/);
  const stale = { ...proof, backend: 'linux-setpriv-v1' } as unknown as IsolationProof;
  assert.ok(deliveryProofBlocker(delivery, stale));
  assert.ok(deliveryProofBlocker(delivery, { ...proof, programVersion: '2.0.1' }));
  assert.ok(deliveryProofBlocker(delivery, { ...proof, imageId: `sha256:${'e'.repeat(64)}` }));
  assert.throws(() => publicationScores({ ...base, results: base.results.map((row) => row.caseId === delivery.caseId
    && row.modelId === delivery.modelId && row.repeatIndex === 1 ? { ...row, checkpoints: delivery.checkpoints } : row) }), /跨槽复用/);
  const writableProgram = { ...base.protocol.manifest, isolation: { ...base.protocol.manifest.isolation!, program: '/work/opencode' } };
  assert.throws(() => validateResults({ ...base, protocol: { ...base.protocol, manifest: writableProgram,
    digest: digestOf(writableProgram), preflight: base.protocol.preflight!.map((entry) => ({ ...entry, program: '/work/opencode' })) } }), /Podman 模型预检/);
}

function testRepair(): void {
  const base = fixture();
  base.results[0] = setOutcome(base.results[0], 'missing_evidence');
  base.meta.workers[0] = { modelId: 'bench/a', status: 'incomplete', exitCode: 1 };
  assert.throws(() => publicationScores(base), /未解决/);
  const plan = makeRepairPlan(base);
  const [slot] = plan.slots;
  const overlay: RunResults = { ...base, results: [setOutcome(base.results[0], 'pass')],
    protocol: { ...base.protocol, runId: 'repair', models: base.protocol.models.slice(0, 1),
      preflight: [{ ...base.protocol.preflight![0], containerId: 'f'.repeat(64) }], repair: plan },
    meta: { ...base.meta, workers: base.meta.workers.slice(0, 1) } };
  const merged = mergeRepair(base, overlay);
  assert.equal(merged.repairs?.[0].previous.outcome, 'missing_evidence');
  assert.equal(merged.repairs?.[0].replacement.outcome, 'pass');
  assert.equal(base.results[0].outcome, 'missing_evidence');
  assert.equal(scoresForRun(merged).scores[0].total, 100);
  assert.equal(merged.meta.workers[0].exitCode, 1);
  assert.throws(() => mergeRepair(base, { ...overlay, protocol: { ...overlay.protocol,
    preflight: base.protocol.preflight?.slice(0, 1) } }), /复用了历史预检/);
  assert.throws(() => mergeRepair(base, { ...overlay, protocol: { ...overlay.protocol, repair: { ...plan, baseDigest: 'b'.repeat(64) } } }), /同协议/);
  const wrongSlot = { ...slot, repeatIndex: 1 };
  assert.throws(() => mergeRepair(base, { ...overlay, results: [{ ...overlay.results[0], ...wrongSlot }],
    protocol: { ...overlay.protocol, repair: { ...plan, slots: [wrongSlot] } } }), /不能覆盖/);
  assert.throws(() => publicationScores(overlay), /只发布正式/);
}

function trialFixture(base: RunResults, ids: readonly string[]): RunResults {
  const target = calibrationTrialCases(base.protocol);
  const manifest = { ...base.protocol.manifest, mode: 'trial' as const,
    cases: base.protocol.manifest.cases.filter(({ id }) => target.includes(id)) };
  const models = ids.map((id) => ({ id, model: id, variant: 'high' }));
  const preflight = preflightFor(models);
  const protocol = { ...base.protocol, runId: 'trial', manifest, models, preflight, digest: digestOf(manifest) };
  const reference = base.results.filter(({ modelId, caseId }) => modelId === 'bench/a' && target.includes(caseId));
  return { ...base, protocol, results: models.flatMap(({ id }, index) => reference.map((row) => addProof({ ...row, modelId: id }, preflight[index]))),
    meta: { ...base.meta, workers: models.map(({ id: modelId }) => ({ modelId, status: 'complete' })) } };
}

function testEvidence(): void {
  const base = fixture();
  const trial = trialFixture(base, [...REQUIRED_MODELS, 'volc/glm-5.3-flash']);
  assert.notEqual(trial.protocol.digest, base.protocol.digest);
  assert.equal(contentDigest(trial.protocol), contentDigest(base.protocol));
  assert.doesNotThrow(() => verifyCalibrationTrial(base.protocol, trial));
  const plainTrial = { ...trial.protocol.manifest, isolation: undefined };
  assert.throws(() => verifyCalibrationTrial(base.protocol, {
    ...trial, protocol: { ...trial.protocol, manifest: plainTrial, digest: digestOf(plainTrial), preflight: undefined },
  }), /内容锁/);
  assert.throws(() => verifyCalibrationTrial(base.protocol, trialFixture(base, REQUIRED_MODELS)), /Flash/);
  assert.throws(() => verifyCalibrationTrial(base.protocol, { ...trial, results: trial.results.slice(1) }), /缺少/);
  const changed = { ...trial.protocol.manifest, opencodeVersion: '2.1' };
  assert.throws(() => verifyCalibrationTrial(base.protocol, {
    ...trial, protocol: { ...trial.protocol, manifest: changed, digest: digestOf(changed) },
  }), /内容锁/);
  const hash = 'a'.repeat(64);
  const digest = contentDigest(base.protocol);
  const calibration = { contentDigest: digest, commands: ['runners/selftest.ts', 'runners/run-bench.ts --dry-run --mode formal']
    .map((command) => ({ command, exitCode: 0, logDigest: hash })) };
  const review = { contentDigest: digest, reviewer: 'reviewer', replayDigest: hash,
    groups: Object.fromEntries(CALIBRATION_GROUPS.map((group) => [group, { positive: 1, negative: 2 }])) };
  const isolation = { contentDigest: digest, reviewer: 'isolator', platform: 'linux/x64', logDigest: hash,
    checks: Object.fromEntries(ISOLATION_CHECKS.map((check) => [check, true as const])) };
  assert.doesNotThrow(() => verifyReceipts(base.protocol, calibration, review, isolation));
  assert.throws(() => verifyReceipts(base.protocol, calibration, { ...review, groups: {} }, isolation), /正反例/);
  assert.throws(() => verifyReceipts(base.protocol, calibration, review, { ...isolation, checks: {} }), /隔离/);
  assert.throws(() => verifyReceipts(base.protocol, calibration, review, { ...isolation, contentDigest: hash }), /摘要/);
  const blockedManifest = { ...base.protocol.manifest, isolation: undefined };
  const blockedLock = { ...base.protocol, manifest: blockedManifest, digest: digestOf(blockedManifest), preflight: undefined };
  const blockedDigest = contentDigest(blockedLock);
  assert.throws(() => verifyReceipts(blockedLock, { ...calibration, contentDigest: blockedDigest },
    { ...review, contentDigest: blockedDigest }, { ...isolation, contentDigest: blockedDigest }), /未验证/);
}

function testWorkerRecovery(): void {
  const { protocol, results } = fixture();
  const violation = setOutcome(results[0], 'violation');
  const recovered = recoverWorkerRows(protocol, [results[0], { bad: true }, violation, results[1]]);
  assert.deepEqual(recovered, { rows: [violation, results[1]], rejected: 2 });
  const conflicted = recoverWorkerRows(protocol, [results[0], setOutcome(results[0], 'timeout'), results[1]]);
  assert.deepEqual(conflicted, { rows: [results[1]], rejected: 1 });
}

export function runProtocolTests(): void {
  testPublication();
  testRepair();
  testEvidence();
  testWorkerRecovery();
  const archive = '> <!-- ARCHIVED:v1.0:START -->\n> archive\n> <!-- ARCHIVED:v1.0:END -->\n';
  const source = `> <!-- RANKING:START -->\n> pending\n> <!-- RANKING:END -->\n${archive}`;
  assert.ok(replaceRanking(source, 'new', true).endsWith(archive));
  assert.throws(() => replaceRanking(`> <!-- RANKING:START -->\n${archive}> <!-- RANKING:END -->`, 'new', true), /交叉/);
  assert.throws(() => replaceRanking(`> <!-- ARCHIVED:v1.0:START -->\n${source.split(archive)[0]}> <!-- ARCHIVED:v1.0:END -->`, 'new', true), /交叉/);
  assert.throws(() => replaceRanking(source + source, 'new', true), /重复/);
}
