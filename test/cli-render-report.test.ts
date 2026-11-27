/** render-report.ts CLI：旧格式走 stdout 渲染，v1.1 格式写 RANKING.md。 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { formalRun, writeRun } from './helpers/fixtures.ts';

const ROOT = resolve(import.meta.dirname, '..');

function runCli(...args: string[]) {
  return spawnSync(process.execPath, [resolve(ROOT, 'runners/render-report.ts'), ...args], {
    cwd: ROOT, encoding: 'utf8',
  });
}

test('render-report 旧格式：stdout 输出完整报告，不写任何文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'model-bench-render-'));
  writeFileSync(resolve(dir, 'results.json'), JSON.stringify({
    config: { weights: { l0: 10, l1: 20, l2: 40, l3: 25 } },
    results: [
      {
        caseId: 'l0-01', layer: 'l0', modelId: 'm1', pass: true, violation: false, weight: 1,
        turns: 1, tokensInput: 100, tokensOutput: 5, durationSec: 60, toolErrors: {}, assertions: [],
      },
      {
        caseId: 'l1-01', layer: 'l1', modelId: 'm1', pass: false, violation: false, weight: 1,
        turns: 3, tokensInput: 10, tokensOutput: 2, durationSec: 30, toolErrors: {},
        assertions: [{ type: 'textMatch', pass: false, detail: '缺少结论' }], error: 'boom',
      },
      {
        caseId: 'l0-01', layer: 'l0', modelId: 'm2', pass: false, violation: true, weight: 1,
        turns: 2, tokensInput: 7, tokensOutput: 3, durationSec: 45, toolErrors: {}, assertions: [],
      },
    ],
  }));
  const { status, stdout } = runCli(dir);
  assert.equal(status, 0);
  assert.ok(stdout.startsWith('# 跑分排名'));
  assert.ok(stdout.includes('模型：m1 / m2　用例：2 个'));
  assert.ok(stdout.includes('## 总排名'));
  assert.ok(stdout.includes('## 分层得分'));
  assert.ok(stdout.includes('## 逐用例结果'));
  assert.ok(stdout.includes('| l0-01 | ✅ | ⛔ |'));
  assert.ok(stdout.includes('| l1-01 | ❌ 3轮 | — |'));
  assert.ok(stdout.includes('## 失败明细'));
  assert.ok(stdout.includes('### m1 / l1-01'));
  assert.ok(stdout.includes('- `textMatch` — 缺少结论'));
  assert.ok(stdout.includes('- error: boom'));
  assert.ok(stdout.includes('## 成本'));
  assert.deepEqual(readdirSync(dir), ['results.json']);
});

test('render-report v1.1 格式：校验运行锁并写出 RANKING.md', () => {
  const dir = mkdtempSync(join(tmpdir(), 'model-bench-render-'));
  writeRun(dir, formalRun());
  const { status, stdout } = runCli(dir);
  assert.equal(status, 0);
  const outPath = stdout.trim();
  assert.equal(outPath, resolve(dir, 'RANKING.md'));
  const text = readFileSync(outPath, 'utf8');
  assert.ok(text.startsWith('# v1.1.0 formal'));
  assert.ok(text.includes('## 逐题结果'));
});

test('render-report v1.1 格式：运行锁不一致拒绝渲染', () => {
  const dir = mkdtempSync(join(tmpdir(), 'model-bench-render-'));
  const run = formalRun();
  writeRun(dir, run);
  const tampered = { ...run, protocol: { ...run.protocol, runId: 'tampered' } };
  writeFileSync(resolve(dir, 'results.json'), JSON.stringify(tampered));
  const { status, stderr } = runCli(dir);
  assert.equal(status, 1);
  assert.ok(stderr.includes('结果协议与运行前锁清单不一致'));
  assert.ok(!existsSync(resolve(dir, 'RANKING.md')));
});

test('render-report：缺参数输出 usage', () => {
  const { status, stderr } = runCli();
  assert.equal(status, 1);
  assert.ok(stderr.includes('usage: node runners/render-report.ts'));
});
