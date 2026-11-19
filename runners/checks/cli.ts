import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { BenchConfig } from '../lib/config.ts';
import type { RunResults } from '../lib/protocol-results.ts';
import type { ModelScore } from '../lib/score.ts';
import type { CaseResult } from '../lib/turn-run-types.ts';

interface Invocation {
  readonly model_ref: string;
  readonly root_id: string;
  readonly cwd: string;
}

type CliReport = Omit<RunResults, 'results'> & { results: CaseResult[]; scores: ModelScore[] };

const SOURCE_ROOT = resolve(import.meta.dirname, '../..');
const CASE_FILE = 'l0-02-exact-echo.json';
const MODELS = ['fixture/correct', 'fixture/interrupted'] as const;
const FAKE_VERSION = '0.0.0-offline-fixture';

function initializeDb(path: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      pragma journal_mode = wal;
      create table session_v2 (
        id text primary key, title text unique, parent_id text, time_created integer, time_updated integer,
        tokens_input integer, tokens_output integer
      );
      create table session_message (
        session_id text, seq integer, type text, data text, time_created integer, time_updated integer
      );
      create table fixture_invocation (model_ref text primary key, root_id text, cwd text, pid integer);
    `);
  } finally {
    db.close();
  }
}

function git(env: NodeJS.ProcessEnv, ...args: string[]): void {
  execFileSync('git', args, { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
}

function configureFixture(root: string, env: NodeJS.ProcessEnv): BenchConfig {
  const mockRepo = join(root, 'mockrepo');
  const opencodeBin = join(root, 'fake-opencode');
  const dbPath = join(root, 'trace.db');
  git(env, 'init', '-q', '-b', 'main', mockRepo);
  git(env, '-C', mockRepo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-qm', 'base', '--allow-empty');
  initializeDb(dbPath);
  copyFileSync(join(import.meta.dirname, 'mock-opencode.cjs'), join(root, 'mock-opencode.cjs'));
  const node = `'${process.execPath.replaceAll("'", "'\\''")}'`;
  writeFileSync(opencodeBin, `#!/bin/sh\nexec ${node} "$(dirname "$0")/mock-opencode.cjs" "$@"\n`, { mode: 0o700 });
  const config: BenchConfig = {
    bench: { name: 'Offline fixture', version: '1.1', opencodeBin, dbPath, mockRepo: './mockrepo',
      worktreeRoot: './.worktrees', reportsDir: './reports' },
    models: MODELS.map((id) => ({ id, model: id, variant: 'high' })),
    run: { repeat: 1, concurrency: 2, timeoutSec: 4, maxTurns: 1, keepWorktree: false },
    weights: { l0: 10 },
    layers: { l0: true },
    safety: { forbiddenCommands: [], protectedPaths: [] },
    scoring: { reworkPenalty: 0, maxReworkTurns: 0, violationZeroesRun: true },
  };
  writeFileSync(join(root, 'bench.config.jsonc'), JSON.stringify(config));
  return config;
}

function copyCli(root: string): void {
  mkdirSync(join(root, 'runners'));
  mkdirSync(join(root, 'cases', 'l0'), { recursive: true });
  // Worker 快照会再复制 runners；不让检查代码、夹具或数据库随测试床递归复制。
  cpSync(join(SOURCE_ROOT, 'runners', 'lib'), join(root, 'runners', 'lib'), { recursive: true });
  for (const path of ['package.json', 'runners/run-bench.ts', `cases/l0/${CASE_FILE}`]) {
    copyFileSync(join(SOURCE_ROOT, path), join(root, path));
  }
}

function verifyInvocations(config: BenchConfig, scratch: string, rows: CaseResult[]): void {
  const db = new DatabaseSync(config.bench.dbPath, { readOnly: true });
  try {
    const invocations = db.prepare('select model_ref, root_id, cwd from fixture_invocation')
      .all() as unknown as Invocation[];
    assert.equal(invocations.length, MODELS.length);
    assert.equal(new Set(invocations.map(({ cwd }) => cwd)).size, MODELS.length);
    const scratchPath = realpathSync(scratch);
    for (const invocation of invocations) {
      const path = relative(scratchPath, invocation.cwd);
      assert.ok(path && !isAbsolute(path) && !path.startsWith(`..${sep}`) && path !== '..', invocation.cwd);
      assert.ok(!existsSync(invocation.cwd), `worker 测试床未清理: ${invocation.cwd}`);
      const result = rows.find(({ modelId }) => `${modelId}#high` === invocation.model_ref);
      assert.ok(result);
      assert.equal(result.sessionId, invocation.root_id);
    }
  } finally {
    db.close();
  }
}

function verifyReport(out: string, expectedAnswer: string): CaseResult[] {
  const report = JSON.parse(readFileSync(join(out, 'results.json'), 'utf8')) as CliReport;
  const lock: unknown = JSON.parse(readFileSync(join(out, 'protocol.lock.json'), 'utf8'));
  assert.deepEqual(lock, report.protocol);
  assert.equal(report.protocol.manifest.mode, 'trial');
  assert.equal(report.protocol.manifest.opencodeVersion, FAKE_VERSION);
  assert.equal(report.protocol.manifest.concurrency, 2);
  assert.deepEqual(report.protocol.models.map(({ id }) => id), MODELS);
  assert.equal(report.meta.mode, 'parallel');
  assert.equal(report.meta.concurrency, 2);
  assert.deepEqual(report.meta.workers.map(({ modelId, status }) => [modelId, status]),
    MODELS.map((modelId) => [modelId, 'complete']));
  assert.deepEqual(report.results.map(({ modelId, caseId, repeatIndex, outcome, pass }) =>
    [modelId, caseId, repeatIndex, outcome, pass]), [
    [MODELS[0], 'l0-02', 0, 'pass', true],
    [MODELS[1], 'l0-02', 0, 'timeout', false],
  ]);
  const [correct, timedOut] = report.results;
  assert.equal(correct.answer, expectedAnswer);
  assert.equal(correct.checkpoints.length, 1);
  assert.equal(correct.checkpoints[0].answer, expectedAnswer);
  assert.equal(correct.checkpoints[0].finalObserved, true);
  assert.equal(correct.checkpoints[0].process.status, 'exited');
  assert.equal(timedOut.turns, 1);
  assert.equal(timedOut.checkpoints.length, 1);
  assert.equal(timedOut.checkpoints[0].finalObserved, false);
  assert.equal(timedOut.checkpoints[0].answer, '');
  assert.equal(timedOut.checkpoints[0].process.status, 'timeout');
  assert.equal(timedOut.assertions.some(({ type }) => type === 'exactText'), false);
  assert.deepEqual(report.scores.map(({ modelId, total }) => [modelId, total]), [[MODELS[0], 100], [MODELS[1], 0]]);
  const failures = readFileSync(join(out, 'failures.md'), 'utf8');
  assert.match(failures, /fixture\/interrupted \/ l0-02[^\n]*\[timeout\]/);
  assert.doesNotMatch(failures, /fixture\/correct|exactText/);
  const leaderboard = readFileSync(join(out, 'leaderboard.md'), 'utf8');
  assert.match(leaderboard, /fixture\/correct\s+100\.0/);
  assert.match(leaderboard, /fixture\/interrupted\s+0\.0/);
  return report.results;
}

export function runCliTests(): void {
  const root = mkdtempSync(join(tmpdir(), 'model-bench-cli-e2e-'));
  try {
    const scratch = join(root, 'tmp');
    const home = join(root, 'home');
    const out = join(root, 'out');
    mkdirSync(scratch);
    mkdirSync(home);
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, TMPDIR: scratch, HOME: home,
      XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), GIT_CONFIG_NOSYSTEM: '1' };
    copyCli(root);
    const config = configureFixture(root, env);
    const execution = spawnSync(process.execPath, [
      join(root, 'runners', 'run-bench.ts'), '--mode', 'trial', '--concurrency', '2', '--out', out,
    ], { cwd: root, env, encoding: 'utf8', timeout: 20_000, killSignal: 'SIGTERM' });
    assert.ifError(execution.error);
    assert.equal(execution.status, 0, `${execution.stdout}\n${execution.stderr}`);
    const oldCase = JSON.parse(readFileSync(join(root, 'cases', 'l0', CASE_FILE), 'utf8')) as {
      assertions: Array<{ type: string; value?: unknown }>;
    };
    const expectedAnswer = oldCase.assertions.find(({ type }) => type === 'exactText')?.value;
    assert.ok(typeof expectedAnswer === 'string');
    const rows = verifyReport(out, expectedAnswer);
    verifyInvocations(config, scratch, rows);
    assert.match(execution.stdout, /\[fixture\/correct\][^\n]*l0-02[^\n]*PASS/);
    assert.match(execution.stdout, /\[fixture\/interrupted\][^\n]*l0-02[^\n]*TIMEOUT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
