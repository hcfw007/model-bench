import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

import type { BenchConfig } from './config.ts';
import type { TurnProcess } from './turn-run-types.ts';

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function switchModelRef(cfg: BenchConfig, modelRef: string): string {
  const modelId = (ref: string): string => ref.split('#')[0];
  const { switchModel, switchFallback } = cfg.run;
  if (!switchModel) throw new Error('run.switchModel is required for model switch cases');
  const candidate = modelId(switchModel) === modelId(modelRef) ? switchFallback : switchModel;
  if (!candidate || modelId(candidate) === modelId(modelRef)) {
    throw new Error('model switch requires a different configured fallback model');
  }
  return candidate;
}

function terminateDescendants(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
}

export function runTurnProcess(
  executable: string, cwd: string, scratchLog: string, sessionArgs: string[],
  modelRef: string, prompt: string, timeoutSec: number,
): TurnProcess {
  if (process.getuid?.() === 0 || process.geteuid?.() === 0) {
    throw new Error('Refusing to start OpenCode as root');
  }
  const startedAt = Date.now();
  const args = ['run', '--auto', '--standalone', ...sessionArgs, '-m', modelRef, prompt];
  const env = { ...process.env, PWD: cwd, OPENCODE_BENCH: '1' };
  const stderr = openSync(scratchLog, 'w+', 0o600);
  try {
    const detach = process.platform !== 'win32';
    const subprocess = spawnSync(executable, args, {
      cwd,
      env,
      timeout: timeoutSec * 1000,
      killSignal: 'SIGKILL',
      detached: detach,
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', stderr],
    });
    let cleanupError: string | undefined;
    try {
      if (detach && subprocess.pid > 0) terminateDescendants(subprocess.pid);
    } catch (error: unknown) {
      cleanupError = `process group cleanup: ${errorMessage(error)}`;
    }
    const status = cleanupError ? 'error' : subprocess.error?.code === 'ETIMEDOUT' ? 'timeout'
      : subprocess.error || subprocess.status !== 0 ? 'error' : 'exited';
    const prefix = Buffer.alloc(500);
    const bytes = readSync(stderr, prefix, 0, prefix.length, 0);
    const details = prefix.subarray(0, bytes).toString('utf8').trim();
    const error = status === 'exited' ? undefined
      : [cleanupError, subprocess.error?.message ?? `CLI exited (${subprocess.status ?? subprocess.signal})`, details]
        .filter(Boolean).join(': ');
    return {
      status, exitCode: subprocess.status, signal: subprocess.signal, durationMs: Date.now() - startedAt, error,
    };
  } finally {
    closeSync(stderr);
  }
}

export function findSessionByTitle(db: DatabaseSync, title: string): string | null {
  const stmt = db.prepare('select id from session_v2 where title = ? and parent_id is null order by time_created desc limit 1');
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < 8; i++) {
    const row = stmt.get(title);
    if (typeof row?.id === 'string') return row.id;
    if (i < 7) Atomics.wait(wait, 0, 0, 500);
  }
  return null;
}
