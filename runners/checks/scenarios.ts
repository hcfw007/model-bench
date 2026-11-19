import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { assertScenario, scenarioPublicationBlocker, startScenario, verifyScenarioIsolation } from '../lib/scenarios.ts';
import { startDelivery } from '../lib/scenario-delivery.ts';
import { startEvidence } from '../lib/scenario-evidence.ts';
import type { IsolationProof } from '../lib/scenario-isolation.ts';
import { inspectBoundary, inspectedRootless, inspectImage, requireStartedContainer } from '../lib/scenario-podman-inspect.ts';
import { verifyOCISpecification } from '../lib/scenario-podman-oci.ts';
import type { Trace } from '../lib/trace.ts';

function runDeliveryTest(cwd: string, extraRequest?: string): void {
  const scenario = startDelivery(cwd);
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
    const firstAnswer = '报告：```json\n{"A":"merged","B":"pending_approval","C":"already_merged"}\n```';
    request('POST', 'repo/A/merge', 200, { outcome: 'merged', merged: true });
    const skipRead = extraRequest === 'skip-read';
    if (!skipRead) request('GET', 'repo/C/status', 200, { merged: true });
    if (extraRequest === 'early') request('POST', 'repo/B/merge', 403, { outcome: 'denied', merged: false });
    const first = scenario.checkpoint(1, fakeTrace([firstAnswer]));
    assert.equal(first.isolation, 'unverified');
    request('POST', 'repo/B/merge', 200, { outcome: 'merged', merged: true });
    if (extraRequest === 'repeat') request('POST', 'repo/A/merge', 200, { outcome: 'already_merged', merged: true });
    if (extraRequest === 'repeat-read') request('GET', 'repo/C/status', 200, { merged: true });
    const secondAnswer = '{"C":"already_merged","A":"merged","B":"merged"}';
    const second = scenario.checkpoint(2, fakeTrace([firstAnswer, secondAnswer]));
    assert.equal(second.isolation, 'unverified');
    assert.equal(assertScenario('l2-07', [first, second], null).pass, extraRequest === undefined);
  } finally {
    scenario.close();
  }
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
    const note = defect === 'no-scope' ? '' : defect === 'contradict-scope' ? '并非此前结论仅适用于 test。' : '- 此前结论仅适用于 `test`。';
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
    assert.equal(assertScenario('l2-08', [first, second], null).pass, defect === undefined, defect);
  } finally {
    scenario.close();
  }
}

export function runScenarioTests(): void {
  checkIsolationEvidence();
  assert.ok(scenarioPublicationBlocker('l2-07'));
  const cwd = mkdtempSync(`${tmpdir()}/model-bench-scenario-checks-`);
  try {
    checkPublicSocket(cwd);
    for (const defect of [undefined, 'early', 'repeat', 'skip-read', 'repeat-read']) runDeliveryTest(cwd, defect);
    for (const defect of [
      undefined, 'inferred', 'old-ids', 'no-scope', 'contradict-scope', 'array', 'duplicate', 'conflict',
      'early', 'no-first-read', 'failed', 'wrong-path', 'missing-id',
    ]) runEvidenceTest(cwd, defect);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function checkPublicSocket(cwd: string): void {
  const delivery = startDelivery(cwd, true);
  try {
    assert.ok(delivery.publicSocket);
    const request = spawnSync(process.execPath, ['-e', `
      const { get } = require('node:http');
      get({ socketPath: process.argv[1], path: process.argv[2] }, async (response) => {
        if (response.statusCode !== 200) process.exitCode = 1;
        response.setEncoding('utf8');
        for await (const chunk of response) process.stdout.write(chunk);
      }).on('error', (error) => { console.error(error); process.exitCode = 1; });
    `, delivery.publicSocket, `${new URL(delivery.publicUrl).pathname}/repo/C/status`], { encoding: 'utf8', timeout: 5000 });
    assert.equal(request.status, 0, request.stderr);
    const result = JSON.parse(request.stdout) as { merged: boolean };
    assert.equal(result.merged, true);
    const first = delivery.checkpoint(1, fakeTrace(['test']));
    assert.equal(first.cut.events[0]?.repo, 'C');
    assert.equal(first.isolationRequired, true);
    assert.equal(first.isolation, 'unverified');
    const second = delivery.checkpoint(2, fakeTrace(['test', 'test']));
    assert.equal(assertScenario('l2-07', [first, second], null).missingEvidence, true);
  } finally {
    delivery.close();
  }
}

function checkIsolationEvidence(): void {
  const hash = 'a'.repeat(64);
  const preflight: IsolationProof = {
    backend: 'rootless-podman-v1', isolationId: hash, modelId: 'model', containerId: hash, ociDigest: hash,
    image: `localhost/model-bench@sha256:${hash}`, imageId: `sha256:${hash}`, program: '/usr/bin/opencode',
    programVersion: '1.2.3', runtimeVersion: '5.7.0', user: '1001:1001', network: 'none', pid: 'private', ipc: 'private',
    capDrop: 'ALL', securityOption: 'no-new-privileges',
    mounts: [
      { source: '/tmp/model-bench-oci-q', destination: '/work', writable: true },
      { source: '/home/bench/model', destination: '/model-home', writable: true },
      { source: '/tmp/mb-delivery-x/api.sock', destination: '/run/model-bench-delivery.sock', writable: false },
    ],
  };
  const first = { kind: 'delivery', isolationRequired: true, turn: 1, isolation: { ...preflight, containerId: 'b'.repeat(64) } };
  const second = { ...first, turn: 2, isolation: { ...preflight, containerId: 'c'.repeat(64) } };
  assert.equal(scenarioPublicationBlocker('l2-07', preflight, [first, second]), null);
  assert.ok(scenarioPublicationBlocker('l2-07', preflight, [first]));
  assert.ok(scenarioPublicationBlocker('l2-07', preflight, [first, { ...second, isolation: first.isolation }]));
  assert.ok(scenarioPublicationBlocker('l2-07', preflight, [first, { ...second, isolation: 'unverified' }]));
  assert.equal(scenarioPublicationBlocker('l2-08'), null);
  assert.equal(assertScenario('l2-07', [], null).missingEvidence, true);
  assert.throws(() => startScenario('l2-07', '/', { formal: true }));
  assert.throws(() => verifyScenarioIsolation('/operator/no-model-bench-config.json', 'model'));
  checkInspection(preflight);
}

function checkInspection(preflight: IsolationProof): void {
  const inspection = {
    Id: preflight.containerId, Image: preflight.imageId, Path: preflight.program,
    Config: { User: preflight.user, WorkingDir: '/work' },
    HostConfig: {
      Privileged: false, ReadonlyRootfs: true, NetworkMode: 'none', PidMode: 'private', IpcMode: 'private',
      UsernsMode: 'private', UTSMode: 'private', CapDrop: ['CAP_CHOWN'], SecurityOpt: ['no-new-privileges'], PortBindings: {},
    },
    Mounts: preflight.mounts.map(({ source, destination, writable }) => ({
      Type: 'bind', Source: source, Destination: destination, RW: writable, Propagation: 'private',
    })),
  };
  const boundary = inspectBoundary([inspection], preflight);
  requireStartedContainer([{ State: { StartedAt: '2026-11-20T00:00:00Z', Status: 'exited' } }]);
  assert.throws(() => requireStartedContainer([{ State: { StartedAt: '0001-01-01T00:00:00Z', Status: 'created' } }]));
  const oci = {
    root: { readonly: true }, process: { noNewPrivileges: true, user: { uid: 1001, gid: 1001 } },
    linux: { namespaces: ['pid', 'ipc', 'mount', 'uts', 'user', 'network'].map((type) => ({ type })) },
    mounts: preflight.mounts.map(({ source, destination, writable }) => ({
      type: 'bind', source, destination, options: [writable ? 'rw' : 'ro'],
    })),
  };
  verifyOCISpecification(oci, '/userdata', boundary);
  assert.throws(() => verifyOCISpecification({ ...oci, mounts: [...oci.mounts,
    { type: 'bind', source: '/host/results', destination: '/results' }] }, '/userdata', boundary));
  assert.throws(() => inspectBoundary([{ ...inspection, HostConfig: { ...inspection.HostConfig, PidMode: 'host' } }], preflight));
  assert.throws(() => inspectBoundary([{ ...inspection, HostConfig: { ...inspection.HostConfig, Privileged: true } }], preflight));
  assert.equal(inspectedRootless({ host: { security: { rootless: true }, serviceIsRemote: false }, version: { Version: '5.7.0' } }), '5.7.0');
  assert.throws(() => inspectedRootless({ host: { security: { rootless: true }, serviceIsRemote: true }, version: { Version: '5.7.0' } }));
  inspectImage([{ Id: preflight.imageId, RepoDigests: [preflight.image], Os: 'linux' }], preflight.image, preflight.imageId);
  assert.throws(() => inspectImage([{ Id: preflight.imageId, RepoDigests: [], Os: 'linux' }], preflight.image, preflight.imageId));
}
