import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig, resolveModelRef, type ModelSpec } from './config.ts';
import { CALIBRATION_TYPES, digestOf, sha256, type BenchMode, type IsolationDeployment, type ModelIdentity, type ProtocolCase, type ProtocolLock, type RepairPlan } from './protocol.ts';
import { validateLock } from './protocol-validate.ts';
import { loadCases, type CaseDef } from './runner.ts';
import type { IsolationProof } from './scenario-isolation.ts';

export const WORKER_ENTRIES = ['runners', 'cases', 'fixtures', 'judges', 'package.json'];
const LOCKED_ENTRIES = ['bench.config.jsonc', ...WORKER_ENTRIES];

function fileHashes(root: string, normalizedConfig?: string): Record<string, string> {
  function walk(relativePath: string): Array<[string, string]> {
    const path = join(root, relativePath);
    const stat = lstatSync(path);
    if (stat.isDirectory()) return readdirSync(path).sort().flatMap((entry) => walk(`${relativePath}/${entry}`));
    if (!stat.isFile()) throw new Error(`协议输入不是普通文件: ${relativePath}`);
    const bytes = relativePath === 'bench.config.jsonc' && normalizedConfig !== undefined ? normalizedConfig : readFileSync(path);
    return [[relativePath, sha256(bytes)]];
  }
  return Object.fromEntries(LOCKED_ENTRIES.filter((entry) => existsSync(join(root, entry))).flatMap(walk));
}

function opencodeVersion(binary: string): string {
  const version = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();
  if (!version) throw new Error('未取得 OpenCode 版本');
  return version;
}

export function resolveIdentities(specs: ModelSpec[]): ModelIdentity[] {
  return specs.map(({ id, model, variant }) => ({
    id,
    model: resolveModelRef(model),
    ...(variant === undefined ? {} : { variant }),
  }));
}

export function freezeProtocol(opts: {
  root: string;
  mockRepoCommit: string;
  mode: BenchMode;
  concurrency: number;
  repeat: number;
  layers: string[];
  only: string[];
  models: ModelIdentity[];
  repair?: RepairPlan;
  normalizedConfig?: string;
  preflight?: readonly IsolationProof[];
  isolation?: IsolationDeployment;
}): ProtocolLock {
  const { root, mode, repeat, concurrency, layers, only, models, repair, mockRepoCommit, preflight } = opts;
  const config = loadConfig(join(root, 'bench.config.jsonc'));
  const describe = (caseDef: CaseDef): ProtocolCase => ({
    id: caseDef.id,
    layer: caseDef.layer,
    weight: caseDef.weight ?? 1,
    timeoutSec: caseDef.timeoutSec ?? config.run.timeoutSec,
    calibrationTrial: caseDef.assertions.some(({ type }) => CALIBRATION_TYPES.has(String(type))) || !!caseDef.hiddenTests?.length,
  });
  const cases = loadCases(join(root, 'cases'), layers, only).map(describe);
  const suite = loadCases(join(root, 'cases'), Object.keys(config.layers).filter((layer) => config.layers[layer]), []).map(describe);
  const manifest = {
    schema: 1, benchmarkVersion: config.bench.version, mode, concurrency, repeat,
    mockRepoCommit, cases, suiteDigest: digestOf(suite), files: fileHashes(root, opts.normalizedConfig), weights: config.weights,
    platform: `${process.platform}/${process.arch}`,
    ...(opts.isolation ? { isolation: opts.isolation } : {}),
    opencodeVersion: opencodeVersion(config.bench.opencodeBin),
    ...(config.run.switchModel && config.run.switchFallback
      ? { handoff: { primary: config.run.switchModel, fallback: config.run.switchFallback } }
      : {}),
  } as const;
  const lock: ProtocolLock = { manifest, digest: digestOf(manifest), models, runId: randomUUID(),
    ...(preflight ? { preflight } : {}), ...(repair ? { repair } : {}) };
  validateLock(lock);
  return lock;
}

export function verifyWorkerInputs(root: string, binary: string, lock: ProtocolLock, normalizedConfig?: string): void {
  validateLock(lock);
  if (digestOf(fileHashes(root, normalizedConfig)) !== digestOf(lock.manifest.files)) throw new Error('执行输入文件与协议锁不一致');
  if (opencodeVersion(binary) !== lock.manifest.opencodeVersion) throw new Error('worker OpenCode 版本与协议锁不一致');
  if (lock.manifest.platform !== `${process.platform}/${process.arch}`) throw new Error('执行平台与协议锁不一致');
}
