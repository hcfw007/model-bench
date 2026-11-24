import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { BenchConfig } from '../lib/config.ts';
import { runCase, type CaseDef } from '../lib/runner.ts';
import { runSerialModels } from '../lib/run-serial.ts';

const OUTCOMES = {
  success: 'pass', missing: 'missing_evidence', timeout: 'timeout', violation: 'violation',
  'cli-error': 'error', 'hidden-tamper': 'assert_fail', 'no-answer': 'missing_evidence',
  'empty-final': 'pass', 'missing-assertion': 'missing_evidence',
  'delivery-success': 'pass', 'delivery-revert': 'assert_fail', 'delivery-missing-cut': 'missing_evidence',
} as const;

const SCRIPT = String.raw`
const { DatabaseSync } = require('node:sqlite');
const { readFileSync, writeFileSync, rmSync } = require('node:fs');
const { strict: assert } = require('node:assert');
const { randomUUID } = require('node:crypto');
async function run() {
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
assert.deepEqual(args.slice(0, 3), ['run', '--auto', '--standalone']);
assert.equal(process.env.PWD, process.cwd());
const prompt = args.at(-1);
const resume = args.includes('--session');
const delivery = prompt.startsWith('delivery-');
const quotaTest = prompt.startsWith('quota-');
const modelRef = value('-m');
const root = resume ? value('--session') : 'ses_' + randomUUID();
if (!quotaTest) assert.equal(modelRef, resume && !delivery ? 'fixture/alternate#high' : 'fixture/main#high');
if (!delivery) {
  assert.equal(readFileSync('seed.txt', 'utf8'), 'seed+append');
  assert.equal(readFileSync('hidden.txt', 'utf8'), 'trusted');
}
if (!resume && prompt === 'missing') {
  console.log('turn two');
  process.exit(0);
}
const db = new DatabaseSync(__dirname + '/trace.db');
if (!resume) {
  const now = Date.now();
  db.prepare('insert into session_v2 values (?, ?, null, ?, ?, 0, 0)').run(root, value('--title'), now, now);
} else {
  assert.equal(prompt, delivery ? 'delivery-follow-up' : 'follow-up');
}
const insert = db.prepare('insert into session_message values (?, ?, ?, ?, ?, ?)');
const index = resume ? 4 : 1;
const now = Date.now();
insert.run(root, index, 'user', JSON.stringify({content: [{type:'text', text: prompt}]}), now, now);
if (quotaTest) {
  const [providerID, id] = modelRef.split('#')[0].split('/');
  const code = prompt === 'quota-burst' ? 'RequestBurstTooFast'
    : prompt === 'quota-generic' ? 'QuotaExceeded' : 'AccountQuotaExceeded';
  const message = code === 'AccountQuotaExceeded'
    ? 'You have exceeded the 5-hour usage quota. It will reset at 2026-11-26 00:00:00 +0800 CST.'
    : 'The request has exceeded the quota. Please retry later.';
  const error = {type:'provider.quota', status:429, message,
    response:{body:JSON.stringify({error:{code, message}})}};
  const quotaError = providerID === 'fixture' && !['quota-text', 'quota-later'].includes(prompt);
  const text = prompt === 'quota-text' ? JSON.stringify(error) : modelRef;
  const content = quotaError ? [] : [{type:'text', text}];
  insert.run(root, index + 2, 'assistant', JSON.stringify({content, model:{providerID, id},
    finish:quotaError ? 'error' : 'stop', time:{completed:now + 2}, ...(quotaError ? {error} : {})}), now + 2, now + 2);
  db.close();
  if (prompt === 'quota-cleanup' && quotaError) {
    const { execFileSync } = require('node:child_process');
    const git = (...args) => execFileSync('git', args, {encoding:'utf8'}).trim();
    const gitDir = git('rev-parse', '--path-format=absolute', '--git-common-dir');
    const branch = git('symbolic-ref', 'HEAD');
    writeFileSync(gitDir + '/' + branch + '.lock', '');
    process.exit(7);
  }
  if (prompt === 'quota-timeout' && quotaError) {
    setInterval(() => {}, 100);
  }
  return;
}
const first = JSON.parse(db.prepare('select data from session_message where session_id = ? and seq = 1').get(root).data);
const startPrompt = first.content[0].text;
const firstCase = startPrompt.split('\n')[0];
const content = firstCase === 'empty-final' && !resume ? [] : [{ type: 'text', text: resume ? 'turn two' : 'turn one' }];
if (prompt === 'violation') {
  content.push({ type: 'tool', name: 'shell', state: {status:'completed', input:{command:'fixture_forbidden'}} });
}
if (firstCase === 'missing-assertion' && resume) {
  const read = { type: 'tool', name: 'read', state: {status:'completed', input:{filePath:'seed.txt'}} };
  insert.run(root, index + 1, 'assistant', JSON.stringify({ content: [read] }), now + 1, now + 1);
}
if (firstCase === 'delivery-success' || firstCase === 'delivery-revert') {
  const endpoint = startPrompt.match(/http:\/\/127\.0\.0\.1:\d+\/[\da-f-]+/)[0];
  if (!resume) assert.equal((await fetch(endpoint + '/repo/C/status')).status, 200);
  const target = resume ? 'B' : 'A';
  assert.equal((await fetch(endpoint + '/repo/' + target + '/merge', { method: 'POST' })).status, 200);
  content[0].text = JSON.stringify({ A: 'merged', B: resume ? 'merged' : 'pending_approval', C: 'already_merged' });
  if (firstCase === 'delivery-revert') {
    if (resume) rmSync('transient.txt');
    else writeFileSync('transient.txt', 'must be detected\n');
  }
}
if (firstCase === 'no-answer') {
  insert.run(root, index + 1, 'assistant', JSON.stringify({ content }), now + 1, now + 1);
  console.log('turn two');
} else {
  insert.run(root, index + 2, 'assistant', JSON.stringify({ content, finish: 'stop', time: { completed: now + 2 } }), now + 2, now + 2);
}
db.close();
if (resume) {
  if (firstCase === 'hidden-tamper') rmSync('hidden.txt');
  if (!delivery) writeFileSync('result.txt', 'result\n');
}
if (prompt === 'cli-error') process.exit(7);
if (prompt === 'timeout' || prompt === 'violation') setInterval(() => {}, 100);
}
run().catch((error) => { console.error(error); process.exitCode = 1 });
`;

function testRun(prompt: keyof typeof OUTCOMES): void {
  const root = mkdtempSync(join(tmpdir(), 'model-bench-cli-test-'));
  try {
    const mockRepo = join(root, 'mock');
    const worktreeRoot = join(root, 'worktrees');
    const casesRoot = join(root, 'cases');
    const dbPath = join(root, 'trace.db');
    const opencodeBin = join(root, 'fake-cli');
    mkdirSync(casesRoot);
    writeFileSync(join(casesRoot, 'gold.txt'), 'trusted');
    writeFileSync(join(root, 'mock.cjs'), SCRIPT);
    const node = `'${process.execPath.replaceAll("'", "'\\''")}'`;
    writeFileSync(opencodeBin, `#!/bin/sh\nexec ${node} "$(dirname "$0")/mock.cjs" "$@"\n`, { mode: 0o700 });
    execFileSync('git', ['init', '-q', '-b', 'main', mockRepo]);
    execFileSync('git', ['-C', mockRepo, 'config', '--local', 'core.hooksPath', join(root, 'disabled-hooks')]);
    execFileSync('git', ['-C', mockRepo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '-qm', 'base', '--allow-empty']);
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        create table session_v2 (id text, title text, parent_id text, time_created integer, time_updated integer,
          tokens_input integer, tokens_output integer);
        create table session_message (session_id text, seq integer, type text, data text,
          time_created integer, time_updated integer);
      `);
    } finally {
      db.close();
    }
    const cfg = {
      bench: { name: 'test', version: 'test', opencodeBin, dbPath, mockRepo, worktreeRoot, reportsDir: root },
      models: [], run: { repeat: 1, concurrency: 1, timeoutSec: 2, maxTurns: 2, keepWorktree: false,
        switchModel: 'fixture/main#high', switchFallback: 'fixture/alternate#high' },
      weights: {}, layers: {}, safety: { forbiddenCommands: ['fixture_forbidden'], protectedPaths: [] },
      scoring: { reworkPenalty: 0, maxReworkTurns: 0, violationZeroesRun: true },
    } satisfies BenchConfig;
    const delivery = prompt.startsWith('delivery-');
    const caseDef: CaseDef = {
      id: delivery ? 'l2-07' : 'fixture-test', layer: 'l0', title: prompt, prompt,
      followUps: prompt === 'delivery-missing-cut' ? [] : [delivery ? 'delivery-follow-up' : 'follow-up'],
      switchModelAfterTurn: delivery ? undefined : 1,
      timeoutSec: prompt === 'timeout' || prompt === 'violation' ? 1 : undefined, allowedTurns: 2,
      setup: delivery ? undefined : { files: { 'seed.txt': 'seed' }, append: { 'seed.txt': '+append' } },
      hiddenTests: delivery ? undefined : ['gold.txt -> hidden.txt'],
      assertions: delivery ? [{ type: 'scenario' }] : prompt === 'missing-assertion'
        ? [{ type: 'toolOrder', before: 'read', readTarget: 'seed.txt', searchTargets: ['seed.txt'] }]
        : [
        { type: 'exactText', value: 'turn two' },
        { type: 'diffAddedText', path: 'result.txt', pattern: '^result$' },
      ],
    };
    const result = runCase({ cfg, casesRoot, caseDef, modelId: 'fixture/main', modelRef: 'fixture/main#high', idx: 3 });
    assert.equal(result.repeatIndex, 3);
    assert.deepEqual(readdirSync(worktreeRoot), []);
    assert.equal(result.outcome, OUTCOMES[prompt], JSON.stringify(result));
    assert.equal(result.pass, OUTCOMES[prompt] === 'pass');
    assert.equal(result.violation, prompt === 'violation');
    if (prompt === 'success') assert.equal(result.assertions.find(({ type }) => type === 'diffAddedText')?.pass, true);
    if (['success', 'hidden-tamper', 'empty-final', 'missing-assertion'].includes(prompt)) {
      assert.ok(result.sessionId);
      assert.ok(result.checkpoints.every(({ sessionId, finalObserved }) => sessionId === result.sessionId && finalObserved));
      assert.deepEqual(result.checkpoints.map((checkpoint) => checkpoint.answer),
        [prompt === 'empty-final' ? '' : 'turn one', 'turn two']);
      assert.deepEqual(result.checkpoints[1]?.netDiff?.files, ['result.txt']);
    } else if (prompt !== 'delivery-revert' && prompt !== 'delivery-success') {
      assert.equal(result.checkpoints.length, 1);
      assert.equal(result.assertions.some(({ type }) => type === 'exactText'), false);
    }
    if (prompt === 'no-answer') assert.equal(result.checkpoints[0]?.finalObserved, false);
    if (prompt === 'missing-assertion') assert.equal(result.assertions.find(({ type }) => type === 'toolOrder')?.missingEvidence, true);
    if (prompt === 'delivery-missing-cut') assert.equal(result.assertions.find(({ type }) => type === 'scenario')?.missingEvidence, true);
    if (prompt === 'delivery-success' || prompt === 'delivery-revert') {
      assert.ok(result.sessionId);
      assert.ok(result.checkpoints.every(({ sessionId, finalObserved }) => sessionId === result.sessionId && finalObserved));
      assert.deepEqual(result.checkpoints.map(({ netDiff }) => netDiff?.files),
        [prompt === 'delivery-revert' ? ['transient.txt'] : [], []]);
      assert.equal(result.assertions.find(({ type }) => type === 'scenario')?.pass, true);
      assert.equal(result.assertions.find(({ type }) => type === 'scenarioWorktreeClean')?.pass, prompt === 'delivery-success');
    }
    if (prompt === 'success' || prompt === 'delivery-success') testSerial(cfg, casesRoot, caseDef, join(root, 'serial'));
    if (prompt === 'success') testQuotaFallback(cfg, casesRoot, caseDef, join(root, 'quota'));
    if (prompt === 'missing') assert.equal(result.answer, '');
    if (prompt === 'timeout' || prompt === 'violation') assert.equal(result.checkpoints[0]?.process.status, 'timeout');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testSerial(cfg: BenchConfig, casesRoot: string, caseDef: CaseDef, outDir: string): void {
  const model = { id: 'fixture/main', model: 'fixture/main', variant: 'high' };
  const options = {
    cfg, casesRoot, cases: [caseDef, { ...caseDef, id: 'unselected' }], specs: [model], repeat: 4, outDir,
  };
  const slot = { caseId: caseDef.id, repeatIndex: 3 };
  for (const badSlot of [
    { ...slot, modelId: 'unknown' }, { ...slot, caseId: 'unknown' }, { ...slot, repeatIndex: 4 },
    { ...slot, repeatIndex: -1 }, { ...slot, repeatIndex: 1.5 }, { ...slot, modelId: model.id },
  ]) {
    assert.throws(() => runSerialModels({ ...options, slots: [slot, badSlot] }), /slot/);
    assert.equal(existsSync(outDir), false);
  }
  assert.throws(() => runSerialModels({
    ...options, specs: [model, { ...model, id: 'fixture/other' }], slots: [slot],
  }), /modelId/);
  assert.equal(existsSync(outDir), false);
  const selected = runSerialModels({ ...options, slots: [slot] });
  assert.deepEqual(selected.map(({ caseId, modelId, repeatIndex, outcome }) => [caseId, modelId, repeatIndex, outcome]),
    [[caseDef.id, model.id, 3, 'pass']]);
  assert.deepEqual(runSerialModels({ ...options, slots: [] }), []);
}

function testQuotaFallback(cfg: BenchConfig, casesRoot: string, template: CaseDef, outDir: string): void {
  const specs = [
    { id: 'fixture/main', model: 'fixture/main', variant: 'high' },
    { id: 'fixture/other', model: 'fixture/other', variant: 'high' },
    { id: 'fixture-unrelated/main', model: 'fixture-unrelated/main', variant: 'high' },
  ];
  const cases = ['burst', 'generic', 'timeout', 'text', 'cleanup', 'hit', 'later'].map((kind): CaseDef => ({
    ...template, id: `quota-${kind}`, prompt: `quota-${kind}`, followUps: [], switchModelAfterTurn: undefined,
    timeoutSec: kind === 'timeout' ? 1 : undefined,
    assertions: kind === 'text' ? [{ type: 'exactText', value: 'wrong answer' }] : [],
  }));
  const rows = runSerialModels({
    cfg: { ...cfg, run: { ...cfg.run, quotaFallback: { from: 'fixture', to: 'fixture-backup' } } },
    casesRoot, cases, specs, repeat: 1, outDir,
    slots: [...cases.map(({ id }) => ({ modelId: specs[0].id, caseId: id, repeatIndex: 0 })),
      ...specs.slice(1).map(({ id: modelId }) => ({ modelId, caseId: 'quota-later', repeatIndex: 0 }))],
  });
  assert.deepEqual(rows.map((row) => row.outcome),
    ['missing_evidence', 'missing_evidence', 'timeout', 'assert_fail', 'error', 'pass', 'pass', 'pass', 'pass']);
  assert.ok(rows.slice(0, 5).every((row) => row.quotaFallback === undefined));
  const [, , , , cleanup, retried, later, anotherModel, unrelated] = rows;
  assert.match(cleanup.error ?? '', /cleanup:/);
  assert.equal(retried.modelId, 'fixture/main');
  assert.equal(retried.actualModelRef, 'fixture-backup/main#high');
  assert.equal(retried.answer, retried.actualModelRef);
  assert.equal(retried.quotaFallback?.reason, 'subscription_quota_exhausted');
  assert.equal(retried.quotaFallback?.code, 'AccountQuotaExceeded');
  assert.equal(retried.quotaFallback?.originalAttempt?.outcome, 'missing_evidence');
  assert.notEqual(retried.quotaFallback?.originalAttempt?.sessionId, retried.sessionId);
  assert.match(retried.quotaFallback?.trigger.sessionId ?? '', /^ses_/);
  assert.deepEqual(later.quotaFallback?.trigger, retried.quotaFallback?.trigger);
  assert.equal(later.quotaFallback?.originalAttempt, undefined);
  assert.equal(later.answer, retried.actualModelRef);
  assert.equal(anotherModel.answer, 'fixture-backup/other#high');
  assert.deepEqual(anotherModel.quotaFallback?.trigger, retried.quotaFallback?.trigger);
  assert.equal(unrelated.answer, 'fixture-unrelated/main#high');
  assert.equal(unrelated.quotaFallback, undefined);
  const persisted = JSON.parse(readFileSync(join(outDir, 'results.partial.json'), 'utf8')) as unknown;
  assert.deepEqual(persisted, JSON.parse(JSON.stringify(rows)) as unknown);
}

export function runRunnerTests(): void {
  for (const prompt of Object.keys(OUTCOMES) as Array<keyof typeof OUTCOMES>) testRun(prompt);
}
