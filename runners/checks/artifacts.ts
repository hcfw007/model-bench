import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertArtifact, type AssertCtx } from '../lib/assert-artifacts.ts';
import { netDiff, snapshotTree } from '../lib/net-diff.ts';

const HIDDEN = 'hidden[check].txt';
const SOURCE = 'a dir/original\tname\n.txt';
const DESTINATION = 'new dir/renamed\tname\n.txt';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

function write(cwd: string, path: string, contents: string | Buffer): void {
  writeFileSync(join(cwd, path), contents);
}

function commit(cwd: string): void {
  git(cwd, '-c', 'user.name=Artifact Test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture');
}

function testAssertions(cwd: string): void {
  const ctx: AssertCtx = { worktree: cwd, trace: null, answer: '', forbidden: [], startedAt: 0 };
  for (const type of ['diffFiles', 'diffLines']) {
    const result = assertArtifact({ type }, ctx);
    assert.equal(result?.pass, false, type);
    assert.equal(result?.missingEvidence, true, type);
  }
  const withDiff = { ...ctx, netDiff: { files: ['other/index.ts', 'src2/test.ts'], lines: 3 } };
  const files = (fields: Record<string, unknown>): boolean | undefined =>
    assertArtifact({ ...fields, type: 'diffFiles' }, withDiff)?.pass;
  assert.equal(files({ mustInclude: ['index.ts'] }), false);
  assert.equal(files({ mustInclude: ['src/index.ts'] }), false);
  assert.equal(files({ mustInclude: ['other/index.ts'], mustExclude: ['src/', 'index.ts'] }), true);
  assert.equal(files({ mustExclude: ['src2/'] }), false);
  assert.equal(files({ mustExclude: ['other/index.ts'] }), false);
  assert.equal(assertArtifact({ type: 'diffLines', min: 3, max: 3 }, withDiff)?.pass, true);

  const excluded = { type: 'diffFiles', mustExclude: ['ts-projects'] };
  const excludes = (path: string): boolean | undefined =>
    assertArtifact(excluded, { ...ctx, netDiff: { files: [path], lines: 1 } })?.pass;
  assert.equal(excludes('ts-projects/api-bff/src/task.ts'), false);
  assert.equal(excludes('ts-projects-other/api-bff/src/task.ts'), true);
  assert.equal(excludes('other/ts-projects/src/task.ts'), true);
}

function testSnapshots(cwd: string): void {
  git(cwd, 'init', '-q');
  mkdirSync(join(cwd, 'a dir'));
  write(cwd, '.gitignore', '/ignored.txt\n');
  write(cwd, 'ignored.txt', 'old\n');
  write(cwd, 'preset.txt', 'old\n');
  write(cwd, HIDDEN, 'original hidden content\n');
  write(cwd, SOURCE, 'a rename keeps this original content intact\n');
  git(cwd, 'add', '-A');
  git(cwd, 'add', '-f', 'ignored.txt');
  commit(cwd);

  write(cwd, 'preset.txt', 'preset\n');
  write(cwd, 'untracked preset.txt', 'preset\n');
  const snapshot = (): string => snapshotTree(cwd, [HIDDEN]);
  const base = snapshot();
  const withHidden = snapshotTree(cwd, []);
  write(cwd, HIDDEN, 'mutated hidden content\n');
  assert.deepEqual(netDiff(cwd, base, snapshot()), { files: [], lines: 0 });
  assert.deepEqual(netDiff(cwd, withHidden, snapshotTree(cwd, [])), { files: [HIDDEN], lines: 2 });

  mkdirSync(join(cwd, 'new dir'));
  renameSync(join(cwd, SOURCE), join(cwd, DESTINATION));
  write(cwd, 'preset.txt', 'preset\nappended\n');
  write(cwd, 'binary.dat', Buffer.from([0, 1, 2]));
  write(cwd, 'hiddenC.txt', 'not really hidden\n');
  write(cwd, 'untracked preset.txt', 'changed\n');
  const unstaged = snapshot();
  git(cwd, 'add', '-A');
  const indexPath = join(cwd, '.git/index');
  const index = readFileSync(indexPath);
  assert.equal(snapshot(), unstaged);
  assert.deepEqual(readFileSync(indexPath), index);
  commit(cwd);
  assert.equal(snapshot(), unstaged);
  const diff = netDiff(cwd, base, unstaged);
  assert.deepEqual(diff.files.toSorted(), [
    SOURCE, DESTINATION, 'binary.dat', 'hiddenC.txt', 'preset.txt', 'untracked preset.txt',
  ].toSorted());
  assert.equal(diff.lines, 4);

  git(cwd, 'rm', '--cached', '-q', 'ignored.txt');
  assert.equal(snapshot(), unstaged);
  git(cwd, 'reset', '-q', 'HEAD', '--', 'ignored.txt');
  write(cwd, 'preset.txt', 'temporary\n');
  git(cwd, 'add', 'preset.txt');
  write(cwd, 'preset.txt', 'preset\nappended\n');
  assert.deepEqual(netDiff(cwd, unstaged, snapshot()), { files: [], lines: 0 });
  rmSync(join(cwd, 'binary.dat'));
  assert.deepEqual(netDiff(cwd, unstaged, snapshot()), { files: ['binary.dat'], lines: 0 });
  assert.throws(() => netDiff(cwd, base, 'nonexistent-tree'), /git diff failed/);
}

function testAddedText(cwd: string): void {
  const scope = 'go-projects/some-service';
  const elsewhere = `${scope}-other`;
  const hidden = `${scope}/hidden.ts`;
  mkdirSync(join(cwd, scope), { recursive: true });
  mkdirSync(join(cwd, elsewhere), { recursive: true });
  write(cwd, `${scope}/job.ts`, '// old idempotency\nconst job = 1;\n');
  write(cwd, hidden, '// hidden fixture\n');
  const snapshot = (): string => snapshotTree(cwd, [hidden]);
  const base = snapshot();
  const assertion = { type: 'diffAddedText', path: scope, pattern: 'idempot|幂等', flags: 'i' };
  const ctx: AssertCtx = { worktree: cwd, trace: null, answer: '', forbidden: [], startedAt: 0 };
  const check = (): boolean | undefined =>
    assertArtifact(assertion, { ...ctx, netTrees: { base, end: snapshot() } })?.pass;

  assert.equal(assertArtifact(assertion, ctx)?.missingEvidence, true);
  write(cwd, `${scope}/job.ts`, '// old idempotency\nconst job = 2;\n');
  write(cwd, `${scope}/idempotent-name.ts`, 'const metadata = true;\n');
  write(cwd, `${elsewhere}/job.ts`, '// idempotency outside scope\n');
  write(cwd, hidden, '// idempotency in hidden fixture\n');
  assert.equal(check(), false, 'ignore unchanged lines, patch headers, siblings, and hidden tests');
  write(cwd, `${scope}/job.ts`, 'const job = 2;\n');
  assert.equal(check(), false, 'ignore deleted lines');

  write(cwd, `${scope}/new-job.ts`, 'const IDEMPOTENCY_KEY = true;\n');
  assert.equal(check(), true, 'new untracked file');
  git(cwd, 'add', '-A');
  assert.equal(check(), true, 'same final content, staged');
  commit(cwd);
  assert.equal(check(), true, 'same final content, committed');
  rmSync(join(cwd, `${scope}/new-job.ts`));
  assert.equal(check(), false, 'net addition reverted');
  write(cwd, `${scope}/job.ts`, 'const job = 3; // 支持幂等\n');
  assert.equal(check(), true, 'new hunk line in an existing file');
}

export function runArtifactTests(): void {
  const cwd = mkdtempSync(join(tmpdir(), 'model-bench-artifacts-'));
  try {
    testSnapshots(cwd);
    testAssertions(cwd);
    testAddedText(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
