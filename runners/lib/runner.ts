import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { collectTrace, type Trace } from './trace.ts';
import { assertArtifact, type AssertCtx, type AssertResult } from './assert-artifacts.ts';
import { assertTrajectory } from './assert-trajectory.ts';
import type { BenchConfig } from './config.ts';
import { resolveModelRef } from './config.ts';
import { createWorktree, installHiddenTests, removeWorktree } from './worktree.ts';
import type { CaseResult } from './score.ts';

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
  assertions: Array<Record<string, unknown>>;
}

export interface RunOpts {
  cfg: BenchConfig;
  casesRoot: string;
  caseDef: CaseDef;
  modelId: string;
  modelRef: string;
  idx: number;
}

function opencode(cfg: BenchConfig, cwd: string, args: string[], timeoutSec: number): { out: string; err: string } {
  const r = spawnSync(cfg.bench.opencodeBin, [args[0], '--auto', '--standalone', ...args.slice(1)], {
    cwd,
    encoding: 'utf8',
    timeout: timeoutSec * 1000,
    env: { ...process.env, PWD: cwd, OPENCODE_BENCH: '1' },
  });
  return { out: r.stdout ?? '', err: (r.stderr ?? '') + (r.error ? String(r.error) : '') };
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function findSessionByTitle(db: DatabaseSync, title: string): string | null {
  for (let i = 0; i < 8; i++) {
    const row = db
      .prepare('select id from session_v2 where title = ? order by time_created desc limit 1')
      .get(title) as { id: string } | undefined;
    if (row?.id) return row.id;
    sleepMs(500);
  }
  return null;
}

export function runCase(opts: RunOpts): CaseResult {
  const { cfg, caseDef, modelId, modelRef, idx } = opts;
  const useWorktree = caseDef.worktree !== false;
  const handle = useWorktree
    ? createWorktree(cfg.bench.mockRepo, cfg.bench.worktreeRoot, caseDef.id, modelId, idx)
    : null;
  const cwd = handle ? handle.dir : cfg.bench.mockRepo;

  if (handle && caseDef.hiddenTests) {
    installHiddenTests(opts.casesRoot, handle.dir, caseDef.hiddenTests);
  }

  const startedAt = Date.now();
  const timeoutSec = caseDef.timeoutSec ?? cfg.run.timeoutSec;
  const db = new DatabaseSync(cfg.bench.dbPath, { readOnly: true });
  // 用唯一 title 关联会话：opencode 的 directory 会被解析成项目根，不可靠
  const title = `bench ${caseDef.id} ${modelId} r${idx} ${startedAt}`;

  let stdout = '';
  let lastErr = '';
  let sessionId: string | null = null;

  const first = opencode(cfg, cwd, ['run', '--title', title, '-m', modelRef, caseDef.prompt], timeoutSec);
  stdout += first.out;
  lastErr += first.err;
  sessionId = findSessionByTitle(db, title);

  const switchAfter = caseDef.switchModelAfterTurn;
  for (let i = 0; i < (caseDef.followUps ?? []).length; i++) {
    const msg = caseDef.followUps![i];
    const useSwitch = switchAfter !== undefined && i + 1 >= switchAfter;
    // 切换到一个不同于当前的模型，验证切换后的上下文连续性
    const alt = cfg.models.find((m) => m.id !== modelId);
    const switchRef = alt ? resolveModelRef(alt.model) + (alt.variant ? `#${alt.variant}` : '') : modelRef;
    const args = sessionId
      ? ['run', '--session', sessionId, '-m', useSwitch ? switchRef : modelRef, msg]
      : ['run', '-m', modelRef, msg];
    const r = opencode(cfg, cwd, args, timeoutSec);
    stdout += r.out;
    lastErr += r.err;
    if (!sessionId) sessionId = findSessionByTitle(db, title);
  }

  const trace: Trace | null = collectTrace(db, sessionId);
  const answer = (trace?.finalText && trace.finalText.trim().length > 0 ? trace.finalText : stdout) ?? '';

  // 断言前重装隐藏测试，防止模型改写/删除它
  if (handle && caseDef.hiddenTests) {
    installHiddenTests(opts.casesRoot, handle.dir, caseDef.hiddenTests);
  }

  const ctx: AssertCtx = {
    worktree: cwd,
    trace,
    answer,
    forbidden: cfg.safety.forbiddenCommands,
    startedAt,
  };

  // 安全断言永远先跑
  const assertions: AssertResult[] = [];
  if (trace) {
    const guard = assertTrajectory({ type: 'noForbidden' }, ctx);
    if (guard) assertions.push(guard);
  }
  for (const a of caseDef.assertions) {
    const res = assertArtifact(a, ctx) ?? assertTrajectory(a, ctx);
    assertions.push(res ?? { type: String(a.type), pass: false, detail: 'unsupported assertion' });
  }

  const violation = assertions.some((a) => a.type === 'noForbidden' && !a.pass);
  const pass = assertions.every((a) => a.pass) && !violation;

  db.close();
  if (handle && !cfg.run.keepWorktree) removeWorktree(cfg.bench.mockRepo, handle);

  return {
    caseId: caseDef.id,
    layer: caseDef.layer,
    modelId,
    pass,
    violation,
    weight: caseDef.weight ?? 1,
    turns: trace?.turns ?? 0,
    tokensInput: trace?.tokensInput ?? 0,
    tokensOutput: trace?.tokensOutput ?? 0,
    durationSec: trace?.durationSec ?? 0,
    toolErrors: trace?.toolErrors ?? {},
    assertions,
    error: lastErr.trim().slice(0, 500) || undefined,
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
