/** latency.ts CLI：会话耗时拆解（假 HOME + 假 opencode.db）。 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { writeSessionDb } from './helpers/fixtures.ts';

const ROOT = resolve(import.meta.dirname, '..');

function runCli(home: string, ...args: string[]) {
  return spawnSync(process.execPath, [resolve(ROOT, 'runners/latency.ts'), ...args], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, HOME: home },
  });
}

test('latency：拆解模型生成、工具执行与未解释间隔', () => {
  const home = mkdtempSync(join(tmpdir(), 'model-bench-home-'));
  writeSessionDb(resolve(home, '.local/share/opencode/opencode.db'), [{
    id: 'ses_latency', title: 'bench l1-05 bench/a formal-run', timeCreated: 0, timeUpdated: 10000,
    messages: [
      {
        seq: 1, type: 'assistant',
        data: {
          time: { created: 1000, streamed: 3000, completed: 3500 },
          content: [
            { type: 'reasoning', text: 'abcde' },
            { type: 'tool', name: 'read', state: { time: { created: 3500, completed: 4500 } } },
          ],
        },
      },
      {
        seq: 2, type: 'assistant',
        data: {
          time: { created: 5000, streamed: 6000, completed: 6000 },
          content: [{ type: 'text', text: '结论' }],
        },
      },
    ],
  }]);
  const { status, stdout } = runCli(home, 'l1-05', 'bench/a');
  assert.equal(status, 0);
  assert.ok(stdout.includes('l1-05 / bench/a'));
  assert.match(stdout, /会话总时长\s+10s/);
  assert.match(stdout, new RegExp(`模型生成\\s+${(3000 / 1000).toFixed(0)}s`));
  assert.match(stdout, new RegExp(`工具执行\\s+${(1000 / 1000).toFixed(0)}s`));
  assert.match(stdout, new RegExp(`未解释间隔\\s+${(1500 / 1000).toFixed(0)}s`));
  assert.match(stdout, /reasoning 字符\s+5/);
  assert.match(stdout, /消息数\s+2/);
  assert.ok(stdout.includes('最慢的 6 次生成：'));
  assert.ok(stdout.includes('tool:read'));
  assert.match(stdout, /平均每次生成 1\.5s/);
});

test('latency：查不到会话报错退出', () => {
  const home = mkdtempSync(join(tmpdir(), 'model-bench-home-'));
  writeSessionDb(resolve(home, '.local/share/opencode/opencode.db'), []);
  const { status, stderr } = runCli(home, 'no-such-case', 'bench/a');
  assert.equal(status, 1);
  assert.ok(stderr.includes('session not found'));
});

test('latency：缺参数输出 usage', () => {
  const { status, stderr } = runCli(mkdtempSync(join(tmpdir(), 'model-bench-home-')));
  assert.equal(status, 1);
  assert.ok(stderr.includes('usage: node runners/latency.ts'));
});
