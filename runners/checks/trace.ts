import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { assertTrajectory } from '../lib/assert-trajectory.ts';
import { collectTrace, type RecordedTrace, type ToolCall } from '../lib/trace.ts';

const ROOT = 'root';
const WORKTREE = '/bench/repo';
const POLL = 'go-projects/some-service/internal/biz/bulk_send_v1/poll.go';
const TAG_REPO = 'go-projects/some-service/internal/biz/bulk_send_v1/repo.go';

function grade(
  trace: RecordedTrace, assertion: Record<string, unknown>, answer: string = trace.finalText,
): boolean {
  const result = assertTrajectory(assertion, { trace, worktree: WORKTREE, answer, forbidden: [], startedAt: 0 });
  assert.ok(result);
  return result.pass;
}

function fixture(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE session_v2 (id TEXT, parent_id TEXT, time_created INTEGER, time_updated INTEGER,
      tokens_input INTEGER, tokens_output INTEGER);
    CREATE TABLE session_message (session_id TEXT, seq INTEGER, type TEXT, data TEXT,
      time_created INTEGER, time_updated INTEGER);
    INSERT INTO session_v2 VALUES ('root', NULL, 10, 500, 5, 6);
  `);
  return db;
}

function message(
  db: DatabaseSync, sessionId: string, seq: number, type: string, start: number, end: number,
  data: Record<string, unknown> = {},
): void {
  db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)').run(sessionId, seq, type, JSON.stringify(data), start, end);
}

function tool(
  name: string, input: Record<string, unknown>, start: number, end: number,
  extra: { status?: string; output?: string; exit?: number; child?: string } = {},
): Record<string, unknown> {
  return {
    type: 'tool', name, time: { ran: start, completed: end },
    state: {
      status: extra.status ?? 'completed', input, content: [{ type: 'text', text: extra.output ?? '' }],
      metadata: { exit: extra.exit, sessionID: extra.child },
      ...(extra.status === 'error' ? { error: { message: 'failed' } } : {}),
    },
  };
}

function assistant(
  db: DatabaseSync, sessionId: string, seq: number, start: number, end: number,
  content: Record<string, unknown>[], finish = 'tool-calls',
): void {
  message(db, sessionId, seq, 'assistant', start, end, { content, time: { created: start, completed: end }, finish });
}

function text(value: string): Record<string, unknown> {
  return { type: 'text', text: value };
}

function getTrace(db: DatabaseSync): RecordedTrace {
  const trace = collectTrace(db, ROOT);
  assert.ok(trace);
  return trace;
}

function assertTurns(): void {
  const db = fixture();
  try {
    message(db, ROOT, 1, 'user', 10, 10);
    assistant(db, ROOT, 2, 15, 25, [text('先取证'), tool('read', { path: 'test' }, 20, 24, { output: 'TEST-ID' })]);
    assistant(db, ROOT, 3, 25, 30, [text('第 1 轮答案')], 'stop');
    message(db, ROOT, 4, 'user', 50, 50);
    assistant(db, ROOT, 5, 60, 80, [text('重新核对'), tool('shell', { command: 'read failed' }, 70, 75, { exit: 1, output: 'NOT-EVIDENCE' })]);
    const interrupted = getTrace(db);
    assert.deepEqual(interrupted.answersByTurn, ['第 1 轮答案', '']);
    assert.deepEqual(interrupted.finalObservedByTurn, [true, false]);
    assert.equal(interrupted.finalText, '');
    assert.equal(interrupted.toolCalls[1].output, '');
    assistant(db, ROOT, 6, 80, 90, [tool('read', { path: 'stage' }, 84, 85)], 'stop');
    assert.deepEqual(getTrace(db).finalObservedByTurn, [true, false], 'stop with tool only is not a terminal answer');
    message(db, ROOT, 7, 'assistant', 95, 95, { finish: 'stop', content: [text('未完成的流')] });
    assert.deepEqual(getTrace(db).finalObservedByTurn, [true, false], 'stop without completion event is not final');
    assistant(db, ROOT, 8, 100, 110, [], 'stop');
    const empty = getTrace(db);
    assert.deepEqual(empty.answersByTurn, ['第 1 轮答案', '']);
    assert.deepEqual(empty.finalObservedByTurn, [true, true], 'completed empty terminal response is observed');
    assistant(db, ROOT, 9, 120, 130, [text('第 2 轮答案')], 'stop');
    const complete = getTrace(db);
    assert.deepEqual(complete.answersByTurn, ['第 1 轮答案', '第 2 轮答案']);
    assert.deepEqual(complete.finalObservedByTurn, [true, true]);
    assert.equal(complete.finalText, '第 2 轮答案');
    assert.deepEqual(complete.toolCalls.map((call: ToolCall) => [call.sessionId, call.turn, call.seq, call.output]), [
      [ROOT, 1, 2, 'TEST-ID'], [ROOT, 2, 5, ''], [ROOT, 2, 6, ''],
    ]);
  } finally {
    db.close();
  }
}

function assertSearchOrder(): void {
  const db = fixture();
  const input = { pattern: '\\bSyncJob\\b' };
  const found = `Found 1 matches\n${WORKTREE}/${POLL}:\nLine 12: func (uc *UseCase) SyncJob(ctx context.Context) error {`;
  const order = { type: 'toolOrder', before: 'read', searchTargets: [POLL], searchSubject: 'SyncJob', readTarget: POLL };
  try {
    message(db, ROOT, 1, 'user', 10, 10);
    assistant(db, ROOT, 3, 80, 90, [tool('read', { path: `./${POLL}` }, 82, 85, { output: 'package bulk_send_v1' })]);
    assert.equal(grade(getTrace(db), order), false, 'read without search');
    assistant(db, ROOT, 4, 90, 95, [tool('grep', input, 91, 92, { output: found })]);
    assert.equal(grade(getTrace(db), order), false, 'search after read');
    assistant(db, ROOT, 2, 30, 40, [tool('grep', input, 31, 34, { output: found, status: 'error' })]);
    assert.equal(grade(getTrace(db), order), false, 'failed search');
    db.exec('DELETE FROM session_message WHERE seq = 2');
    assistant(db, ROOT, 2, 30, 40, [tool('grep', input, 31, 34, { output: found.replace(POLL, 'wrong/poll.go') })]);
    assert.equal(grade(getTrace(db), order), false, 'same name in wrong directory');
    db.exec('DELETE FROM session_message WHERE seq = 2');
    assistant(db, ROOT, 2, 30, 40, [tool('glob', { pattern: '**/*.go' }, 31, 34, { output: POLL })]);
    assert.equal(grade(getTrace(db), order), false, 'glob without target');
    db.exec('DELETE FROM session_message WHERE seq = 2');
    db.exec("INSERT INTO session_v2 VALUES ('child', 'root', 20, 40, 0, 0)");
    message(db, 'child', 1, 'user', 20, 20);
    assistant(db, 'child', 2, 30, 40, [tool('grep', input, 31, 34, { output: found })]);
    const differentExecutor = getTrace(db);
    assert.equal(differentExecutor.toolCalls.at(-1)?.parentId, ROOT);
    assert.equal(differentExecutor.toolCalls.at(-1)?.turn, 1);
    assert.equal(grade(differentExecutor, order), false, 'child searched, root read');
    assistant(db, ROOT, 2, 30, 40, [
      tool('shell', { command: 'git grep -nE "Other|SyncJob" -- go-projects' }, 31, 34,
        { output: `${POLL}:12:func (uc *UseCase) SyncJob(ctx context.Context) error {` }),
    ]);
    const trace = getTrace(db);
    assert.equal(grade(trace, order), true, 'verified shell result before same-actor read');
    const calls = trace.toolCalls.map((call: RecordedTrace['toolCalls'][number]): RecordedTrace['toolCalls'][number] =>
      call.name === 'shell' ? { ...call, endedAt: 83 } : call);
    assert.equal(grade({ ...trace, toolCalls: calls }, order), false, 'read began while search was running');
    const sameBatchCalls = trace.toolCalls.map((call: RecordedTrace['toolCalls'][number]): RecordedTrace['toolCalls'][number] =>
      call.name === 'shell' ? { ...call, seq: 3 } : call.name === 'read' ? { ...call, partIndex: 1 } : call);
    assert.equal(grade({ ...trace, toolCalls: sameBatchCalls }, order), true, 'actual sequential timing within batch');
    const compound = trace.toolCalls.map((call: RecordedTrace['toolCalls'][number]): RecordedTrace['toolCalls'][number] =>
      call.name === 'shell' ? { ...call, input: { command: 'rg SyncJob unrelated; cat saved-results' } } : call);
    assert.equal(grade({ ...trace, toolCalls: compound }, order), false, 'cannot attribute compound output to search');
    const uncertain = {
      ...trace,
      toolCalls: [...trace.toolCalls, {
        ...trace.toolCalls.find((call: ToolCall): boolean => call.name === 'read')!,
        sessionId: 'child', startedAt: undefined,
      }],
    };
    assert.equal(grade(uncertain, order), false, 'an untimed different executor might have read earlier');
    const emptyRead = trace.toolCalls.map((call: RecordedTrace['toolCalls'][number]): RecordedTrace['toolCalls'][number] =>
      call.name === 'read' ? { ...call, name: 'shell', input: { command: `head -n 0 ${POLL}` }, output: '(no output)' } : call);
    assert.equal(grade({ ...trace, toolCalls: emptyRead }, order), false, 'empty shell output is not source content');
  } finally {
    db.close();
  }
}

function assertEditOrder(): void {
  const db = fixture();
  const order = {
    type: 'toolOrder', before: 'edit', searchTargets: [TAG_REPO], searchSubject: '幂等|idempot',
  };
  try {
    message(db, ROOT, 1, 'user', 10, 10);
    assistant(db, ROOT, 2, 20, 40, [
      tool('read', { path: POLL }, 21, 24),
      tool('grep', { pattern: '幂等' }, 31, 34, { output: `${TAG_REPO}:\nLine 25: // 打标接口本身幂等。` }),
    ]);
    assistant(db, ROOT, 3, 60, 80, [tool('patch', { patchText: 'target patch' }, 64, 67)]);
    assert.equal(grade(getTrace(db), order), true, 'read-only investigation before search does not count as an edit');
    assistant(db, ROOT, 1.5, 15, 19, [tool('shell', { command: 'sed -i s/a/b/ other.go' }, 15, 16)]);
    assert.equal(grade(getTrace(db), order), false, 'first edit cannot be repaired by a later targeted search');
  } finally {
    db.close();
  }
}

function addChild(
  db: DatabaseSync, id: string, parent: string, start: number, end: number, windows: readonly [number, number][],
): void {
  db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, 0, 0)').run(id, parent, start, 500);
  message(db, id, 1, 'user', start, start);
  windows.forEach(([from, until]: [number, number], index: number): void => {
    assistant(db, id, index + 2, from, until, [text('实质任务活动')], 'stop');
  });
  message(db, id, windows.length + 2, 'idle', end, end, { outcome: 'succeeded' });
}

function fanout(
  second: readonly [number, number][], third: readonly [number, number][], thirdParent = ROOT,
  thirdPrompt = 'api-bff validateMaterials',
): boolean {
  const db = fixture();
  try {
    message(db, ROOT, 1, 'user', 10, 10);
    assistant(db, ROOT, 2, 20, 40, [
      tool('subagent', { prompt: 'ConfirmListPanel' }, 30, 35, { child: 'frontend' }),
      tool('subagent', { prompt: 'new_badge.go' }, 30, 35, { child: 'auth' }),
      tool('subagent', { prompt: thirdPrompt }, 30, 35, { child: 'bff' }),
    ]);
    addChild(db, 'frontend', ROOT, 33, 110, [[60, 90]]);
    addChild(db, 'auth', ROOT, 34, 185, second);
    addChild(db, 'bff', thirdParent, 35, 220, third);
    return grade(getTrace(db), { type: 'subagents', parallel: true, tasks: ['ConfirmListPanel', 'new_badge\\.go', 'validateMaterials'] });
  } finally {
    db.close();
  }
}

function assertResumeDoesNotProveInitialOverlap(): void {
  const db = fixture();
  try {
    message(db, ROOT, 1, 'user', 10, 10);
    assistant(db, ROOT, 2, 20, 40, [
      tool('subagent', { prompt: 'frontend' }, 30, 35, { child: 'a' }),
      tool('subagent', { prompt: 'auth' }, 30, 35, { child: 'b' }),
    ]);
    db.exec("INSERT INTO session_v2 VALUES ('a', 'root', 31, 500, 0, 0)");
    message(db, 'a', 1, 'user', 31, 31);
    assistant(db, 'a', 2, 40, 55, [text('initial')], 'stop');
    message(db, 'a', 3, 'user', 70, 70);
    assistant(db, 'a', 4, 75, 95, [text('resumed')], 'stop');
    message(db, 'a', 5, 'idle', 100, 100);
    addChild(db, 'b', ROOT, 32, 185, [[75, 95]]);
    assert.equal(grade(getTrace(db), { type: 'subagents', parallel: true, tasks: ['frontend', 'auth'] }), false);
  } finally {
    db.close();
  }
}

function assertAutoTag(): void {
  const db = fixture();
  const assertion = { type: 'autoTagConclusion' };
  try {
    message(db, ROOT, 1, 'user', 10, 10);
    assistant(db, ROOT, 2, 20, 40, [
      tool('grep', { pattern: 'MarkTag\\s*\\(' }, 31, 34,
        { output: `Found 1 matches\n${WORKTREE}/${TAG_REPO}:\nLine 28: MarkTag(ctx context.Context)` }),
    ]);
    const trace = getTrace(db);
    // v1.0 误判样本的原始命题：说「已实现」配置，但否定发送成功后实际自动打标。
    const historical = '当前仓库的群发 v1 已实现标签配置保存和展示，但未实现发送成功后自动给客户打标。';
    const old = { type: 'textMatch', must: ['MarkTag', 'poll.go'], mustAny: ['未实现'], mustNot: ['已实现'] };
    const oldEvidence = 'poll.go 的 SyncJob 设置 FINISHED，随后 return repo.Update；仓内 Go 代码没有 .MarkTag(...) 调用点。';
    assert.equal(grade(trace, old, `${historical}\n${oldEvidence}`), false, 'v1.0 rejected config-only implementation language');
    // 将同一命题和证据放入新题要求的三个字段；不将新题句法倒扣到历史答复。
    const answer = [
      '任务完成后自动打标：未实现',
      '完成路径证据：`poll.go` 的 `SyncJob` 设置 FINISHED，随后 return `repo.Update`。',
      '调用缺口证据：仓内 Go 代码没有 `.MarkTag(...)` 调用点。',
      historical,
    ].join('\n');
    assert.equal(grade(trace, assertion, answer), true, 'implemented config does not contradict absent execution');
    assert.equal(grade(trace, assertion, answer.replace('打标：未实现', '打标：已实现')), false);
    assert.equal(grade(trace, assertion, `${answer}\n任务完成后自动打标：未实现`), false);
    assert.equal(grade(trace, assertion, `${answer}\n任务完成后会自动打标。`), false);
    assert.equal(grade(trace, assertion, `${answer}\n补充：群发任务完成后会自动打标。`), false);
    assert.equal(grade(trace, assertion, `${answer}\n配置已保存并不代表任务完成后会自动打标。`), true);
    assert.equal(grade(trace, assertion, answer.replace('随后 return `repo.Update`', '并未调用 `repo.Update`')), false);
    assert.equal(grade(trace, assertion, historical), false, 'no requested fields in a new-format answer');
    assert.equal(grade(trace, assertion, answer.replace('没有 `.MarkTag(...)` 调用点', '有 `.MarkTag(...)` 调用点')), false);
    assert.equal(grade({ ...trace, toolCalls: [] }, assertion, answer), false, 'not grounded in a source search');
  } finally {
    db.close();
  }
}

export function runTraceTests(): void {
  assertTurns();
  assertSearchOrder();
  assertEditOrder();
  assertAutoTag();
  assertResumeDoesNotProveInitialOverlap();
  assert.equal(fanout([[70, 105]], [[80, 130]]), true, 'three matching direct siblings active together');
  assert.equal(fanout([[70, 105]], [[80, 130]], 'auth'), false, 'grandchild is not a direct sibling');
  assert.equal(fanout([[70, 105]], [[80, 130]], ROOT, 'ConfirmListPanel'), false, 'duplicate task does not count');
  assert.equal(fanout([[95, 102]], [[120, 140]]), false, 'overlapping session lifespan alone is insufficient');
  assert.equal(fanout([[70, 105]], [[91, 130]]), false, 'different pairwise overlaps are not three-way overlap');
}
