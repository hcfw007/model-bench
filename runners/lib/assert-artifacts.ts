import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { netAddedLines, type NetDiff, type NetTrees } from './net-diff.ts';
import type { Trace } from './trace.ts';

export interface AssertCtx {
  worktree: string;
  trace: Trace | null;
  answer: string;
  forbidden: string[];
  startedAt: number;
  netDiff?: NetDiff;
  netTrees?: NetTrees;
}

export interface AssertResult {
  type: string;
  pass: boolean;
  detail: string;
  missingEvidence?: boolean;
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

function matchesExcludedPath(path: string, excluded: string): boolean {
  const prefix = excluded.endsWith('/') ? excluded : `${excluded}/`;
  return path === excluded || path.startsWith(prefix);
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

  if (type === 'diffFiles' || type === 'diffLines') {
    const diff = ctx.netDiff;
    if (!diff) return { type, pass: false, missingEvidence: true, detail: 'missing net diff evidence' };

    const { files, lines } = diff;
    if (type === 'diffLines') {
      const max = Number(a.max ?? Number.POSITIVE_INFINITY);
      const min = Number(a.min ?? 0);
      return { type, pass: lines >= min && lines <= max, detail: `lines=${lines} range=[${min},${max}]` };
    }

    const mustInclude = (a.mustInclude as string[] | undefined) ?? [];
    const mustExclude = (a.mustExclude as string[] | undefined) ?? [];
    const missing = mustInclude.filter((path) => !files.includes(path));
    const violated = mustExclude.filter((excluded) => files.some((path) => matchesExcludedPath(path, excluded)));
    return {
      type,
      pass: missing.length === 0 && violated.length === 0,
      detail: `changed=${JSON.stringify(files)} missing=${JSON.stringify(missing)} violated=${JSON.stringify(violated)}`,
    };
  }

  if (type === 'diffAddedText') {
    if (!ctx.netTrees) return { type, pass: false, missingEvidence: true, detail: 'missing net trees evidence' };
    const path = String(a.path);
    const pattern = new RegExp(String(a.pattern), String(a.flags ?? ''));
    const pass = netAddedLines(ctx.worktree, ctx.netTrees, path).some((line: string): boolean => {
      pattern.lastIndex = 0;
      return pattern.test(line);
    });
    return { type, pass, detail: `added line match=${pass} path=${path}` };
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
