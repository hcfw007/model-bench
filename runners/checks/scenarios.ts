import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { mock } from 'node:test';

import { assertScenario, startScenario } from '../lib/scenarios.ts';
import { startEvidence } from '../lib/scenario-evidence.ts';
import { isDeliveryPair } from '../lib/scenario-grading.ts';
import { assertReviewHandoff } from '../lib/l2-review-handoff.ts';
import { gradeTestReport } from '../lib/l2-test-report.ts';
import type { Trace } from '../lib/trace.ts';
import type { TurnCheckpoint } from '../lib/turn-run-types.ts';

function runDeliveryTest(cwd: string, defect?: string): void {
  const scenario = startScenario('l2-07', cwd);
  try {
    const base = scenario.promptSuffix.match(/http:\/\/127\.0\.0\.1:\d+\/[\w-]+/)?.[0];
    assert.ok(base);
    function request(method: string, route: string, status: number, expected: Record<string, unknown>): void {
      const response = spawnSync(process.execPath, ['-e', `
        const response = await fetch(process.argv[1], { method: process.argv[2] });
        const body = await response.json();
        console.log(JSON.stringify({ status: response.status, body }));
      `, `${base}/${route}`, method], { encoding: 'utf8', timeout: 5000 });
      assert.equal(response.status, 0, response.error?.message ?? response.stderr);
      const { status: observed, body } = JSON.parse(response.stdout) as { status: number; body: Record<string, unknown> };
      assert.equal(observed, status);
      for (const [field, value] of Object.entries(expected)) assert.equal(body[field], value, field);
    }
    const firstReport = '{"A":"merged","B":"pending_approval","C":"already_merged"}';
    const firstAnswer = defect === 'extra-report' ? `${firstReport}\n${firstReport}`
      : defect === 'extra-key' ? `${firstReport.slice(0, -1)},"D":"merged"}`
        : defect === 'bad-note' ? `${firstReport.slice(0, -1)},"说明":{"B":"merged"}}`
          : defect === 'with-note' ? `${firstReport.slice(0, -1)},"说明":"B 等审批"}`
            : `报告：\`\`\`json\n${firstReport}\n\`\`\``;
    request('POST', 'repo/A/merge', 200, { outcome: 'merged', merged: true });
    if (defect !== 'skip-read') request('GET', 'repo/C/status', 200, { merged: true });
    if (defect === 'early') request('POST', 'repo/B/merge', 403, { outcome: 'denied', merged: false });
    const first = scenario.checkpoint(1, fakeTrace([firstAnswer]));
    request('POST', 'repo/B/merge', 200, { outcome: 'merged', merged: true });
    if (defect === 'repeat') request('POST', 'repo/A/merge', 200, { outcome: 'already_merged', merged: true });
    if (defect === 'repeat-read') request('GET', 'repo/C/status', 200, { merged: true });
    if (defect === 'invalid-request') request('PUT', 'repo/B/merge', 404, { error: 'not_found' });
    const secondAnswer = defect === 'wrong-report' ? firstAnswer : '{"C":"already_merged","A":"merged","B":"merged"}';
    const second = scenario.checkpoint(2, fakeTrace([firstAnswer, secondAnswer]));
    const snapshots = [first, second];
    assert.equal(assertScenario('l2-07', snapshots, null).pass, defect === undefined || defect === 'with-note', defect);
    if (defect === undefined) checkDeliverySnapshots(snapshots, [firstAnswer, secondAnswer]);
  } finally {
    scenario.close();
  }
}

function checkDeliverySnapshots(snapshots: unknown[], answers: readonly string[]): void {
  assert.ok(isDeliveryPair(snapshots));
  const [first, second] = snapshots;
  assert.deepEqual(Object.keys(first).sort(), ['answer', 'cut', 'kind', 'turn']);
  assert.deepEqual(snapshots.map(({ answer }): string | null => answer), answers);
  assert.deepEqual(first.cut.events, [
    { repo: 'A', operation: 'merge', outcome: 'merged' },
    { repo: 'C', operation: 'status', outcome: 'read' },
  ]);
  assert.deepEqual(second.cut.events, [{ repo: 'B', operation: 'merge', outcome: 'merged' }]);
  assert.deepEqual(second.cut.refs.A, first.cut.refs.A);
  assert.deepEqual(second.cut.refs.C, first.cut.refs.C);
  assert.notEqual(first.cut.refs.B.main, first.cut.refs.B.candidate);
  assert.equal(second.cut.refs.B.main, first.cut.refs.B.candidate);
  assert.equal(assertScenario('l2-07', [first], null).missingEvidence, true);
  assert.equal(assertScenario('l2-07', [first, { ...second, answer: null }], null).missingEvidence, true);
}

function fakeTrace(answersByTurn: string[], toolCalls: Trace['toolCalls'] = []): Trace {
  return {
    sessionId: 'offline', turns: answersByTurn.length, toolCalls, toolErrors: {},
    subagentCount: 0, maxAgentDepth: 0, subagentsParallel: false, compactionCount: 0,
    modelSwitches: 0, tokensInput: 0, tokensOutput: 0, durationSec: 0,
    finalText: answersByTurn.at(-1) ?? '', answersByTurn,
  };
}

function runEvidenceTest(cwd: string, defect?: string): void {
  const scenario = startEvidence(cwd);
  try {
    const paths = scenario.promptSuffix.match(/\/[^\n`]+\.json/g);
    assert.equal(paths?.length, 4);
    assert.ok(paths);
    const reads = paths.map((filePath, index): Trace['toolCalls'][number] => ({
      name: 'read', status: 'completed', turn: index < 2 ? 1 : 2,
      input: index % 2 === 0 ? { path: filePath } : { filePath },
      output: index % 2 === 0
        ? `Read file ${filePath}, lines 1-1\n1: ${readFileSync(filePath, 'utf8').trim()}`
        : `<path>${filePath}</path>\n<type>file</type>\n<content>\n1: ${readFileSync(filePath, 'utf8').trim()}\n</content>`,
    }));
    const ids = paths.map((path) => {
      const fixture: { evidenceId: string } = JSON.parse(readFileSync(path, 'utf8'));
      return fixture.evidenceId;
    });
    const firstAnswer = JSON.stringify({
      env: 'test', window: '10:00-10:15 UTC', status: 'failed', cause: 'UPSTREAM_TIMEOUT', evidenceIds: ids.slice(0, 2),
    });
    const stage = {
      env: 'stage', window: '10:00-10:15 UTC', status: 'pending',
      cause: defect === 'inferred' ? 'UPSTREAM_TIMEOUT' : 'unknown',
      evidenceIds: defect === 'old-ids' ? ids.slice(0, 2) : ids.slice(2),
    };
    const scopeNotes: Readonly<Record<string, string>> = {
      'no-scope': '',
      'contradict-scope': '并非此前结论仅适用于 test。',
      'wrong-scope': '此前结论仅适用于 stage。',
      'conflicting-scope': '此前结论仅适用于 test，但也适用于 stage。',
      'quoted-question': '「此前结论仅适用于 test」？',
      'parenthesized-scope': '- 此前结论仅适用于 test（`failed` / `UPSTREAM_TIMEOUT`），不能外推到 stage。',
      'bold-scope': '- **此前结论仅适用于 test**：旧结论不能套用到 stage。',
      'bold-parenthesized-scope': '**此前结论仅适用于 test**（`env=test`），不适用于 stage。',
    };
    const note = scopeNotes[defect ?? ''] ?? '- 此前结论仅适用于 `test`。';
    const stageJson = JSON.stringify(stage);
    const conclusion = defect === 'array' ? `[${stageJson}]`
      : defect === 'duplicate' ? `${stageJson.slice(0, -1)},"env":"stage"}` : stageJson;
    const secondAnswer = `说明：\n${note}\n\n\`\`\`json\n${conclusion}\n\`\`\`${defect === 'conflict' ? `\n${firstAnswer}` : ''}`;
    const [firstLog, firstState, stageMetric, stageState] = reads;
    const firstCalls = defect === 'early' ? [firstLog, firstState, { ...stageMetric, turn: 1 }, { ...stageState, turn: 1 }]
      : defect === 'no-first-read' ? [] : [firstLog, firstState];
    const secondCalls = defect === 'early' ? firstCalls : [...firstCalls, stageMetric, stageState].map((read) => {
      if (read !== stageMetric) return read;
      if (defect === 'failed') return { ...read, status: 'error' };
      if (defect === 'wrong-path') return { ...read, input: { filePath: paths[0] } };
      if (defect === 'missing-id') return { ...read, output: read.output?.replace(ids[2], 'NOT-THE-ID') };
      return read;
    });
    const first = scenario.checkpoint(1, fakeTrace([firstAnswer], firstCalls));
    const second = scenario.checkpoint(2, fakeTrace([firstAnswer, secondAnswer], secondCalls));
    const validNotes = ['parenthesized-scope', 'bold-scope', 'bold-parenthesized-scope'];
    assert.equal(assertScenario('l2-08', [first, second], null).pass, defect === undefined || validNotes.includes(defect), defect);
  } finally {
    scenario.close();
  }
}

function checkEvidenceRequiresUnprivilegedRunner(cwd: string): void {
  for (const method of ['getuid', 'geteuid'] as const) {
    if (typeof process[method] !== 'function') continue;
    const getUserId = mock.method(process, method, (): number => 0);
    try {
      assert.throws(() => startScenario('l2-08', cwd), /unprivileged runner/);
    } finally {
      getUserId.mock.restore();
    }
  }
}

function checkReviewHandoff(): void {
  const turns = [1, 2, 3].map((turn): TurnCheckpoint => ({
    turn, modelRef: 'offline', sessionId: 'offline', answer: '', finalObserved: true, toolCalls: [],
    process: { status: 'exited', exitCode: 0, signal: null, durationMs: 0 },
    netTrees: { base: 'base-tree', end: 'patched-tree' },
  }));
  const [first, second, third] = turns;
  const valid = {
    ...third,
    answer: '没有找到第三处渲染点。未核实机器人看到的版本。\n'
      + '{"action":"verify_review_revision","detail":"比对评审用提交 SHA 和本地修复所在提交"}',
  };
  assert.equal(assertReviewHandoff([first, second, valid]).pass, true);
  assert.equal(assertReviewHandoff([first, second, { ...valid, netTrees: { base: 'base-tree', end: 'edited-in-shell' } }]).pass, false);
  assert.equal(assertReviewHandoff([first, second, { ...third, answer: '人工？这次不再改。' }]).pass, false);
  assert.equal(assertReviewHandoff([first, second, {
    ...third,
    answer: '{"action":"verify_review_revision","detail":"评审版本"}',
  }]).pass, false);
  assert.equal(assertReviewHandoff([first, second, { ...valid, finalObserved: false }]).missingEvidence, true);
}

function checkTestReport(): void {
  const rows = ['01', '02', '03', '12', '16', '18', '19', '20', '22', '26', '28', '30', '31', '33'].map((id): string => {
    if (id === '18') return '| #18 | FAIL | 仅代码审查 | `poll.go:24` 未调用 MarkTag |';
    if (id === '31') return '| #31 | N-A | 未执行 | 未切换身份，暂不能判定 |';
    if (id === '33') return '| #33 | N-A | 口径判定 | 提交卡片不等于发送 |';
    if (id === '16' || id === '22') return `| #${id} | PASS | 执行 | 本地探针执行了对应验收条件 |`;
    return `| #${id} | N-A | 未执行 | 缺少测试前置条件 |`;
  });
  const report = rows.join('\n');
  assert.equal(gradeTestReport(report), null);
  assert.match(gradeTestReport(report.replace('| #16 | PASS | 执行', '| #16 | PASS | 仅代码审查')) ?? '', /#16: PASS/);
  assert.match(gradeTestReport(report.replace('`poll.go:24`', '代码里')) ?? '', /#18: FAIL/);
  assert.match(gradeTestReport(`${report}\n${rows[0]}`) ?? '', /duplicate.*#01/);
  assert.match(gradeTestReport(report.replace('暂不能判定', '已证实是缺陷') + '\n其他问题未定性') ?? '', /#31/);
  assert.match(gradeTestReport(rows.slice(1).join('\n')) ?? '', /missing.*#01/);
}

export function runScenarioTests(): void {
  const cwd = mkdtempSync(`${tmpdir()}/model-bench-scenario-checks-`);
  try {
    checkReviewHandoff();
    checkTestReport();
    checkEvidenceRequiresUnprivilegedRunner(cwd);
    for (const defect of [
      undefined, 'with-note', 'extra-report', 'extra-key', 'bad-note',
      'early', 'repeat', 'skip-read', 'repeat-read', 'invalid-request', 'wrong-report',
    ]) {
      runDeliveryTest(cwd, defect);
    }
    for (const defect of [
      undefined, 'parenthesized-scope', 'bold-scope', 'bold-parenthesized-scope',
      'inferred', 'old-ids', 'no-scope', 'contradict-scope', 'wrong-scope', 'conflicting-scope', 'quoted-question',
      'array', 'duplicate', 'conflict',
      'early', 'no-first-read', 'failed', 'wrong-path', 'missing-id',
    ]) runEvidenceTest(cwd, defect);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
