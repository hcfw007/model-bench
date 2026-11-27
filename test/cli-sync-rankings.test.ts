/** sync-rankings.ts CLI：发布参数校验负路径（正路径会写死根目录文件，不在此测）。 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
const GUARDED = ['README.md', 'README.en.md', 'rankings/v1.1.md'].map((file) => resolve(ROOT, file));

function runCli(...args: string[]) {
  return spawnSync(process.execPath, [resolve(ROOT, 'runners/sync-rankings.ts'), ...args], {
    cwd: ROOT, encoding: 'utf8',
  });
}

function guardedContent(): string {
  return GUARDED.map((path) => readFileSync(path, 'utf8')).join('\u0000');
}

test('sync-rankings：无效发布参数在写文件前拒绝', () => {
  const before = guardedContent();
  const cases: Array<[string[], RegExp]> = [
    [[], /usage: node runners\/sync-rankings\.ts/],
    [['--bogus'], /usage: node runners\/sync-rankings\.ts/],
    [['x', '--version', 'v1.0'], /旧榜只读，发布版本只接受 v1\.1/],
    [['x', '--evidence'], /无效发布参数: --evidence/],
    [['x', '--version', '--evidence'], /无效发布参数: --version/],
    [['x', '--version', 'v1.1', '--version', 'v1.1'], /无效发布参数: --version/],
    [['x', '--bogus', 'v'], /旧榜只读，发布版本只接受 v1\.1/],
  ];
  for (const [args, expected] of cases) {
    const { status, stderr } = runCli(...args);
    assert.notEqual(status, 0, args.join(' '));
    assert.match(stderr, expected, args.join(' '));
  }
  assert.equal(guardedContent(), before, '失败路径不得改动 README / rankings');
});
