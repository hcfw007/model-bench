import {
  appendFileSync, chmodSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import type { CaseDef } from './runner.ts';

export interface HiddenTest {
  readonly path: string;
  readonly bytes: Buffer;
  readonly mode: number;
}

function statIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function inside(root: string, path: string): string {
  const rel = relative(root, resolve(root, path));
  if (!rel || isAbsolute(path) || rel === '..' || rel.startsWith(`..${sep}`) || rel.split(sep).includes('.git')) {
    throw new Error(`invalid fixture path: ${path}`);
  }
  return rel;
}

function safeTarget(root: string, rel: string): string | null {
  let current = root;
  for (const step of [null, ...rel.split(sep).slice(0, -1)]) {
    if (step) current = resolve(current, step);
    const stat = statIfPresent(current);
    if (stat && !stat.isDirectory()) return null;
  }
  return resolve(root, rel);
}

export function prepareWorkspace(cwd: string, casesRoot: string, caseDef: CaseDef): HiddenTest[] {
  for (const [files, write] of [
    [caseDef.setup?.files, writeFileSync],
    [caseDef.setup?.append, appendFileSync],
  ] as const) {
    for (const [path, content] of Object.entries(files ?? {})) {
      const target = safeTarget(cwd, inside(cwd, path));
      if (!target) throw new Error(`invalid setup parent: ${path}`);
      const stat = statIfPresent(target);
      if (stat && (!stat.isFile() || stat.nlink !== 1)) throw new Error(`unsafe setup target: ${path}`);
      mkdirSync(dirname(target), { recursive: true });
      write(target, content, 'utf8');
    }
  }
  const hidden = (caseDef.hiddenTests ?? []).map((spec): HiddenTest => {
    const [from, to, extra] = spec.split('->').map((part) => part.trim());
    if (!from || !to || extra !== undefined) throw new Error(`invalid hidden test: ${spec}`);
    const source = resolve(casesRoot, inside(casesRoot, from));
    const mode = lstatSync(source).mode & 0o777;
    return { path: inside(cwd, to), bytes: readFileSync(source), mode };
  });
  if (new Set(hidden.map(({ path }) => path)).size !== hidden.length) throw new Error('duplicate hidden test target');
  restoreHiddenTests(cwd, hidden);
  return hidden;
}

export function hiddenTestsIntact(cwd: string, hidden: readonly HiddenTest[]): boolean {
  return hidden.every(({ path, bytes, mode }) => {
    const target = safeTarget(cwd, path);
    const stat = target ? statIfPresent(target) : undefined;
    return Boolean(target && stat?.isFile() && stat.nlink === 1
      && (stat.mode & 0o777) === mode && readFileSync(target).equals(bytes));
  });
}

export function restoreHiddenTests(cwd: string, hidden: readonly HiddenTest[]): void {
  for (const { path, bytes, mode } of hidden) {
    const target = safeTarget(cwd, path);
    if (!target) throw new Error(`unsafe hidden test parent: ${path}`);
    mkdirSync(dirname(target), { recursive: true });
    if (statIfPresent(target)) unlinkSync(target);
    writeFileSync(target, bytes, { flag: 'wx', mode });
    chmodSync(target, mode);
  }
}
