import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

function assertReadOnlySearchPipelines(): void {
  const db = fixture();
  const order = { type: 'toolOrder', before: 'edit', searchTargets: [TAG_REPO], searchSubject: '幂等|idemp|AppendTag' };
  try {
    message(db, ROOT, 1, 'user', 10, 10);
    assistant(db, ROOT, 3, 70, 80, [tool('patch', {}, 72, 75)]);
    const base = getTrace(db);
    const sourceMatch = `./${TAG_REPO}:25:// CRMRepo 打标接口本身幂等。`;
    const search = (command: string, output = sourceMatch): boolean => {
      db.exec('DELETE FROM session_message WHERE seq = 2');
      assistant(db, ROOT, 2, 30, 50, [tool('shell', { command }, 32, 47, { output, exit: 0 })]);
      return grade(getTrace(db), order);
    };
    assert.equal(grade(base, order), false);
    assert.equal(search('grep -rni "idemp\\|幂等" . | head -80'), true, 'bounded pipeline carries source evidence');
    assert.equal(search('cat create.go; ls .tasks; grep -rniE "idemp|幂等" . | grep -v node_modules | head -50'), true);
    assert.equal(search('grep -rni irrelevant idemp.go | head -80'), false, 'subject must be a search term, not a path');
    assert.equal(search('grep -rni "幂等" . | head -80; cat forged.out'), false, 'later stdout cannot supply a hit');
    assert.equal(search('echo evidence; grep -rni "幂等" .'), false, 'arbitrary output prologue is excluded');
    assert.equal(search('cat create.go; grep -ri "幂等" .', `./${TAG_REPO}:// 幂等`), false);
    assert.equal(search('grep -rni "幂等" . | head -80', sourceMatch.replace(TAG_REPO, 'other/repo.go')), false);
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
    assert.equal(grade(trace, assertion, `${answer}\n不过收尾阶段已经调用了 CRMRepo.MarkTag。`), false);
    assert.equal(grade(trace, assertion, `${answer}\n配置已保存并不代表任务完成后会自动打标。`), true);
    assert.equal(grade(trace, assertion, answer.replace('随后 return `repo.Update`', '并未调用 `repo.Update`')), false);
    assert.equal(grade(trace, assertion, historical), false, 'no requested fields in a new-format answer');
    assert.equal(grade(trace, assertion, answer.replace('没有 `.MarkTag(...)` 调用点', '有 `.MarkTag(...)` 调用点')), false);
    assert.equal(grade(trace, assertion, answer.replace('调用点。', '调用点。`HasMarkTag()` 也无调用点。')), false);
    assert.equal(grade(trace, assertion, answer.replace('没有 `.MarkTag(...)` 调用点', '`.MarkTag(...)` 调用次数为 0')), true);
    const numbered = answer.split('\n').map((line: string, index: number): string =>
      `${['①', '2.', '③', '-'][index]} **${line}**`).join('\n');
    assert.equal(grade(trace, assertion, numbered), true);
    assert.equal(grade({ ...trace, toolCalls: [] }, assertion, answer), false, 'not grounded in a source search');
    const functionBody = 'func (uc *UseCase) SyncJob(ctx context.Context) error {\n'
      + 'job.Status = JobStatusFinished\nreturn uc.repo.Update(ctx, job)\n}';
    assistant(db, ROOT, 3, 45, 60, [
      tool('read', { path: POLL }, 46, 47, { output: functionBody }),
      tool('grep', { pattern: '\\.MarkTag\\s*\\(|\\.Mark\\s*\\(' }, 48, 59, { output: 'No matches found' }),
    ]);
    const noMatch = getTrace(db);
    const negative = { ...noMatch, toolCalls: noMatch.toolCalls.slice(1) };
    assert.equal(grade(negative, assertion, answer), true, 'scoped negative call search plus checked completion path');
    assert.equal(grade({ ...negative, toolCalls: negative.toolCalls.slice(1) }, assertion, answer), false, 'empty search alone');
    for (const input of [{ path: 'fixtures' }, { include: '*_test.go' }, { pattern: 'MarkTag' }]) {
      const narrowed = negative.toolCalls.map((call: RecordedTrace['toolCalls'][number]): RecordedTrace['toolCalls'][number] =>
        call.name === 'grep' ? { ...call, input: { ...call.input, ...input } } : call);
      assert.equal(grade({ ...negative, toolCalls: narrowed }, assertion, answer), false, 'unrelated negative search');
    }
    const shell = (command: string, exitCode: number): RecordedTrace => ({
      ...negative,
      toolCalls: negative.toolCalls.map((call: RecordedTrace['toolCalls'][number]): RecordedTrace['toolCalls'][number] =>
        call.name === 'grep' ? { ...call, name: 'shell', input: { command }, output: '(no output)', exitCode } : call),
    });
    assert.equal(grade(shell("git grep -nE '\\.MarkTag\\s*\\(' -- go-projects", 1), assertion, answer), true);
    assert.equal(grade(shell("git grep -nE '\\.MarkTag\\s*\\(' -- go-projects", 2), assertion, answer), false);
    assert.equal(grade(shell("git grep -nE '\\.MarkTag\\s*\\(' -- fixtures", 1), assertion, answer), false);
    assert.equal(grade(shell("git grep -nE '\\.MarkTag\\s*\\(' -- go-projects | head", 1), assertion, answer), false);
  } finally {
    db.close();
  }
}

function assertL1Answers(): void {
  const db = fixture();
  try {
    message(db, ROOT, 1, 'user', 10, 10);
    const trace = getTrace(db);
    const answerRule = (file: string): Record<string, unknown> => {
      const test = JSON.parse(readFileSync(new URL(`../../cases/l1/${file}.json`, import.meta.url), 'utf8')) as {
        assertions: Record<string, unknown>[];
      };
      return test.assertions[0];
    };
    const location = answerRule('l1-01-three-hop-locate');
    const correctLocation = '改 ConfirmListPanel.tsx 的 ConfirmListPanel：通过按钮无条件渲染。409 是预期拦截。';
    assert.equal(grade(trace, location, correctLocation), true, 'no requirement to name the correct BFF function');
    assert.equal(grade(trace, location, correctLocation.replace('的 ConfirmListPanel', '')), false);
    assert.equal(grade(trace, location, correctLocation.replace('409 是预期拦截。', '')), false);
    assert.equal(grade(trace, location, correctLocation.replace('是预期拦截', '不是预期行为')), false);

    const notify = answerRule('l1-07-do-not-overclaim');
    const neutral = '**归因：未定性**\n'
      + 'receiver 等于 bot_user.userId，是兜底生成的 ObjectId。按登录成员查为 0 条。'
      + '先确认 receiver 的受众契约；目前不能给出具体修复点。「通知漏了客户」并不成立。';
    assert.equal(grade(trace, notify, neutral), true, 'quoted rejected claim is not an overclaim');
    assert.equal(grade(trace, notify, neutral.replace('归因：未定性', '归因：代码缺陷')), false);
    assert.equal(grade(trace, notify, `${neutral}\n证据不支持脏数据，指向写入侧代码问题。`), false);
    assert.equal(grade(trace, notify, `${neutral}\n修复点：把查询换成 bot_user.userId。`), false);
    assert.equal(grade(trace, notify, '归因：未定性\nbot_user.json 还要确认。'), false);

    const card = answerRule('l1-08-card-vs-send');
    const cardOnly = '仅凭提交卡片不构成缺陷。卡片不等于向客户发送。成员确认后才下发。'
      + '若确认前客户实际收到，才属于缺陷。';
    assert.equal(grade(trace, card, cardOnly), true, 'conditional defect is consistent with the observed event');
    assert.equal(grade(trace, card, cardOnly.replace('卡片不等于向客户发送。', '')), false);
    assert.equal(grade(trace, card, `${cardOnly}\n创建时提交卡片本身就是缺陷。`), false);
    assert.equal(grade(trace, card, `${cardOnly}\n提交卡片代表已经向客户发送。`), false);
    assert.equal(grade(trace, card, '创建时不应提交，若确有该行为就是缺陷；应在确认后发送。'), false);
  } finally {
    db.close();
  }
}

function assertSplitParts(): void {
  const db = fixture();
  try {
    db.exec(`
      ALTER TABLE session_message ADD COLUMN id TEXT;
      CREATE TABLE session_part (message_id TEXT, session_id TEXT, ordinal INTEGER, type TEXT, call_id TEXT,
        time_created INTEGER, time_updated INTEGER, data TEXT, PRIMARY KEY (message_id, ordinal));
      INSERT INTO session_v2 VALUES ('child', 'root', 20, 250, 0, 0);
      INSERT INTO session_v2 VALUES ('sibling', 'root', 22, 250, 0, 0);
      INSERT INTO session_v2 VALUES ('unrelated', NULL, 20, 250, 0, 0);
    `);
    const event = (sessionId: string, seq: number, type: string, start: number, end: number,
      data: Record<string, unknown> = {}): string => {
      const id = `${sessionId}:${seq}`;
      db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(sessionId, seq, type, JSON.stringify(data), start, end, id);
      return id;
    };
    const split = (sessionId: string, seq: number, start: number, end: number, finish: string,
      content: readonly unknown[] = []): string => event(sessionId, seq, 'assistant', start, end,
      { content, finish, time: { created: start, completed: end } });
    const insert = db.prepare('INSERT INTO session_part VALUES (?, ?, ?, ?, NULL, 0, 0, ?)');
    const part = (messageId: string, sessionId: string, ordinal: number, value: Record<string, unknown>): void => {
      insert.run(messageId, sessionId, ordinal, String(value.type), JSON.stringify(value));
    };
    event(ROOT, 1, 'user', 10, 10);
    const actions = split(ROOT, 2, 15, 19, 'tool-calls', [tool('subagent', { prompt: 'first' }, 16, 17)]);
    part(actions, ROOT, 2, tool('subagent', { prompt: 'second' }, 16, 17, { child: 'sibling' }));
    part(actions, ROOT, 1, tool('subagent', { prompt: 'first' }, 16, 18, { child: 'child', output: 'captured' }));
    part(actions, ROOT, 0, { type: 'reasoning', text: 'not an answer' });
    part(split(ROOT, 3, 30, 40, 'stop'), ROOT, 0, text('round one'));
    event(ROOT, 4, 'user', 90, 90);
    event(ROOT, 5, 'compaction', 91, 91);
    event(ROOT, 6, 'model-switched', 92, 92);
    const answer = split(ROOT, 7, 115, 125, 'stop');
    part(answer, ROOT, 1, text('second'));
    insert.run(answer, ROOT, 0, 'text', Buffer.from(JSON.stringify(text('first'))));
    event('child', 1, 'user', 20, 20);
    part(split('child', 2, 35, 110, 'tool-calls'), 'child', 0,
      tool('shell', { command: 'read' }, 95, 100, { exit: 1, output: 'not successful' }));
    event('child', 3, 'idle', 112, 112);
    event('sibling', 1, 'user', 22, 22);
    part(split('sibling', 2, 50, 65, 'tool-calls'), 'sibling', 0,
      tool('read', { path: 'one' }, 53, 56, { status: 'error' }));
    split('sibling', 3, 65, 70, 'stop', [text('legacy inline fallback')]);
    event('sibling', 4, 'idle', 71, 71);
    part(split('unrelated', 1, 0, 1, 'stop'), 'unrelated', 0, text('unrelated'));

    const trace = getTrace(db);
    assert.deepEqual(trace.answersByTurn, ['round one', 'first\nsecond']);
    assert.deepEqual(trace.finalObservedByTurn, [true, true]);
    assert.deepEqual(trace.incompleteSessions, []);
    assert.deepEqual(trace.toolCalls.map((call: ToolCall) => [call.name, call.sessionId, call.parentId, call.seq,
      call.partIndex, call.turn, call.startedAt, call.endedAt, call.childSessionId]), [
      ['subagent', ROOT, null, 2, 1, 1, 16, 18, 'child'],
      ['subagent', ROOT, null, 2, 2, 1, 16, 17, 'sibling'],
      ['shell', 'child', ROOT, 2, 0, 2, 95, 100, undefined],
      ['read', 'sibling', ROOT, 2, 0, 1, 53, 56, undefined],
    ]);
    assert.equal(trace.toolCalls[2].exitCode, 1);
    assert.equal(trace.toolCalls[2].output, '');
    assert.equal(trace.toolCalls[0].output, 'captured');
    assert.equal(trace.toolCalls[0].outputCaptured, true);
    assert.equal(trace.toolCalls[3].error, 'failed');
    assert.deepEqual(trace.toolErrors, { read: 1 });
    assert.deepEqual([trace.subagentCount, trace.maxAgentDepth, trace.subagentsParallel,
      trace.compactionCount, trace.modelSwitches, trace.tokensInput, trace.tokensOutput], [2, 1, true, 1, 1, 5, 6]);
    assert.equal(trace.invocations[1].activity.length, 2);

    const missing = split(ROOT, 8, 130, 140, 'stop');
    part(missing, 'unrelated', 0, text('wrong session'));
    const incomplete = getTrace(db);
    assert.deepEqual(incomplete.incompleteSessions, [ROOT]);
    assert.deepEqual(incomplete.finalObservedByTurn, [true, false]);
    assert.equal(assertTrajectory({ type: 'toolOrder', before: 'read', searchTargets: [POLL], readTarget: POLL },
      { trace: incomplete, answer: '', worktree: WORKTREE, forbidden: [], startedAt: 0 })?.missingEvidence, true);
    db.exec("DELETE FROM session_part WHERE message_id = 'root:8'");
    insert.run(missing, ROOT, 0, 'text', '{');
    assert.deepEqual(getTrace(db).incompleteSessions, [ROOT]);
    db.exec("DELETE FROM session_part WHERE message_id = 'root:8'");
    part(missing, ROOT, 1, text('missing ordinal zero'));
    assert.deepEqual(getTrace(db).incompleteSessions, [ROOT]);
    db.exec("DELETE FROM session_part WHERE message_id = 'root:8'");
    part(missing, ROOT, 0, text(''));
    const explicitEmpty = getTrace(db);
    assert.deepEqual(explicitEmpty.incompleteSessions, []);
    assert.deepEqual(explicitEmpty.finalObservedByTurn, [true, true]);
    assert.equal(explicitEmpty.finalText, '');
  } finally {
    db.close();
  }
}

export function runTraceTests(): void {
  assertTurns();
  assertSplitParts();
  assertSearchOrder();
  assertEditOrder();
  assertReadOnlySearchPipelines();
  assertAutoTag();
  assertL1Answers();
  assertResumeDoesNotProveInitialOverlap();
  assert.equal(fanout([[70, 105]], [[80, 130]]), true, 'three matching direct siblings active together');
  assert.equal(fanout([[70, 105]], [[80, 130]], 'auth'), false, 'grandchild is not a direct sibling');
  assert.equal(fanout([[70, 105]], [[80, 130]], ROOT, 'ConfirmListPanel'), false, 'duplicate task does not count');
  assert.equal(fanout([[95, 102]], [[120, 140]]), false, 'overlapping session lifespan alone is insufficient');
  assert.equal(fanout([[70, 105]], [[91, 130]]), false, 'different pairwise overlaps are not three-way overlap');
}
