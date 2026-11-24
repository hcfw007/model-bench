import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BenchConfig } from '../lib/config.ts';
import { digestOf, expectedSlots, FORMAL_COUNTS, FORMAL_WEIGHTS, PROTOCOL_SCHEMA, sha256, type ProtocolLock, type ProtocolManifest } from '../lib/protocol.ts';
import { verifyReleaseEvidence } from '../lib/protocol-evidence.ts';
import { replaceRanking } from '../lib/protocol-publish.ts';
import { makeRepairPlan, mergeRepair, publicationScores, scoresForRun, validateResults, type RunResults } from '../lib/protocol-results.ts';
import { calibrationTrialCases, CALIBRATION_GROUPS, contentDigest, REQUIRED_MODELS,
  verifyCalibrationTrial, verifyReceipts } from '../lib/protocol-release.ts';
import { recoverWorkerRows } from '../lib/run-parallel.ts';
import { rankScores, type CaseOutcome, type CaseResult } from '../lib/score.ts';

function fixture(): RunResults {
  const hash = 'a'.repeat(64);
  const mockRepoCommit = '0'.repeat(40);
  const cases = Object.entries(FORMAL_COUNTS).flatMap(([layer, count]) => Array.from({ length: count }, (_, index) => ({
    id: `${layer}-${String(index + 1).padStart(2, '0')}`, layer, timeoutSec: 300,
    weight: layer === 'l2' && index < 6 ? (index < 5 ? 3 : 2) : 1,
  })));
  const models = ['bench/a', 'bench/b'].map((id) => ({ id, model: id, variant: 'high' }));
  const manifest: ProtocolManifest = {
    schema: PROTOCOL_SCHEMA, benchmarkVersion: '1.1.0', mode: 'formal', concurrency: 5, repeat: 3, opencodeVersion: '2.0',
    mockRepoCommit, platform: 'darwin/arm64',
    files: { 'bench.config.jsonc': hash, 'runners/lib/runner.ts': hash, 'cases/a.json': hash },
    cases, suiteDigest: digestOf(cases),
    weights: FORMAL_WEIGHTS, handoff: { primary: 'bench/a#high', fallback: 'bench/b#high' },
  };
  const protocol: ProtocolLock = { manifest, digest: digestOf(manifest), models, runId: 'base' };
  const results = expectedSlots(protocol).map((slot): CaseResult => {
    const { layer, weight } = manifest.cases.find(({ id }) => id === slot.caseId)!;
    return {
      ...slot, layer, weight, outcome: 'pass', pass: true, violation: false, turns: 1,
      tokensInput: 10, tokensOutput: 20, durationSec: 1, toolErrors: {}, assertions: [],
    };
  });
  const config = { bench: { version: '1.1.0' }, weights: FORMAL_WEIGHTS,
    run: { switchModel: manifest.handoff!.primary, switchFallback: manifest.handoff!.fallback } } as BenchConfig;
  return { config, protocol, results, meta: {
    mode: 'parallel', concurrency: 5, mockRepoCommit, startedAt: '2026-11-19',
    workers: models.map(({ id: modelId }) => ({ modelId, status: 'complete' })),
  } };
}

function setOutcome(row: CaseResult, outcome: CaseOutcome): CaseResult {
  return { ...row, outcome, pass: outcome === 'pass', violation: outcome === 'violation' };
}

function withManifest(data: RunResults, manifest: ProtocolManifest): RunResults {
  return { ...data, protocol: { ...data.protocol, manifest, digest: digestOf(manifest) } };
}

function retiredSchema(data: RunResults): RunResults {
  return withManifest(data, { ...data.protocol.manifest, schema: 1 } as unknown as ProtocolManifest);
}

function testPublication(): void {
  const base = fixture();
  assert.equal(base.results.length, 198);
  const { scores } = scoresForRun(base);
  assert.deepEqual(publicationScores(base), scores);
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
  assert.deepEqual(publicationScores(violated).map(({ modelId }) => modelId), ['bench/b']);
  const retired = retiredSchema(base);
  assert.notEqual(contentDigest(retired.protocol), contentDigest(base.protocol));
  assert.throws(() => publicationScores(retired), /schema/);
  assert.throws(() => publicationScores(withManifest(base, { ...base.protocol.manifest, repeat: 2 })), /重复 3 次/);
}

function testRepair(): void {
  const base = fixture();
  base.results[0] = setOutcome(base.results[0], 'missing_evidence');
  base.meta.workers[0] = { modelId: 'bench/a', status: 'incomplete', exitCode: 1 };
  assert.throws(() => publicationScores(base), /未解决/);
  const plan = makeRepairPlan(base);
  const [slot] = plan.slots;
  const overlay: RunResults = { ...base, results: [setOutcome(base.results[0], 'pass')],
    protocol: { ...base.protocol, runId: 'repair', models: base.protocol.models.slice(0, 1), repair: plan },
    meta: { ...base.meta, workers: base.meta.workers.slice(0, 1) } };
  const merged = mergeRepair(base, overlay);
  assert.equal(merged.repairs?.[0].previous.outcome, 'missing_evidence');
  assert.equal(merged.repairs?.[0].replacement.outcome, 'pass');
  assert.equal(base.results[0].outcome, 'missing_evidence');
  assert.equal(scoresForRun(merged).scores[0].total, 100);
  assert.equal(publicationScores(merged).length, 2);
  assert.equal(merged.meta.workers[0].exitCode, 1);
  assert.throws(() => mergeRepair(base, retiredSchema(overlay)), /schema/);
  assert.throws(() => mergeRepair(base, withManifest(overlay, { ...overlay.protocol.manifest, platform: 'linux/x64' })), /同协议/);
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
  const protocol = { ...base.protocol, runId: 'trial', manifest, models, digest: digestOf(manifest) };
  const reference = base.results.filter(({ modelId, caseId }) => modelId === 'bench/a' && target.includes(caseId));
  return { ...base, protocol, results: models.flatMap(({ id }) => reference.map((row) => ({ ...row, modelId: id }))),
    meta: { ...base.meta, workers: models.map(({ id: modelId }) => ({ modelId, status: 'complete' })) } };
}

function testEvidence(): void {
  const base = fixture();
  const trial = trialFixture(base, [...REQUIRED_MODELS, 'volc/glm-5.3-flash']);
  assert.notEqual(trial.protocol.digest, base.protocol.digest);
  assert.equal(contentDigest(trial.protocol), contentDigest(base.protocol));
  assert.doesNotThrow(() => verifyCalibrationTrial(base.protocol, trial));
  assert.throws(() => verifyCalibrationTrial(base.protocol, retiredSchema(trial)), /schema/);
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
  assert.doesNotThrow(() => verifyReceipts(base.protocol, calibration, review));
  assert.throws(() => verifyReceipts(base.protocol, calibration, { ...review, groups: {
    ...review.groups, [CALIBRATION_GROUPS[0]]: { positive: 1, negative: 1 },
  } }), /正反例/);
  assert.throws(() => verifyReceipts(base.protocol, { ...calibration, commands: calibration.commands.toReversed() }, review), /离线校准/);
  assert.throws(() => verifyReceipts(base.protocol, calibration, { ...review, contentDigest: hash }), /摘要/);
}

function testEvidenceFiles(): void {
  const base = fixture();
  const trial = trialFixture(base, [...REQUIRED_MODELS, 'volc/glm-5.3-flash']);
  const directory = mkdtempSync(join(tmpdir(), 'bench-release-evidence-'));
  const write = (path: string, content: string): void => writeFileSync(join(directory, path), content);
  const writeJson = (path: string, value: unknown): void => write(path, JSON.stringify(value));
  try {
    mkdirSync(join(directory, 'trial'));
    writeJson('trial/protocol.lock.json', trial.protocol);
    writeJson('trial/results.json', trial);
    const content = contentDigest(base.protocol);
    const commands = ['runners/selftest.ts', 'runners/run-bench.ts --dry-run --mode formal'].map((command, index) => {
      const log = `${command} passed\n`;
      write(`calibration-${index}.log`, log);
      return { command, exitCode: 0, logDigest: sha256(log) };
    });
    writeJson('calibration.json', { contentDigest: content, commands });
    const replay = 'Replay verified\n';
    write('replay.md', replay);
    writeJson('review.json', { contentDigest: content, reviewer: 'reviewer', replayDigest: sha256(replay),
      groups: Object.fromEntries(CALIBRATION_GROUPS.map((group) => [group, { positive: 1, negative: 2 }])) });
    assert.doesNotThrow(() => verifyReleaseEvidence(base.protocol, directory));
    writeJson('trial/protocol.lock.json', { ...trial.protocol, runId: 'unrelated' });
    assert.throws(() => verifyReleaseEvidence(base.protocol, directory), /运行前锁/);
    writeJson('trial/protocol.lock.json', trial.protocol);
    write('replay.md', 'tampered replay\n');
    assert.throws(() => verifyReleaseEvidence(base.protocol, directory), /原件摘要/);
    write('replay.md', replay);
    write('calibration-0.log', 'tampered log\n');
    assert.throws(() => verifyReleaseEvidence(base.protocol, directory), /日志摘要/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
  testEvidenceFiles();
  testWorkerRecovery();
  const archive = '> <!-- ARCHIVED:v1.0:START -->\n> archive\n> <!-- ARCHIVED:v1.0:END -->\n';
  const source = `> <!-- RANKING:START -->\n> pending\n> <!-- RANKING:END -->\n${archive}`;
  assert.ok(replaceRanking(source, 'new', true).endsWith(archive));
  assert.throws(() => replaceRanking(`> <!-- RANKING:START -->\n${archive}> <!-- RANKING:END -->`, 'new', true), /交叉/);
  assert.throws(() => replaceRanking(`> <!-- ARCHIVED:v1.0:START -->\n${source.split(archive)[0]}> <!-- ARCHIVED:v1.0:END -->`, 'new', true), /交叉/);
  assert.throws(() => replaceRanking(source + source, 'new', true), /重复/);
}
