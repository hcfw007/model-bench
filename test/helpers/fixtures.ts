/**
 * RunResults 夹具构造：所有产物都能通过 validateLock / validateRows / validateResults。
 * 形状参照 runners/checks/protocol.ts 的 fixture()，参数化后用于失败与补槽场景。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { BenchConfig } from '../../runners/lib/config.ts';
import type { RunMeta } from '../../runners/lib/parallel.ts';
import {
  digestOf, expectedSlots, FORMAL_COUNTS, FORMAL_WEIGHTS, PROTOCOL_SCHEMA, slotKey,
  type ProtocolCase, type ProtocolLock, type ProtocolManifest,
} from '../../runners/lib/protocol.ts';
import { makeRepairPlan, type RunResults } from '../../runners/lib/protocol-results.ts';
import type { CaseOutcome, CaseResult } from '../../runners/lib/score.ts';

export const HASH = 'a'.repeat(64);
export const MOCK_COMMIT = '0'.repeat(40);

export function formalCases(): ProtocolCase[] {
  return Object.entries(FORMAL_COUNTS).flatMap(([layer, count]) =>
    Array.from({ length: count }, (_, index) => ({
      id: `${layer}-${String(index + 1).padStart(2, '0')}`,
      layer,
      timeoutSec: 300,
      // l2 题权 3×5 + 2 + 1×2 = 19；l2-07 / l2-08 必须为 1
      weight: layer === 'l2' && index < 6 ? (index < 5 ? 3 : 2) : 1,
    })));
}

export function formalManifest(): ProtocolManifest {
  const cases = formalCases();
  return {
    schema: PROTOCOL_SCHEMA, benchmarkVersion: '1.1.0', mode: 'formal',
    concurrency: 5, repeat: 3, opencodeVersion: '2.0', mockRepoCommit: MOCK_COMMIT,
    platform: 'darwin/arm64',
    files: { 'bench.config.jsonc': HASH, 'runners/lib/runner.ts': HASH, 'cases/a.json': HASH },
    cases, suiteDigest: digestOf(cases),
    weights: { ...FORMAL_WEIGHTS },
    handoff: { primary: 'bench/a#high', fallback: 'bench/b#high' },
  };
}

function rowsFor(protocol: ProtocolLock, mutate?: (row: CaseResult) => CaseResult): CaseResult[] {
  const cases = new Map(protocol.manifest.cases.map((row) => [row.id, row]));
  return expectedSlots(protocol).map((slot) => {
    const { layer, weight } = cases.get(slot.caseId)!;
    const row: CaseResult = {
      caseId: slot.caseId, repeatIndex: slot.repeatIndex, modelId: slot.modelId,
      layer, weight, outcome: 'pass', pass: true, violation: false,
      turns: 1, tokensInput: 10, tokensOutput: 20, durationSec: 1,
      toolErrors: {}, assertions: [],
    };
    return mutate ? mutate(row) : row;
  });
}

/** validateResults 只交叉核对 bench.version / weights / run.switch*，其余字段补齐类型。 */
function fullConfig(manifest: ProtocolManifest): BenchConfig {
  return {
    bench: {
      name: 'bench-fixture', version: manifest.benchmarkVersion, opencodeBin: 'opencode',
      dbPath: '~/opencode.db', mockRepo: './mockrepo', worktreeRoot: './worktrees', reportsDir: './reports',
    },
    models: [],
    run: {
      repeat: manifest.repeat, concurrency: manifest.concurrency, timeoutSec: 300, maxTurns: 32,
      keepWorktree: false,
      ...(manifest.handoff ? { switchModel: manifest.handoff.primary, switchFallback: manifest.handoff.fallback } : {}),
    },
    weights: { ...manifest.weights },
    layers: { l0: true, l1: true, l2: true, l3: true },
    safety: { forbiddenCommands: ['git\\s+push'], protectedPaths: ['.git'] },
    scoring: { reworkPenalty: 0, maxReworkTurns: 0, violationZeroesRun: true },
  };
}

export function formalRun(mutate?: (row: CaseResult) => CaseResult): RunResults {
  const manifest = formalManifest();
  const models = ['bench/a', 'bench/b'].map((id) => ({ id, model: id, variant: 'high' }));
  const protocol: ProtocolLock = { manifest, digest: digestOf(manifest), models, runId: 'base-run' };
  const config = fullConfig(manifest);
  return {
    config, protocol, results: rowsFor(protocol, mutate),
    meta: {
      mode: 'parallel', concurrency: 5, mockRepoCommit: MOCK_COMMIT, startedAt: '2026-11-19',
      workers: models.map(({ id: modelId }) => ({ modelId, status: 'complete' as const })),
    },
  };
}

export function trialRun(mutate?: (row: CaseResult) => CaseResult): RunResults {
  const cases: ProtocolCase[] = [
    { id: 'l0-01', layer: 'l0', weight: 1, timeoutSec: 60 },
    { id: 'l1-01', layer: 'l1', weight: 2, timeoutSec: 60 },
    { id: 'l2-01', layer: 'l2', weight: 0.5, timeoutSec: 60 },
  ];
  const weights = { l0: 1, l1: 1, l2: 1 };
  const manifest: ProtocolManifest = {
    schema: PROTOCOL_SCHEMA, benchmarkVersion: '1.1.0', mode: 'trial',
    concurrency: 1, repeat: 2, opencodeVersion: '2.0', mockRepoCommit: MOCK_COMMIT,
    platform: 'darwin/arm64',
    files: { 'bench.config.jsonc': HASH, 'runners/lib/runner.ts': HASH, 'cases/a.json': HASH },
    cases, suiteDigest: HASH, weights,
  };
  const models = ['bench/a', 'bench/b'].map((id) => ({ id, model: id }));
  const protocol: ProtocolLock = { manifest, digest: digestOf(manifest), models, runId: 'trial-run' };
  const config = fullConfig(manifest);
  return {
    config, protocol, results: rowsFor(protocol, mutate),
    meta: {
      mode: 'serial', concurrency: 1, mockRepoCommit: MOCK_COMMIT, startedAt: '2026-11-19',
      workers: models.map(({ id: modelId }) => ({ modelId, status: 'complete' as const })),
    },
  };
}

export function setOutcome(row: CaseResult, outcome: CaseOutcome): CaseResult {
  return { ...row, outcome, pass: outcome === 'pass', violation: outcome === 'violation' };
}

/** 只把 bench/a l1-01 #0 和 bench/b l2-01 #1 标为可补故障（error / missing_evidence）。 */
export function faultyRun(): RunResults {
  return formalRun((row) => {
    if (row.modelId === 'bench/a' && row.caseId === 'l1-01' && row.repeatIndex === 0) return setOutcome(row, 'error');
    if (row.modelId === 'bench/b' && row.caseId === 'l2-01' && row.repeatIndex === 1) return setOutcome(row, 'missing_evidence');
    return row;
  });
}

/** 与 protocol-results.ts 内部 resultsDigest 同口径：scores 不参与摘要。 */
export function resultsDigest(run: RunResults): string {
  const { config, results, meta, protocol, repairs } = run;
  return digestOf({ config, results, meta, protocol, repairs: repairs?.length ? repairs : undefined });
}

/**
 * 基于正式主运行构造补槽运行：协议清单不变，只补 makeRepairPlan 选出的故障槽位。
 * mutate 可替换补槽产物（默认全部补成 pass，且清空断言以满足分类一致性）。
 */
export function repairOverlay(
  base: RunResults,
  mutate?: (previous: CaseResult) => CaseResult,
): RunResults {
  const plan = makeRepairPlan(base);
  const models = base.protocol.models.filter(({ id }) => plan.slots.some((slot) => slot.modelId === id));
  const protocol: ProtocolLock = {
    manifest: base.protocol.manifest, digest: base.protocol.digest, models,
    runId: 'repair-run', repair: { baseDigest: plan.baseDigest, slots: plan.slots },
  };
  const previous = new Map(base.results.map((row) => [slotKey(row.modelId, { caseId: row.caseId, repeatIndex: row.repeatIndex! }), row]));
  const results = plan.slots.map((slot) => {
    const row = previous.get(slotKey(slot.modelId, slot))!;
    return mutate ? mutate(row) : { ...row, outcome: 'pass' as const, pass: true, violation: false, error: undefined, assertions: [] };
  });
  const meta: RunMeta = { ...base.meta, startedAt: '2026-11-27', workers: [...base.meta.workers] };
  return { config: base.config, protocol, results, meta };
}

/** 把 RunResults 落到目录（results.json + protocol.lock.json），供 CLI 子进程测试读取。 */
export function writeRun(dir: string, run: RunResults): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'results.json'), JSON.stringify(run, null, 2));
  writeFileSync(resolve(dir, 'protocol.lock.json'), JSON.stringify(run.protocol, null, 2));
}

/** 造一个 sqlite 会话库（analyze / latency 的 CLI 测试用假 HOME 重定向 dbPath）。 */
export function writeSessionDb(
  dbPath: string,
  sessions: ReadonlyArray<{ id: string; title: string; timeCreated?: number; timeUpdated?: number; messages: ReadonlyArray<{ seq: number; type: string; data: unknown }> }>,
): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  return withDb(dbPath, (db) => {
    for (const session of sessions) {
      db.prepare('insert into session_v2 (id, title, time_created, time_updated) values (?, ?, ?, ?)')
        .run(session.id, session.title, session.timeCreated ?? 1000, session.timeUpdated ?? 2000);
      for (const message of session.messages) {
        db.prepare('insert into session_message (session_id, seq, type, data) values (?, ?, ?, ?)')
          .run(session.id, message.seq, message.type, JSON.stringify(message.data));
      }
    }
  });
}

function withDb(dbPath: string, work: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(dbPath);
  db.exec('create table session_v2 (id text, title text, time_created integer, time_updated integer)');
  db.exec('create table session_message (session_id text, seq integer, type text, data text)');
  try {
    work(db);
  } finally {
    db.close();
  }
}
