import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, rmSync, type Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';

export interface NetDiff {
  files: string[];
  lines: number;
}

export interface NetTrees {
  readonly base: string;
  readonly end: string;
}

const GIT_TIMEOUT_MS = 180_000;
const GIT_OUTPUT_LIMIT = 32 * 1024 * 1024;

function git(cwd: string, args: string[], index?: string, input?: string): string {
  try {
    const output = execFileSync('git', args, {
      cwd, input, stdio: ['pipe', 'pipe', 'pipe'],
      env: index === undefined ? process.env : { ...process.env, GIT_INDEX_FILE: index },
      timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_OUTPUT_LIMIT,
    });
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(output);
  } catch (error) {
    throw new Error(`git ${args[0]} failed in ${cwd}: ${String(error)}`, { cause: error });
  }
}

function nulFields(output: string): string[] {
  if (output === '') return [];
  if (!output.endsWith('\0')) throw new Error('Git output is missing its NUL terminator');
  return output.slice(0, -1).split('\0');
}

function workingStat(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return undefined;
    }
    throw error;
  }
}

function isWorktreeEntry(cwd: string, path: string): boolean {
  // A formerly tracked child may now be behind a symlink; never sample outside the worktree.
  const components = path.split('/');
  let parent = cwd;
  for (const component of components.slice(0, -1)) {
    parent = join(parent, component);
    if (!workingStat(parent)?.isDirectory()) return false;
  }
  const stat = workingStat(join(cwd, path));
  if (stat?.isSymbolicLink() || stat?.isFile()) return true;
  return stat?.isDirectory() === true && workingStat(join(cwd, path, '.git')) !== undefined;
}

export function snapshotTree(cwd: string, exclude: string[]): string {
  const excluded = exclude.map((path) => posix.normalize(path).replace(/\/$/, ''));
  const headPaths = nulFields(git(cwd, ['ls-tree', '-r', '--name-only', '-z', 'HEAD']));
  const indexAndUntrackedPaths = nulFields(git(cwd, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']));
  const paths = [...new Set([...headPaths, ...indexAndUntrackedPaths.map((path) => path.replace(/\/$/, ''))])]
    .filter((path) => !excluded.some((entry) => path === entry || path.startsWith(`${entry}/`)))
    .filter((path) => isWorktreeEntry(cwd, path));

  const indexDir = mkdtempSync(join(tmpdir(), 'model-bench-index-'));
  const index = join(indexDir, 'index');
  try {
    // Only use HEAD and real index for enumeration; hash current worktree contents into a fresh index.
    if (paths.length > 0) {
      git(cwd, ['update-index', '--add', '-z', '--stdin'], index, `${paths.join('\0')}\0`);
    }
    return git(cwd, ['write-tree'], index).trim();
  } finally {
    rmSync(indexDir, { recursive: true, force: true });
  }
}

export function netDiff(cwd: string, base: string, end: string): NetDiff {
  const output = git(cwd, [
    'diff', '--numstat', '-z', '--find-renames', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none',
    base, end, '--',
  ]);
  const records = nulFields(output);
  const files = new Set<string>();
  let lines = 0;
  for (let i = 0; i < records.length; i += 1) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(records[i]);
    if (!match) throw new Error('Malformed Git numstat record');
    const [, added, deleted, path] = match;
    lines += (added === '-' ? 0 : Number(added)) + (deleted === '-' ? 0 : Number(deleted));
    if (path !== '') {
      files.add(path);
      continue;
    }
    const before = records[++i];
    const after = records[++i];
    if (!before || !after) throw new Error('Missing rename paths in Git numstat output');
    files.add(before);
    files.add(after);
  }
  return { files: [...files], lines };
}

export function netAddedLines(cwd: string, trees: NetTrees, path: string): string[] {
  const patch = git(cwd, [
    '--literal-pathspecs', 'diff', '--patch', '--unified=0', '--inter-hunk-context=0', '--find-renames',
    '--no-color', '--no-ext-diff', '--no-textconv', '--output-indicator-new=+',
    trees.base, trees.end, '--', path,
  ]);
  const added: string[] = [];
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) inHunk = false;
    else if (line.startsWith('@@ ')) inHunk = true;
    else if (inHunk && line.startsWith('+')) added.push(line.slice(1));
  }
  return added;
}
