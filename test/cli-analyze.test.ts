/** analyze.ts CLI：失败根因分析（假 HOME + 假 opencode.db，不碰真实数据）。 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import type { CaseResult } from '../runners/lib/score.ts';

import { writeSessionDb } from './helpers/fixtures.ts';

const ROOT = resolve(import.meta.dirname, '..');

function failedRow(over: Partial<CaseResult>): CaseResult {
  return {
    caseId: 'l1-05', layer: 'l1', modelId: 'kiro/claude-opus-5-5', pass: false, violation: false,
    weight: 1, turns: 2, tokensInput: 1, tokensOutput: 1, durationSec: 1, toolErrors: {},
    assertions: [{ type: 'textMatch', pass: false, detail: '缺少结论' }], ...over,
  };
}

function prepare(results: CaseResult[], sessions: Parameters<typeof writeSessionDb>[1]) {
  const home = mkdtempSync(join(tmpdir(), 'model-bench-home-'));
  const dir = mkdtempSync(join(tmpdir(), 'model-bench-analyze-'));
  writeFileSync(resolve(dir, 'results.json'), JSON.stringify({ config: { weights: { l1: 1 } }, results }));
  writeSessionDb(resolve(home, '.local/share/opencode/opencode.db'), sessions);
  return { home, dir };
}

function runCli(home: string, ...args: string[]) {
  return spawnSync(process.execPath, [resolve(ROOT, 'runners/analyze.ts'), ...args], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, HOME: home },
  });
}

test('analyze：直连会话还原工具序列与最终回答', () => {
  const { home, dir } = prepare([failedRow({ caseId: 'l1-05', sessionId: 'ses_direct' })], [{
    id: 'ses_direct', title: 'bench l1-05 任意标题',
    messages: [
      { seq: 1, type: 'user', data: { text: '请确认 bot_user 语义' } },
      {
        seq: 2, type: 'assistant',
        data: {
          content: [
            { type: 'tool', name: 'read', state: { status: 'completed', input: { filePath: 'src/a.ts' } } },
            { type: 'tool', name: 'shell', state: { status: 'error', input: { command: 'go build' } } },
            { type: 'text', text: '最终结论：未定性' },
          ],
        },
      },
    ],
  }]);
  const { status, stdout } = runCli(home, dir);
  assert.equal(status, 0);
  const report = readFileSync(resolve(dir, 'ANALYSIS.md'), 'utf8');
  assert.ok(stdout.includes(resolve(dir, 'ANALYSIS.md')));
  assert.ok(report.startsWith('# 失败根因分析'));
  assert.ok(report.includes('## kiro/claude-opus-5-5 / l1-05'));
  assert.ok(report.includes('- `textMatch` — 缺少结论'));
  assert.ok(report.includes('请确认 bot_user 语义'));
  assert.ok(report.includes('**工具调用序列**（2 次）'));
  assert.ok(report.includes('read(src/a.ts)'));
  assert.ok(report.includes('shell(go build) ✗'));
  assert.ok(report.includes('最终结论：未定性'));
});

test('analyze：历史别名经 LEGACY 反查命中会话，case 过滤只分析指定项', () => {
  const { home, dir } = prepare(
    [failedRow({ caseId: 'l1-05', sessionId: 'ses_direct' }), failedRow({ caseId: 'l1-06' })],
    [{
      id: 'ses_legacy', title: 'bench l1-06 pro-opus trial-run',
      messages: [{ seq: 1, type: 'user', data: { text: 'l1-06 的用户请求' } }],
    }],
  );
  const { status } = runCli(home, dir, 'l1-06');
  assert.equal(status, 0);
  const report = readFileSync(resolve(dir, 'ANALYSIS.md'), 'utf8');
  assert.ok(report.includes('## kiro/claude-opus-5-5 / l1-06'));
  assert.ok(!report.includes('## kiro/claude-opus-5-5 / l1-05'));
  assert.ok(report.includes('l1-06 的用户请求'));
});

test('analyze：没有失败项直接退出，不产出 ANALYSIS.md', () => {
  const { home, dir } = prepare([failedRow({ pass: true, outcome: 'pass' })], []);
  const { status, stdout } = runCli(home, dir);
  assert.equal(status, 0);
  assert.ok(stdout.includes('没有匹配的失败项'));
  assert.ok(!existsSync(resolve(dir, 'ANALYSIS.md')));
});

test('analyze：找不到会话时明示无法还原轨迹', () => {
  const { home, dir } = prepare([failedRow({ caseId: 'l1-09' })], []);
  const { status } = runCli(home, dir);
  assert.equal(status, 0);
  const report = readFileSync(resolve(dir, 'ANALYSIS.md'), 'utf8');
  assert.ok(report.includes('> 未找到对应会话，无法还原轨迹'));
});
