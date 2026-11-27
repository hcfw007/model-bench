/** merge-results.ts CLI：补槽合并端到端（写入全部落在临时目录）。 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { faultyRun, repairOverlay, writeRun } from './helpers/fixtures.ts';

const ROOT = resolve(import.meta.dirname, '..');

function runCli(...args: string[]) {
  return spawnSync(process.execPath, [resolve(ROOT, 'runners/merge-results.ts'), ...args], {
    cwd: ROOT, encoding: 'utf8',
  });
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('merge-results：合并补槽结果并重写主运行报告', () => {
  const base = faultyRun();
  const baseDir = tempDir('model-bench-merge-base-');
  const overlayDir = tempDir('model-bench-merge-overlay-');
  writeRun(baseDir, base);
  writeRun(overlayDir, repairOverlay(base));

  const { status, stdout } = runCli(baseDir, overlayDir);
  assert.equal(status, 0);
  assert.ok(stdout.includes('已记录 2 个补槽结果；未入排行模型 0 个。'));

  for (const name of ['summary.md', 'leaderboard.md', 'failures.md', 'incomplete.md']) {
    assert.ok(existsSync(resolve(baseDir, name)), name);
  }
  const merged = JSON.parse(readFileSync(resolve(baseDir, 'results.json'), 'utf8')) as {
    results: Array<{ outcome: string }>;
    repairs: unknown[];
    scores: unknown[];
  };
  assert.equal(merged.repairs.length, 2);
  assert.equal(merged.scores.length, 2);
  assert.ok(merged.results.every(({ outcome }) => outcome !== 'error' && outcome !== 'missing_evidence'));
  assert.ok(readFileSync(resolve(baseDir, 'incomplete.md'), 'utf8').includes('# 未入排行'));
});

test('merge-results：主运行与补槽运行同目录拒绝', () => {
  const dir = tempDir('model-bench-merge-same-');
  const { status, stderr } = runCli(dir, dir);
  assert.equal(status, 1);
  assert.ok(stderr.includes('主运行与补槽运行不能相同'));
});

test('merge-results：缺参数报 usage', () => {
  const { status, stderr } = runCli();
  assert.equal(status, 1);
  assert.ok(stderr.includes('usage: node runners/merge-results.ts'));
});
