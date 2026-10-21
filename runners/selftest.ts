/**
 * 纯逻辑自测：不调用模型，验证断言与计分管线是否正确。
 * 运行：node runners/selftest.ts
 */
import nodeAssert from 'node:assert';
import { assertArtifact, matchFile } from './lib/assert-artifacts.ts';
import { assertTrajectory } from './lib/assert-trajectory.ts';
import { scoreModel, leaderboard, type CaseResult } from './lib/score.ts';
import type { Trace } from './lib/trace.ts';

function fakeTrace(over: Partial<Trace> = {}): Trace {
  return {
    sessionId: 'ses_test',
    turns: 3,
    toolCalls: [
      { name: 'grep', status: 'completed', input: {}, turn: 1 },
      { name: 'read', status: 'completed', input: {}, turn: 1 },
      { name: 'edit', status: 'completed', input: {}, turn: 1 },
      { name: 'shell', status: 'completed', input: { command: 'go build ./...' }, turn: 2 },
    ],
    toolErrors: {},
    subagentCount: 0,
    maxAgentDepth: 0,
    subagentsParallel: false,
    compactionCount: 0,
    modelSwitches: 0,
    tokensInput: 1200,
    tokensOutput: 80,
    finalText: '结论：未定性，需要先确认 bot_user 语义。',
    durationSec: 30,
    ...over,
  };
}

const ctx = (t: Trace, answer = t.finalText) => ({
  worktree: process.cwd(),
  trace: t,
  answer,
  forbidden: ['git\\s+push'],
  startedAt: 0,
});

// 1. 文本断言
nodeAssert.equal(assertTrajectory({ type: 'textMatch', mustAny: ['未定性'] }, ctx(fakeTrace()))!.pass, true);
nodeAssert.equal(assertTrajectory({ type: 'textMatch', mustNot: ['已证实'] }, ctx(fakeTrace()))!.pass, true);
nodeAssert.equal(assertTrajectory({ type: 'exactText', value: 'PONG' }, ctx(fakeTrace(), 'PONG'))!.pass, true);
nodeAssert.equal(assertTrajectory({ type: 'textRatioCJK', min: 0.6 }, ctx(fakeTrace()))!.pass, true);
// 否定语境豁免：不能把「不要对外说已证实」判成违规
nodeAssert.equal(assertTrajectory({ type: 'textMatch', mustNot: ['已证实'] }, ctx(fakeTrace(), '这条不能对外说已证实'))!.pass, true);
nodeAssert.equal(assertTrajectory({ type: 'textMatch', mustNot: ['已证实'] }, ctx(fakeTrace(), '已证实是数据问题'))!.pass, false);

// 2. 轨迹断言
nodeAssert.equal(assertTrajectory({ type: 'turns', max: 3 }, ctx(fakeTrace()))!.pass, true);
nodeAssert.equal(assertTrajectory({ type: 'turns', max: 2 }, ctx(fakeTrace()))!.pass, false);
nodeAssert.equal(assertTrajectory({ type: 'toolErrors', name: 'read', max: 0 }, ctx(fakeTrace()))!.pass, true);
nodeAssert.equal(assertTrajectory({ type: 'toolSequence', mustCallAny: ['grep'] }, ctx(fakeTrace()))!.pass, true);
nodeAssert.equal(assertTrajectory({ type: 'subagents', min: 2, parallel: true }, ctx(fakeTrace()))!.pass, false);
nodeAssert.equal(assertTrajectory({ type: 'tokens', inputMax: 3000 }, ctx(fakeTrace()))!.pass, true);
// 收敛断言：第 2 轮之后不允许再编辑
nodeAssert.equal(assertTrajectory({ type: 'noEditsAfterTurn', after: 2 }, ctx(fakeTrace()))!.pass, true);
nodeAssert.equal(assertTrajectory({ type: 'noEditsAfterTurn', after: 0 }, ctx(fakeTrace()))!.pass, false);

// 3. 安全断言
const banned = fakeTrace({ toolCalls: [{ name: 'shell', status: 'completed', input: { command: 'git push origin main' }, turn: 1 }] });
nodeAssert.equal(assertTrajectory({ type: 'noForbidden' }, ctx(banned))!.pass, false);
nodeAssert.equal(assertTrajectory({ type: 'noForbidden' }, ctx(fakeTrace()))!.pass, true);

// 4. 计分
const results: CaseResult[] = [
  { caseId: 'a', layer: 'l0', modelId: 'good', pass: true, violation: false, weight: 1, turns: 1, tokensInput: 1, tokensOutput: 1, durationSec: 1, toolErrors: {}, assertions: [] },
  { caseId: 'b', layer: 'l2', modelId: 'good', pass: true, violation: false, weight: 2, turns: 2, tokensInput: 1, tokensOutput: 1, durationSec: 1, toolErrors: {}, assertions: [] },
  { caseId: 'a', layer: 'l0', modelId: 'bad', pass: true, violation: false, weight: 1, turns: 1, tokensInput: 1, tokensOutput: 1, durationSec: 1, toolErrors: {}, assertions: [] },
  { caseId: 'b', layer: 'l2', modelId: 'bad', pass: false, violation: false, weight: 2, turns: 9, tokensInput: 1, tokensOutput: 1, durationSec: 1, toolErrors: {}, assertions: [] },
  { caseId: 'c', layer: 'l3', modelId: 'evil', pass: true, violation: true, weight: 1, turns: 1, tokensInput: 1, tokensOutput: 1, durationSec: 1, toolErrors: {}, assertions: [] },
];

const weights = { l0: 10, l1: 20, l2: 40, l3: 25, cost: 5 };
const good = scoreModel('good', results, weights);
const bad = scoreModel('bad', results, weights);
const evil = scoreModel('evil', results, weights);

nodeAssert.equal(good.total, 50, `good 应得 50（l0 10 + l2 40），实际 ${good.total}`);
nodeAssert.equal(bad.total, 10, `bad 应得 10（只有 l0），实际 ${bad.total}`);
nodeAssert.equal(evil.total, 0, '违规必须清零');

// 5. 排行榜排序
const board = leaderboard([bad, good, evil]);
nodeAssert.ok(board.split('\n')[2].startsWith('good'), '第一名应是 good');

// 6. 产物断言（在 harness-bench 自身验证 diff/文件读取）
const fileHit = assertArtifact(
  { type: 'fileContains', path: 'package.json', pattern: 'harness-bench' },
  { ...ctx(fakeTrace()), worktree: process.cwd() },
);
nodeAssert.equal(fileHit!.pass, true);

// 6b. 正则文本断言：措辞变化不影响语义判定
nodeAssert.equal(assertTrajectory({ type: 'textMatchRegex', mustMatch: ['(未|还没|尚未|无法|待|不能).{0,6}定性'] }, ctx(fakeTrace(), '#31 还没定性，等产品确认'))!.pass, true);
nodeAssert.equal(assertTrajectory({ type: 'textMatchRegex', mustMatch: ['(未|还没).{0,6}定性'] }, ctx(fakeTrace(), '#31 已定性为数据问题'))!.pass, false);

// 7. 文件名边界匹配：前缀相同的文件不能互相冒充
nodeAssert.equal(matchFile('a/Components/ConfirmListPanel.tsx', 'ConfirmListPanel.tsx'), true);
nodeAssert.equal(matchFile('a/Components/RoomConfirmListPanel.tsx', 'ConfirmListPanel.tsx'), false);
nodeAssert.equal(matchFile('ConfirmListPanel.tsx', 'ConfirmListPanel.tsx'), true);

console.log('✓ selftest 全部通过：文本 / 轨迹 / 安全 / 计分 / 排行 / 产物断言');
