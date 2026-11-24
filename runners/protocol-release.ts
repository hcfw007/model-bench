import { spawnSync } from 'node:child_process';
import { constants, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadConfig } from './lib/config.ts';
import { readJson, verifiedLogDigest, verifyReleaseEvidence } from './lib/protocol-evidence.ts';
import { verifyWorkerInputs } from './lib/protocol-freeze.ts';
import { calibrationTrialCases, contentDigest, REQUIRED_MODELS, verifyCalibrationTrial, type CalibrationReview } from './lib/protocol-release.ts';
import { validateLock } from './lib/protocol-validate.ts';
import type { ProtocolLock } from './lib/protocol.ts';
import { readRunResults } from './lib/report.ts';
import { assertMockRepoClean, mockRepoMain, normalizeWorkerConfig } from './lib/worker.ts';

const [action, formalDir, evidenceDir, rawPath, manifestPath] = process.argv.slice(2);
if (!formalDir || !['trial-args', 'calibrate', 'trial', 'review', 'verify'].includes(action)
  || (action !== 'trial-args' && !evidenceDir)) {
  throw new Error('usage: node runners/protocol-release.ts <trial-args|calibrate|trial|review|verify> <formalDir> [evidenceDir] [sourcePath] [description.json]');
}
const root = resolve(import.meta.dirname, '..');
const lock = readJson<ProtocolLock>(resolve(formalDir, 'protocol.lock.json'));
validateLock(lock);
if (lock.manifest.mode !== 'formal' || lock.repair) throw new Error('验收需使用正式协议锁');
const digest = contentDigest(lock);
const writeJson = (name: string, body: unknown): void =>
  writeFileSync(resolve(evidenceDir, name), `${JSON.stringify(body, null, 2)}\n`, { flag: 'wx' });

function calibrate(): void {
  const configPath = resolve(root, 'bench.config.jsonc');
  const config = loadConfig(configPath);
  const verifyInputs = (): void => {
    assertMockRepoClean(config.bench.mockRepo);
    if (mockRepoMain(config.bench.mockRepo) !== lock.manifest.mockRepoCommit) throw new Error('离线校准测试床提交不符');
    verifyWorkerInputs(root, config.bench.opencodeBin, lock, normalizeWorkerConfig(configPath));
  };
  verifyInputs();
  const commands = [['runners/selftest.ts'], ['runners/run-bench.ts', '--dry-run', '--mode', 'formal']].map((args, index) => {
    const command = args.join(' ');
    const run = spawnSync(process.execPath, args, {
      cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, OPENCODE_BENCH_WORKER: '0' },
    });
    const log = resolve(evidenceDir, `calibration-${index}.log`);
    writeFileSync(log, `$ node ${command}\n${run.stdout ?? ''}${run.stderr ?? ''}${run.error?.message ?? ''}`, { flag: 'wx' });
    if (run.status !== 0) throw new Error(`离线校准失败: ${command}（见 ${log}）`);
    return { command, exitCode: run.status, logDigest: verifiedLogDigest(log) };
  });
  verifyInputs();
  writeJson('calibration.json', { contentDigest: digest, commands });
}

if (evidenceDir && action !== 'verify') mkdirSync(evidenceDir, { recursive: true });
switch (action) {
  case 'trial-args':
    console.log(`--mode trial --repeat 3 --concurrency ${lock.manifest.concurrency} --cases ${calibrationTrialCases(lock).join(',')} --models ${REQUIRED_MODELS.join(',')},<non-openai-flash>`);
    break;
  case 'calibrate':
    calibrate();
    break;
  case 'trial': {
    if (!rawPath) throw new Error('trial 缺少试跑报告目录');
    verifyCalibrationTrial(lock, readRunResults(rawPath));
    const target = resolve(evidenceDir, 'trial');
    mkdirSync(target);
    for (const file of ['protocol.lock.json', 'results.json']) copyFileSync(resolve(rawPath, file), resolve(target, file));
    break;
  }
  case 'review': {
    if (!rawPath || !manifestPath) throw new Error('review 缺少原件或描述 JSON 路径');
    const { reviewer, groups } = readJson<Pick<CalibrationReview, 'reviewer' | 'groups'>>(manifestPath);
    const original = resolve(evidenceDir, 'replay.md');
    verifiedLogDigest(rawPath);
    copyFileSync(rawPath, original, constants.COPYFILE_EXCL);
    writeJson('review.json', { reviewer, groups, contentDigest: digest, replayDigest: verifiedLogDigest(original) });
    break;
  }
  case 'verify':
    verifyReleaseEvidence(lock, evidenceDir);
    break;
}
if (action !== 'trial-args') console.log(`${action}: ${digest}`);
