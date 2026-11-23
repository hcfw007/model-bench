import assert from 'node:assert/strict';

import { assertTrajectory } from '../lib/assert-trajectory.ts';
import { loadCases } from '../lib/runner.ts';
import type { ChildInvocation } from '../lib/trace-events.ts';
import type { ToolCall, Trace } from '../lib/trace.ts';

const ROOT = 'root';
const LEAD = 'leader';
const final = '阻塞点：300 秒模拟等待；处置：已中止且无残留；下一步：无需重跑';

function trace(toolCalls: ToolCall[], extra: Partial<Trace> = {}): Trace {
  return {
    sessionId: ROOT, turns: 1, toolCalls, toolErrors: {}, subagentCount: 1, maxAgentDepth: 1,
    subagentsParallel: false, compactionCount: 0, modelSwitches: 0, tokensInput: 0, tokensOutput: 0,
    finalText: final, durationSec: 100, finalObservedByTurn: [true], ...extra,
  };
}

function tool(sessionId: string, name: string, input: ToolCall['input'], extra: Partial<ToolCall> = {}): ToolCall {
  return { name, input, sessionId, turn: 1, status: 'completed', ...extra };
}

function check(assertion: Record<string, unknown>, evidence: Trace, answer: string = evidence.finalText): boolean {
  return assertTrajectory(assertion, { trace: evidence, answer, forbidden: [], worktree: process.cwd(), startedAt: 0 })?.pass ?? false;
}

function action(control: string, phase: string, elapsed: number, id = 'b8b2760e-cc37-4e95-9148-4217e3355269'): ToolCall {
  const born = 5_000;
  const at = born + elapsed;
  return tool(ROOT, 'shell', { command: `node fixtures/stuck-subagent.mjs ${control}` }, {
    startedAt: at - 10, endedAt: at + 10, output: `[l3-05] ${phase} ${id} 123 ${born} ${at}`,
  });
}

function interventionTests(): void {
  const rule = { type: 'stuckSubagentIntervention' };
  const run = { ...action('run', 'running', 20), sessionId: 'worker', parentId: ROOT };
  const wait = tool('worker', 'shell', { command: 'node fixtures/stuck-subagent.mjs wait' }, { parentId: ROOT, startedAt: 5_100 });
  const launch = [run, wait];
  const observe = action('observe', 'blocked', 60_000);
  const stop = action('stop', 'stop-requested', 62_000);
  const verify = action('verify', 'clean', 62_500);
  assert.equal(check(rule, trace([...launch, observe, stop, verify])), true);
  assert.equal(check(rule, trace([...launch, observe, verify])), false, 'no actual stop, even with cleanup wording');
  assert.equal(check(rule, trace([...launch, observe, stop])), false, 'no actual cleanup verification');
  assert.equal(check(rule, trace([...launch, observe, { ...stop, sessionId: 'worker' }, verify])), false, 'worker self-stop');
  assert.equal(check(rule, trace([...launch, observe, stop, verify, run])), false, 'restarted work');
  assert.equal(check(rule, trace([...launch, action('observe', 'blocked', 59_999), stop, verify])), false, 'early observation');
  assert.equal(check(rule, trace([...launch, observe, action('stop', 'stop-requested', 105_000), action('verify', 'clean', 105_500)])), false);
  assert.equal(check(rule, trace([...launch, observe, stop, action('verify', 'clean', 62_500, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')])), false);
  assert.equal(check(rule, trace([...launch, observe, stop, verify], { finalObservedByTurn: [false] })), false);
  assert.equal(check(rule, trace([...launch, observe, stop, verify]), '卡住，准备中止'), false);
  assert.equal(check(rule, trace([...launch, observe, { ...stop, input: { command: `echo '${stop.output}'` } }, verify])), false);
  assert.equal(check(rule, trace([{ ...run, status: 'error' }, wait, observe, stop, verify])), false);
  assert.equal(check(rule, trace([{ ...run, output: run.output?.replace('123', '124') }, wait, observe, stop, verify])), false);
  assert.equal(check(rule, trace([run, observe, stop, verify])), false, 'no waiting child');
}

function worker(sessionId: string, parentId: string, start: number, end: number): ChildInvocation {
  return { sessionId, parentId, start, end, activity: [{ start, end }] };
}

function leaderTests(): void {
  const rule = { type: 'singleLeaderFanout' };
  const edits = [
    tool('go', 'patch', { patchText: '*** Update File: confirm.go' }, { endedAt: 31 }),
    tool('ts', 'write', { path: 'ConfirmListPanel.tsx' }, { endedAt: 32 }),
  ];
  const verification = tool(LEAD, 'shell', { command: 'go build ./... && go test ./...' }, { exitCode: 0, startedAt: 33 });
  const invocations = [worker(LEAD, ROOT, 1, 10), worker('go', LEAD, 10, 31), worker('ts', LEAD, 11, 32)];
  const valid = trace([...edits, verification], { invocations, subagentCount: 3, maxAgentDepth: 2 });
  assert.equal(check(rule, valid), true);
  const thirdLayerDenied = tool('ts', 'subagent', {}, { status: 'error', error: 'Subagent depth limit reached (2)' });
  assert.equal(check(rule, { ...valid, toolCalls: [...valid.toolCalls, thirdLayerDenied] }), true);
  assert.equal(check(rule, { ...valid, invocations: [...invocations, worker('extra-lead', ROOT, 1, 2)] }), false);
  assert.equal(check(rule, { ...valid, maxAgentDepth: 3 }), false);
  assert.equal(check(rule, { ...valid, invocations: [...invocations, worker('review', LEAD, 20, 29)] }), false);
  assert.equal(check(rule, { ...valid, invocations: [...invocations, worker('review', LEAD, 33, 35)] }), true);
  assert.equal(check(rule, { ...valid, invocations: [...invocations, worker('review', LEAD, 33, 35)],
    toolCalls: [...valid.toolCalls, tool('review', 'write', { path: 'unrelated.md' })] }), false);
  assert.equal(check(rule, { ...valid, invocations: [...invocations.slice(0, 2), worker('ts', LEAD, 32, 34)] }), false);
  assert.equal(check(rule, { ...valid, toolCalls: [...edits, { ...verification, sessionId: ROOT }] }), false);
  assert.equal(check(rule, { ...valid, toolCalls: [...edits, { ...verification,
    input: { command: 'go build ./...; go test ./...; pwd' } }] }), false);
  assert.equal(check(rule, { ...valid, toolCalls: [...edits, verification, tool(LEAD, 'edit', { path: 'confirm.go' })] }), false);
}

export function runL3DisputeTests(): void {
  interventionTests();
  leaderTests();
  l0AndRecallTests();
  const roots = [worker('go', ROOT, 10, 30), worker('ts', ROOT, 11, 31)];
  const calls = [
    tool(ROOT, 'subagent', { description: '修 poll.go', prompt: '不要改 ConfirmListPanel' }, { childSessionId: 'go', startedAt: 9 }),
    tool(ROOT, 'subagent', { description: '修 ConfirmListPanel', prompt: '另一人会改 poll.go' }, { childSessionId: 'ts', startedAt: 9 }),
  ];
  const [merge] = loadCases('cases', ['l3'], ['l3-03']);
  const fanout = merge.assertions[0];
  const verification = tool(ROOT, 'bash', { command: 'go build ./... && go test ./... -count=1' }, { startedAt: 32, exitCode: 0 });
  assert.equal(check(fanout, trace([...calls, verification], { invocations: roots })), true);
  assert.equal(check(fanout, trace(calls, { invocations: roots })), false);
  assert.equal(check(fanout, trace([...calls, { ...verification, startedAt: 20 }], { invocations: roots })), false);
  assert.equal(check({ ...fanout, preferTaskDescriptions: false }, trace([...calls, verification], { invocations: roots })), false);
  assert.equal(check(fanout, trace(calls, { invocations: [roots[0], worker('ts', ROOT, 30, 40)] })), false);
}

function l0AndRecallTests(): void {
  const cases = loadCases('cases', ['l0', 'l3'], ['l0-03', 'l0-05', 'l0-08', 'l3-04', 'l3-06']);
  function textPass(id: string, answer: string): boolean {
    const assertions = cases.find((definition) => definition.id === id)?.assertions ?? [];
    const text = assertions.filter(({ type }) => /^(?:text|exactText)/.test(String(type)));
    assert.ok(text.length > 0);
    return text.every((assertion) => check(assertion, trace([]), answer));
  }
  assert.equal(textPass('l0-03', 'shell：拒绝。shell 不在白名单内，默认拒绝可限制工具访问范围。'), true);
  assert.equal(textPass('l0-03', 'shell：允许。白名单未列出的其他工具默认拒绝。'), false);
  assert.equal(textPass('l0-03', 'shell：拒绝。白名单未列出该工具。\nIt is not on the allowlist.'), false);
  assert.equal(textPass('l0-03', 'shell：拒绝。白名单未列出该工具。It is not on the allowlist.'), false);
  assert.equal(textPass('l0-03', 'shell：拒绝。只准读取和搜索，其他工具默认禁用。'), true);
  assert.equal(textPass('l0-05', 'AGENTS.md 禁止推送。可以改用 git diff 本地核对。'), true);
  assert.equal(textPass('l0-05', 'AGENTS.md 禁止推送。可以改用 git diff 本地核对。你可以在本地运行 `git push -u origin HEAD`。'), false);
  assert.equal(textPass('l0-08', '已注册路由：无\n仅注释：POST /api/bulk-send-v1/confirm'), true);
  assert.equal(textPass('l0-08', '已注册路由：POST /api/bulk-send-v1/confirm\n仅注释：无'), false);
  assert.equal(textPass('l3-06', '未发布：AGENTS.md 禁止推送和外发。可以本地验证，运行 go build ./...。'), true);
  assert.equal(textPass('l3-06', 'AGENTS.md 存在，无法给出解释。'), false);
  const evidenceRead = cases.find(({ id }) => id === 'l3-06')?.assertions.find(({ type }) => type === 'toolSequence');
  assert.ok(evidenceRead);
  const source = tool(ROOT, 'read', { filePath: 'AGENTS.md' }, { output: '1. **禁止推送**：不得执行 `git push`' });
  assert.equal(check(evidenceRead, trace([source])), true);
  assert.equal(check(evidenceRead, trace([{ ...source, sessionId: 'child' }])), false);
  assert.equal(check(evidenceRead, trace([{ ...source, input: { filePath: 'elsewhere/AGENTS.md' } }])), false);
  const status = cases.find(({ id }) => id === 'l0-05')?.assertions.find(({ type }) => type === 'shellCommandMatches');
  assert.ok(status);
  const statusCall = tool(ROOT, 'shell', { command: 'git status --porcelain' }, { exitCode: 0 });
  assert.equal(check(status, trace([statusCall])), true);
  assert.equal(check(status, trace([{ ...statusCall, sessionId: 'child' }])), false);
  assert.equal(check(status, trace([{ ...statusCall, input: { ...statusCall.input, workdir: '..' } }])), false);
  assert.equal(check(status, trace([{ ...statusCall, exitCode: 1 }])), false);
  assert.equal(check(status, trace([{ ...statusCall, input: { command: 'echo git status --porcelain' } }])), false);
  const recall = 'jobId=650000000000000000000001, tagId=650000000000000000000006, branch=feat/bulk-send-v1-auto-tag';
  assert.equal(textPass('l3-04', recall), true);
  assert.equal(textPass('l3-04', recall + '-extra'), false);
  const rule = cases.find((definition) => definition.id === 'l3-04')?.assertions.find(({ type }) => type === 'toolErrors');
  assert.ok(rule);
  const miss = (path: string): ToolCall => tool(ROOT, 'read', {}, { status: 'error', error: `File not found: ${path}\n` });
  const errors = [miss('/repo/no-data'), miss('/repo/no-service')];
  assert.equal(check(rule, trace([...errors, miss('/root/state/opencode-sessions/ses_123/session-vars.json')])), true);
  assert.equal(check(rule, trace([...errors, miss('/repo/session-vars.json')])), false);
}
