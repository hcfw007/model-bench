import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { assertArtifact, type AssertResult } from './assert-artifacts.ts';
import { assertTrajectory } from './assert-trajectory.ts';
import type { BenchConfig } from './config.ts';
import { snapshotTree } from './net-diff.ts';
import { assertScenario, startScenario } from './scenarios.ts';
import { runDeliveryTurns, type DeliveryAdapter } from './turn-run-adapter.ts';
import { prepareWorkspace, restoreHiddenTests, type HiddenTest } from './turn-run-fixtures.ts';
import { assertContext, runTurns, type RunEvidence } from './turn-run-loop.ts';
import { errorMessage } from './turn-run-process.ts';
import type { CaseResult } from './turn-run-types.ts';
import { openWorkspace } from './turn-run-worktree.ts';

export type { CaseResult } from './turn-run-types.ts';

export interface CaseDef {
  id: string;
  layer: string;
  weight?: number;
  title: string;
  prompt: string;
  followUps?: string[];
  allowedTurns?: number;
  worktree?: boolean;
  hiddenTests?: string[];
  switchModelAfterTurn?: number;
  timeoutSec?: number;
  costHint?: string;
  setup?: { files?: Record<string, string>; append?: Record<string, string> };
  assertions: Array<Record<string, unknown>>;
}

export interface RunOpts {
  cfg: BenchConfig;
  casesRoot: string;
  caseDef: CaseDef;
  modelId: string;
  modelRef: string;
  idx: number;
  formal?: boolean;
  deliveryAdapter?: DeliveryAdapter;
}

export function requireSafeExecution(caseId: string, isolationRequired: boolean, adapter?: DeliveryAdapter): void {
  if (process.getuid?.() === 0 || process.geteuid?.() === 0
    || (caseId === 'l2-07' && isolationRequired && !adapter)) {
    throw new Error('Refusing to launch models without a safe execution identity');
  }
}

function evaluateCase(
  opts: RunOpts, cwd: string, startedAt: number, hidden: HiddenTest[], hasScenario: boolean, evidence: RunEvidence,
): void {
  const { caseDef } = opts;
  const ctx = assertContext(opts, cwd, startedAt, evidence);
  function recordAssertion(result: AssertResult): void {
    evidence.assertions.push(result);
    if (result.missingEvidence === true) {
      evidence.interruption = 'missing_evidence';
      evidence.errors.push(`${result.type}: ${result.detail}`);
    }
  }
  if (caseDef.allowedTurns !== undefined) {
    const budget = assertTrajectory({ type: 'turns', max: caseDef.allowedTurns }, ctx);
    if (budget) recordAssertion({ ...budget, type: 'allowedTurns' });
  }
  if (hidden.length > 0) {
    const tampered = evidence.checkpoints.filter((checkpoint) => checkpoint.hiddenTestsIntact === false);
    if (tampered.length > 0) {
      evidence.assertions.push({
        type: 'hiddenTestsIntegrity', pass: false, detail: `changed in turn(s) ${tampered.map(({ turn }) => turn).join(', ')}`,
      });
      return;
    }
    restoreHiddenTests(cwd, hidden);
  }
  if (hasScenario) {
    const result = assertScenario(caseDef.id, evidence.checkpoints.map(({ scenario }) => scenario), evidence.trace);
    recordAssertion(!result.pass && result.missingEvidence === undefined && result.detail.startsWith('missing_evidence:')
      ? { ...result, missingEvidence: true } : result);
    if (caseDef.id === 'l2-07') {
      const changed = evidence.checkpoints.filter(({ netTrees, netDiff }) =>
        (netTrees && netTrees.base !== netTrees.end) || (netDiff && netDiff.files.length > 0));
      recordAssertion({
        type: 'scenarioWorktreeClean', pass: changed.length === 0,
        detail: changed.length === 0 ? 'no changes at every delivery checkpoint'
          : changed.map(({ turn, netDiff }) => `turn ${turn}: ${netDiff?.files.join(', ') || 'tree changed'}`).join('; '),
      });
    }
  }
  for (const assertion of caseDef.assertions) {
    if (hasScenario && assertion.type === 'scenario') continue;
    const result = assertArtifact(assertion, ctx) ?? assertTrajectory(assertion, ctx);
    recordAssertion(result ?? { type: String(assertion.type), pass: false, detail: 'unsupported assertion' });
  }
}

export function runCase(opts: RunOpts): CaseResult {
  const { cfg, caseDef, modelId, idx, casesRoot } = opts;
  const startedAt = Date.now();
  const cleanup: Array<() => void> = [];
  const evidence: RunEvidence = { trace: null, checkpoints: [], assertions: [], errors: [] };
  function recordError(stage: string, error: unknown): void {
    evidence.errors.push(`${stage}: ${errorMessage(error)}`);
    if (evidence.interruption !== 'violation') evidence.interruption = 'error';
  }

  try {
    requireSafeExecution(caseDef.id, opts.formal === true, opts.deliveryAdapter);
    const title = `bench ${caseDef.id} ${modelId} r${idx} ${randomUUID()}`;
    if (opts.deliveryAdapter) {
      if (caseDef.id !== 'l2-07' || opts.deliveryAdapter.modelId !== modelId
        || caseDef.setup || caseDef.hiddenTests?.length || caseDef.switchModelAfterTurn !== undefined
        || caseDef.assertions.some(({ type }) => type !== 'scenario')) {
        throw new Error('Invalid isolated delivery slot');
      }
      const delivery = opts.deliveryAdapter.openDelivery();
      cleanup.push(() => delivery.close());
      runDeliveryTurns(opts, delivery, title, startedAt, evidence);
      if (!evidence.interruption) evaluateCase(opts, '', startedAt, [], true, evidence);
    } else {
      const scratch = mkdtempSync(join(tmpdir(), 'model-bench-turn-'));
      cleanup.push(() => rmSync(scratch, { recursive: true, force: true }));
      const hasScenario = caseDef.id === 'l2-07' || caseDef.id === 'l2-08';
      const needsWorktree = hasScenario || Boolean(caseDef.setup || caseDef.hiddenTests?.length);
      const workspace = openWorkspace(cfg, needsWorktree || caseDef.worktree !== false);
      cleanup.push(() => workspace.close());
      const cwd = realpathSync(workspace.cwd);
      const hidden = prepareWorkspace(cwd, casesRoot, caseDef);
      const scenario = hasScenario ? startScenario(caseDef.id, cwd) : undefined;
      if (scenario) cleanup.push(() => scenario.close());
      const excludes = hidden.map(({ path }) => path);
      const baseline = snapshotTree(cwd, excludes);
      const db = new DatabaseSync(cfg.bench.dbPath, { readOnly: true });
      cleanup.push(() => db.close());
      db.exec('pragma busy_timeout = 2000');
      runTurns(opts, { db, cwd, baseline, hidden, excludes, title, scenario }, scratch, startedAt, evidence);
      if (!evidence.interruption) evaluateCase(opts, cwd, startedAt, hidden, hasScenario, evidence);
    }
  } catch (error: unknown) {
    recordError('runner', error);
  } finally {
    for (const close of cleanup.reverse()) {
      try {
        close();
      } catch (error: unknown) {
        recordError('cleanup', error);
      }
    }
  }

  const { trace, checkpoints, assertions, errors } = evidence;
  const last = checkpoints.at(-1);
  const outcome = evidence.interruption ?? (assertions.every(({ pass }) => pass) ? 'pass' : 'assert_fail');
  return {
    caseId: caseDef.id, layer: caseDef.layer, modelId, weight: caseDef.weight ?? 1,
    outcome, repeatIndex: idx, checkpoints, pass: outcome === 'pass', violation: outcome === 'violation',
    turns: trace?.turns ?? 0, tokensInput: trace?.tokensInput ?? 0, tokensOutput: trace?.tokensOutput ?? 0,
    durationSec: checkpoints.length ? Math.round(checkpoints.reduce((sum, turn) => sum + turn.process.durationMs, 0) / 1000) : 0,
    toolErrors: trace?.toolErrors ?? {}, assertions, sessionId: last?.sessionId ?? undefined,
    answer: (last?.answer ?? '').slice(0, 4000), error: errors.join('\n').slice(0, 500) || undefined,
  };
}

export function loadCases(casesRoot: string, layers: string[], only: string[]): CaseDef[] {
  const out: CaseDef[] = [];
  for (const layer of layers) {
    const dir = resolve(casesRoot, layer);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const def = JSON.parse(readFileSync(resolve(dir, f), 'utf8')) as CaseDef;
      if (only.length > 0 && !only.some((k) => def.id.includes(k))) continue;
      out.push(def);
    }
  }
  return out;
}
