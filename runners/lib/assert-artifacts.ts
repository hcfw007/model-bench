import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Trace } from './trace.ts';

export interface AssertCtx {
  worktree: string;
  trace: Trace | null;
  answer: string;
  forbidden: string[];
  startedAt: number;
}

export interface AssertResult {
  type: string;
  pass: boolean;
  detail: string;
}

function sh(cmd: string, cwd: string, timeout = 180000): { code: number; out: string } {
  try {
    const out = execSync(cmd, { cwd, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

/** 按路径边界匹配文件名：避免 RoomConfirmListPanel.tsx 被当成 ConfirmListPanel.tsx */
export function matchFile(p: string, f: string): boolean {
  return p === f || p.endsWith('/' + f);
}

export function changedFiles(wt: string): string[] {
  const por = sh('git status --porcelain', wt).out;
  return por
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => l.slice(3).trim().replace(/^"|"$/g, ''));
}

export function changedLines(wt: string): number {
  let total = 0;
  const numstat = sh('git diff --numstat', wt).out;
  for (const line of numstat.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    total += (Number(parts[0]) || 0) + (Number(parts[1]) || 0);
  }
  const untracked = sh('git ls-files --others --exclude-standard', wt).out;
  for (const f of untracked.split('\n').filter(Boolean)) {
    try {
      total += readFileSync(resolve(wt, f), 'utf8').split('\n').length;
    } catch {
      /* ignore */
    }
  }
  return total;
}

export function assertArtifact(a: Record<string, unknown>, ctx: AssertCtx): AssertResult | null {
  const type = String(a.type);

  if (type === 'cmd') {
    const r = sh(String(a.run), ctx.worktree, Number(a.timeoutSec ?? 180) * 1000);
    const expect = String(a.expect ?? 'exit0');
    if (expect === 'empty') {
      return { type, pass: r.out.trim() === '', detail: `out=${r.out.trim().slice(0, 200)}` };
    }
    const ok = expect === 'exit0' ? r.code === 0 : r.code !== 0;
    return { type, pass: ok, detail: `exit=${r.code} ${r.out.slice(0, 300)}` };
  }

  if (type === 'diffFiles') {
    const files = changedFiles(ctx.worktree);
    const mustInclude = (a.mustInclude as string[] | undefined) ?? [];
    const mustExclude = (a.mustExclude as string[] | undefined) ?? [];
    const missing = mustInclude.filter((f) => !files.some((x) => matchFile(x, f)));
    const violated = mustExclude.filter((f) => files.some((x) => matchFile(x, f)));
    return {
      type,
      pass: missing.length === 0 && violated.length === 0,
      detail: `changed=${files.join(',')} missing=${missing.join(',')} violated=${violated.join(',')}`,
    };
  }

  if (type === 'diffLines') {
    const n = changedLines(ctx.worktree);
    const max = Number(a.max ?? Number.POSITIVE_INFINITY);
    const min = Number(a.min ?? 0);
    return { type, pass: n >= min && n <= max, detail: `lines=${n} range=[${min},${max}]` };
  }

  if (type === 'fileContains' || type === 'fileNotContains') {
    const path = resolve(ctx.worktree, String(a.path));
    let content = '';
    try {
      content = readFileSync(path, 'utf8');
    } catch {
      return { type, pass: false, detail: `missing file ${a.path}` };
    }
    const hit = new RegExp(String(a.pattern), 'm').test(content);
    return { type, pass: type === 'fileContains' ? hit : !hit, detail: `hit=${hit} path=${a.path}` };
  }

  return null;
}
