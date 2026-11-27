/** migrate-model-ids.ts CLI：历史别名迁移为官方 id 并重算分数、重写报告。 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import type { CaseResult } from '../runners/lib/score.ts';

const ROOT = resolve(import.meta.dirname, '..');

const MAP: Record<string, string> = {
  'pro-opus': 'kiro/claude-opus-5-5',
  'flash-sonnet': 'kiro/claude-sonnet-5-5',
  gpt61: 'openai/gpt-6.1-sol',
  gpt6astra: 'openai/gpt-6-astra',
  glm53: 'volc/glm-5.3',
  glm53flash: 'volc/glm-5.3-flash',
  ds41flash: 'volc/deepseek-v4.1-flash',
};

function legacyRow(over: Partial<CaseResult>): CaseResult {
  return {
    caseId: 'l0-01', layer: 'l0', modelId: 'pro-opus', pass: true, violation: false,
    weight: 1, turns: 1, tokensInput: 1, tokensOutput: 1, durationSec: 1,
    toolErrors: {}, assertions: [], ...over,
  };
}

function runCli(...args: string[]) {
  return spawnSync(process.execPath, [resolve(ROOT, 'runners/migrate-model-ids.ts'), ...args], {
    cwd: ROOT, encoding: 'utf8',
  });
}

test('migrate-model-ids：7 组别名迁移为官方 id，重算分数并重写报告', () => {
  const dir = mkdtempSync(join(tmpdir(), 'model-bench-migrate-'));
  const rows = Object.keys(MAP).map((alias) => legacyRow({ modelId: alias }));
  rows.push(legacyRow({ modelId: 'unmapped/alias', pass: false, assertions: [{ type: 'textMatch', pass: false, detail: 'x' }] }));
  writeFileSync(resolve(dir, 'results.json'), JSON.stringify({
    config: { weights: { l0: 10, l1: 20, l2: 40, l3: 25 } },
    results: rows,
  }));

  const { status, stdout } = runCli(dir);
  assert.equal(status, 0);
  assert.match(stdout, /migrated 7 rows, models=8/);

  const rewritten = JSON.parse(readFileSync(resolve(dir, 'results.json'), 'utf8')) as {
    scores: Array<{ modelId: string; total: number }>;
    results: Array<{ modelId: string }>;
  };
  assert.deepEqual(
    [...new Set(rewritten.results.map(({ modelId }) => modelId))].sort(),
    [...Object.values(MAP), 'unmapped/alias'].sort(),
  );
  assert.equal(rewritten.scores.length, 8);
  assert.equal(rewritten.scores.find(({ modelId }) => modelId === 'unmapped/alias')!.total, 0);
  assert.ok(rewritten.scores.filter(({ modelId }) => modelId !== 'unmapped/alias').every(({ total }) => total > 0));

  const leaderboard = readFileSync(resolve(dir, 'leaderboard.md'), 'utf8');
  assert.ok(leaderboard.includes('# Leaderboard'));
  assert.ok(leaderboard.includes('kiro/claude-opus-5-5'));
  assert.ok(readFileSync(resolve(dir, 'failures.md'), 'utf8').includes('## unmapped/alias / l0-01'));
});

test('migrate-model-ids：目录缺 results.json 时跳过', () => {
  const dir = mkdtempSync(join(tmpdir(), 'model-bench-migrate-'));
  const { status, stdout } = runCli(dir);
  assert.equal(status, 0);
  assert.ok(stdout.includes(`skip (no results.json): ${dir}`));
});

test('migrate-model-ids：缺参数输出 usage', () => {
  const { status, stderr } = runCli();
  assert.equal(status, 1);
  assert.ok(stderr.includes('usage: node runners/migrate-model-ids.ts'));
});
