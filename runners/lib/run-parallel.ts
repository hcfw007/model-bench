/**
 * 并行执行：启动时冻结一份参考快照，每个模型从快照复制出独立测试床。
 * 公平性约束：同一份配置/用例/代码字节、同一 mockrepo 提交、同一超时与断言。
 * 并行只改变调度，不改变每个 case 的判分逻辑；结果按固定顺序合并。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BenchConfig, ModelSpec } from './config.ts';
import type { CaseDef } from './runner.ts';
import type { CaseResult } from './score.ts';
import type { RunMeta } from './parallel.ts';
import { digestOf, expectedSlots, slotKey, type BenchMode, type ProtocolLock, type RepairPlan } from './protocol.ts';
import { freezeProtocol, resolveIdentities } from './protocol-freeze.ts';
import { validateRows } from './protocol-validate.ts';
import { assertMockRepoClean, prepareReference, prepareWorkerRoot, removeWorkerRoot } from './worker.ts';
import { deliveryProofBlocker, preflightMatches, runIsolationPreflight } from './protocol-isolation.ts';
import type { IsolationProof } from './scenario-isolation.ts';

export interface ParallelRunResult {
  results: CaseResult[];
  protocol: ProtocolLock;
  meta: RunMeta;
}

function safeName(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '-');
}

function fillMissing(protocol: ProtocolLock, modelId: string, rows: CaseResult[], reason: string): CaseResult[] {
  const seen = new Map(rows.map((row) => [slotKey(modelId, { caseId: row.caseId, repeatIndex: row.repeatIndex! }), row]));
  const cases = new Map(protocol.manifest.cases.map((row) => [row.id, row]));
  return expectedSlots(protocol).filter((slot) => slot.modelId === modelId).map((slot) => {
    const caseDef = cases.get(slot.caseId)!;
    return seen.get(slotKey(modelId, slot)) ?? {
      ...slot, layer: caseDef.layer, weight: caseDef.weight,
      outcome: 'error', error: reason, pass: false, violation: false,
      turns: 0, tokensInput: 0, tokensOutput: 0, durationSec: 0, toolErrors: {}, assertions: [],
    };
  });
}

/** 固定的槽位数，跑完即取下一个模型；同时最多 limit 个模型在执行 */
async function pool<T>(items: T[], limit: number, task: (item: T, index: number) => Promise<void>): Promise<void> {
  let cursor = 0;
  const slots = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      await task(items[index], index);
    }
  });
  await Promise.all(slots);
}

interface LineSource {
  on(event: 'data', listener: (chunk: unknown) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
}

interface WorkerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export function recoverWorkerRows(lock: ProtocolLock, raw: unknown): { rows: CaseResult[]; rejected: number } {
  if (!Array.isArray(raw)) return { rows: [], rejected: 1 };
  const slots = new Map<string, CaseResult>();
  const conflicts = new Set<string>();
  let rejected = 0;
  for (const candidate of raw as CaseResult[]) {
    try {
      validateRows(lock, [candidate], true);
    } catch {
      rejected += 1;
      continue;
    }
    const key = slotKey(candidate.modelId, { caseId: candidate.caseId, repeatIndex: candidate.repeatIndex! });
    const previous = slots.get(key);
    if (!previous && !conflicts.has(key)) {
      slots.set(key, candidate);
      continue;
    }
    rejected += 1;
    if (candidate.outcome === 'violation') slots.set(key, candidate);
    else if (previous && (previous.outcome === 'violation' || digestOf(previous) === digestOf(candidate))) continue;
    else if (previous) {
      conflicts.add(key);
      slots.delete(key);
    }
  }
  return { rows: [...slots.values()], rejected };
}

function pipeLines(stream: LineSource, prefix: string, write: (line: string) => void): void {
  let buffer = '';
  stream.on('data', (chunk: unknown) => {
    buffer += String(chunk);
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) write(`${prefix}${line}\n`);
  });
  stream.on('end', () => {
    if (buffer.length > 0) write(`${prefix}${buffer}\n`);
    buffer = '';
  });
}

function runWorker(opts: {
  dir: string;
  modelId: string;
  protocol: ProtocolLock;
  isolationConfigPath?: string;
  active: Set<ChildProcess>;
}): Promise<WorkerExit> {
  const { dir, modelId, protocol, active, isolationConfigPath } = opts;
  const out = join(dir, 'out');
  writeFileSync(join(dir, 'protocol.lock.json'), JSON.stringify(protocol, null, 2), { flag: 'wx' });
  const args = [join(dir, 'runners', 'run-bench.ts'), '--models', modelId, '--out', out,
    ...(isolationConfigPath ? ['--isolation-config', isolationConfigPath] : [])];
  // detached 让子进程成为独立进程组，中断时能连同 opencode 孙进程一起杀掉
  const child = spawn(process.execPath, args, {
    cwd: dir,
    detached: true,
    env: { ...process.env, PWD: dir, OPENCODE_BENCH_WORKER: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = `[${modelId}] `;
  active.add(child);
  pipeLines(child.stdout, prefix, (line) => process.stdout.write(line));
  pipeLines(child.stderr, prefix, (line) => process.stderr.write(line));
  return new Promise((resolvePromise) => {
    child.once('error', (error) => {
      process.stderr.write(`${prefix}spawn failed: ${error.message}\n`);
    });
    child.once('close', (code, signal) => {
      active.delete(child);
      resolvePromise({ code, signal });
    });
  });
}

export async function runParallelModels(opts: {
  cfg: BenchConfig;
  configPath: string;
  repoRoot: string;
  cases: CaseDef[];
  specs: ModelSpec[];
  repeat: number;
  concurrency: number;
  layers: string[];
  only: string[];
  outDir: string;
  mode: BenchMode;
  repair?: RepairPlan;
  expectedDigest?: string;
  expectedPreflight?: readonly IsolationProof[];
  isolationConfigPath?: string;
}): Promise<ParallelRunResult> {
  const { cfg, configPath, repoRoot, cases, specs, repeat, concurrency, layers, only, outDir, mode, repair, expectedDigest, expectedPreflight, isolationConfigPath } = opts;
  if (mode === 'formal' && !isolationConfigPath) throw new Error('正式运行缺少隔离预检参数');
  const isolated = isolationConfigPath ? runIsolationPreflight(isolationConfigPath, specs.map(({ id }) => id)) : undefined;
  const preflight = isolated?.preflight;
  if (repair && (!preflight || !expectedPreflight || preflight.some((proof) =>
    expectedPreflight.some((prior) => prior.containerId === proof.containerId) || !expectedPreflight.some((prior) =>
      prior.modelId === proof.modelId && preflightMatches(prior, proof))))) {
    throw new Error('补槽模型或交付权威身份与主运行不一致');
  }
  assertMockRepoClean(cfg.bench.mockRepo);
  mkdirSync(outDir, { recursive: true });

  const startedAt = new Date();
  const base = mkdtempSync(join(tmpdir(), 'model-bench-run-'));
  const workersDir = join(base, 'workers');
  mkdirSync(workersDir, { recursive: true });

  const parts = new Map<string, CaseResult[]>();
  const incomplete = new Map<string, string>();
  const durations = new Map<string, number>();
  const exits = new Map<string, WorkerExit>();
  const activeChildren = new Set<ChildProcess>();
  let reference: { dir: string; commit: string };
  let protocol: ProtocolLock;

  const stop = async (): Promise<never> => {
    const waits = [...activeChildren].map((child) => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch {
        try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
      }
      return new Promise<void>((done) => child.once('close', () => done()));
    });
    await Promise.race([Promise.all(waits), new Promise<void>((done) => setTimeout(done, 3000))]);
    if (!cfg.run.keepWorktree) removeWorkerRoot(base);
    process.exit(130);
  };
  const onSigint = (): void => void stop();
  const onSigterm = (): void => void stop();
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  try {
    // 快照在启动时冻结：后续源仓/文件变化不会影响本次跑分
    reference = prepareReference({
      repoRoot,
      dest: join(base, 'reference'),
      configPath,
      mockRepo: cfg.bench.mockRepo,
    });
    protocol = freezeProtocol({
      root: reference.dir, mockRepoCommit: reference.commit, mode, concurrency, repeat, layers, only,
      models: resolveIdentities(specs), repair, preflight,
      isolation: isolated?.deployment,
    });
    if (JSON.stringify(protocol.manifest.cases.map(({ id }) => id)) !== JSON.stringify(cases.map(({ id }) => id))) {
      throw new Error('参考快照的用例集发生变化');
    }
    if (expectedDigest !== undefined && protocol.digest !== expectedDigest) throw new Error('当前环境与主运行的协议锁不一致');
    writeFileSync(join(outDir, 'protocol.lock.json'), `${JSON.stringify(protocol, null, 2)}\n`, { flag: 'wx' });
    await pool(specs, concurrency, async (spec, index) => {
      const started = Date.now();
      try {
        const layout = prepareWorkerRoot({
          reference: reference.dir,
          referenceCommit: reference.commit,
          dest: join(workersDir, `${String(index).padStart(2, '0')}-${safeName(spec.id)}`),
        });
        process.stdout.write(`[${spec.id}] 测试床 ${layout.dir} @ ${layout.commit.slice(0, 7)}\n`);
        const exit = await runWorker({ dir: layout.dir, modelId: spec.id, protocol, active: activeChildren, isolationConfigPath });
        exits.set(spec.id, exit);
        const partial = join(layout.dir, 'out', 'results.partial.json');
        const raw = existsSync(partial) ? readFileSync(partial, 'utf8') : '[]';
        writeFileSync(join(outDir, `worker-${index}.json`), raw, { flag: 'wx' });
        const slots = expectedSlots(protocol).filter(({ modelId }) => modelId === spec.id);
        const workerLock = { ...protocol, models: protocol.models.filter(({ id }) => id === spec.id),
          ...(protocol.repair ? { repair: { ...protocol.repair, slots } } : {}) };
        const { rows, rejected } = recoverWorkerRows(workerLock, JSON.parse(raw));
        const reason = `worker exit=${exit.signal ?? exit.code}，缺槽 ${slots.length - rows.length}，无效/冲突记录 ${rejected}`;
        if (exit.code !== 0 || rejected > 0 || rows.length !== slots.length) incomplete.set(spec.id, reason);
        const expected = protocol.preflight?.find(({ modelId }) => modelId === spec.id);
        const verifiedRows = expected ? rows.map((row): CaseResult => {
          if (row.violation || row.outcome === 'missing_evidence' || row.outcome === 'error') return row;
          const failure = deliveryProofBlocker(row, expected);
          if (!failure) return row;
          return { ...row, outcome: 'missing_evidence', pass: false, error: [row.error, failure].filter(Boolean).join('\n') };
        }) : rows;
        parts.set(spec.id, fillMissing(protocol, spec.id, verifiedRows, reason));
        // 每完成一个模型就把已合并结果落盘，进程中断也不丢已完成模型
        try {
          writeFileSync(
            join(outDir, 'results.partial.json'),
            JSON.stringify(specs.flatMap(({ id }) => parts.get(id) ?? []), null, 2),
          );
        } catch (error) {
          process.stderr.write(`[${spec.id}] 快照写入失败（不影响计分）：${(error as Error).message}\n`);
        }
      } catch (error) {
        incomplete.set(spec.id, error instanceof Error ? error.message : String(error));
        parts.set(spec.id, fillMissing(protocol, spec.id, [], incomplete.get(spec.id)!));
        process.stderr.write(`[${spec.id}] 失败：${(error as Error).message}\n`);
      } finally {
        durations.set(spec.id, Math.round((Date.now() - started) / 1000));
        process.stdout.write(`[${spec.id}] 结束，用时 ${durations.get(spec.id)}s\n`);
      }
    });
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    if (cfg.run.keepWorktree) {
      process.stdout.write(`保留测试床目录：${base}\n`);
    } else {
      removeWorkerRoot(base);
    }
  }

  const results = specs.flatMap(({ id }) => parts.get(id) ?? []);

  return {
    results,
    protocol,
    meta: {
      mode: concurrency === 1 ? 'serial' : 'parallel',
      concurrency,
      mockRepoCommit: reference.commit,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      wallSec: Math.round((Date.now() - startedAt.getTime()) / 1000),
      workers: specs.map((s) => ({
        modelId: s.id,
        status: incomplete.has(s.id) ? 'incomplete' as const : 'complete' as const,
        ...(incomplete.has(s.id) ? { reason: incomplete.get(s.id) } : {}),
        ...(exits.has(s.id) ? { exitCode: exits.get(s.id)!.code, signal: exits.get(s.id)!.signal } : {}),
        durationSec: durations.get(s.id),
      })),
    },
  };
}
