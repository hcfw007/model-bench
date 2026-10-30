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
import { checkPartition, incompleteReasons, orderResults, type RunMeta } from './parallel.ts';
import { assertMockRepoClean, prepareReference, prepareWorkerRoot, removeWorkerRoot } from './worker.ts';

export interface ParallelRunResult {
  results: CaseResult[];
  skipped: Array<{ modelId: string; reason: string }>;
  meta: RunMeta;
}

function safeName(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '-');
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
  spec: ModelSpec;
  repeat: number;
  layers: string[];
  only: string[];
  active: Set<ChildProcess>;
}): Promise<number | null> {
  const { dir, spec, repeat, layers, only, active } = opts;
  const out = join(dir, 'out');
  const args = [
    join(dir, 'runners', 'run-bench.ts'),
    '--models', spec.id,
    '--out', out,
    '--repeat', String(repeat),
    '--concurrency', '1',
    '--layers', layers.join(','),
    ...(only.length > 0 ? ['--cases', only.join(',')] : []),
  ];
  // detached 让子进程成为独立进程组，中断时能连同 opencode 孙进程一起杀掉
  const child = spawn(process.execPath, args, {
    cwd: dir,
    detached: true,
    env: { ...process.env, PWD: dir, OPENCODE_BENCH_WORKER: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = `[${spec.id}] `;
  active.add(child);
  pipeLines(child.stdout, prefix, (line) => process.stdout.write(line));
  pipeLines(child.stderr, prefix, (line) => process.stderr.write(line));
  return new Promise((resolvePromise) => {
    child.once('error', (error) => {
      process.stderr.write(`${prefix}spawn failed: ${error.message}\n`);
      resolvePromise(null);
    });
    child.once('close', (code) => {
      active.delete(child);
      resolvePromise(code);
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
}): Promise<ParallelRunResult> {
  const { cfg, configPath, repoRoot, cases, specs, repeat, concurrency, layers, only, outDir } = opts;
  assertMockRepoClean(cfg.bench.mockRepo);
  mkdirSync(outDir, { recursive: true });

  const caseIds = cases.map((c) => c.id);
  const startedAt = new Date();
  const base = mkdtempSync(join(tmpdir(), 'model-bench-run-'));
  const workersDir = join(base, 'workers');
  mkdirSync(workersDir, { recursive: true });

  const parts = new Map<string, CaseResult[]>();
  const incomplete = new Map<string, string>();
  const durations = new Map<string, number>();
  const activeChildren = new Set<ChildProcess>();
  let reference: { dir: string; commit: string };

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
    await pool(specs, concurrency, async (spec, index) => {
      const started = Date.now();
      try {
        const layout = prepareWorkerRoot({
          reference: reference.dir,
          referenceCommit: reference.commit,
          dest: join(workersDir, `${String(index).padStart(2, '0')}-${safeName(spec.id)}`),
        });
        process.stdout.write(`[${spec.id}] 测试床 ${layout.dir} @ ${layout.commit.slice(0, 7)}\n`);
        const code = await runWorker({ dir: layout.dir, spec, repeat, layers, only, active: activeChildren });
        const partial = join(layout.dir, 'out', 'results.partial.json');
        if (!existsSync(partial)) {
          incomplete.set(spec.id, `子进程退出码 ${code}，无结果文件`);
          return;
        }
        const rows = JSON.parse(readFileSync(partial, 'utf8')) as CaseResult[];
        const check = checkPartition(spec.id, rows, caseIds, repeat);
        if (!check.ok) {
          incomplete.set(spec.id, `${check.error}（退出码 ${code}）`);
          return;
        }
        parts.set(spec.id, rows);
        // 每完成一个模型就把已合并结果落盘，进程中断也不丢已完成模型
        try {
          writeFileSync(
            join(outDir, 'results.partial.json'),
            JSON.stringify(orderResults(specs.map((s) => s.id), caseIds, repeat, parts), null, 2),
          );
        } catch (error) {
          process.stderr.write(`[${spec.id}] 快照写入失败（不影响计分）：${(error as Error).message}\n`);
        }
        if (code !== 0) process.stderr.write(`[${spec.id}] 警告：退出码 ${code}，但结果完整，按已有结果计分\n`);
      } catch (error) {
        parts.delete(spec.id);
        incomplete.set(spec.id, (error as Error).message);
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

  const results = orderResults(specs.map((s) => s.id), caseIds, repeat, parts);
  const skipped = incompleteReasons(specs.map((s) => s.id), parts, incomplete);

  return {
    results,
    skipped,
    meta: {
      mode: 'parallel',
      concurrency,
      mockRepoCommit: reference.commit,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      wallSec: Math.round((Date.now() - startedAt.getTime()) / 1000),
      workers: specs.map((s) => ({
        modelId: s.id,
        status: incomplete.has(s.id) ? 'incomplete' as const : 'complete' as const,
        ...(incomplete.has(s.id) ? { reason: incomplete.get(s.id) } : {}),
        durationSec: durations.get(s.id),
      })),
    },
  };
}
