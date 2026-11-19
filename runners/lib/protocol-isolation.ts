import { isAbsolute, posix } from 'node:path';

import { digestOf, type IsolationDeployment, type ProtocolLock } from './protocol.ts';
import type { IsolationConfig } from './scenario-isolation-config.ts';
import type { IsolationProof } from './scenario-isolation.ts';
import { isRootlessProof, matchesFrozenBoundary } from './scenario-isolation-proof.ts';
import { record } from './scenario-json.ts';
import { scenarioPublicationBlocker, verifyScenarioIsolation } from './scenarios.ts';
import type { CaseResult } from './score.ts';

interface IsolationPreflight {
  readonly preflight: readonly IsolationProof[];
  readonly deployment: IsolationDeployment;
  readonly configs: ReadonlyMap<string, IsolationConfig>;
}

function proofDeployment(proof: IsolationProof): IsolationDeployment {
  const { backend, isolationId, image, imageId, program, programVersion, runtimeVersion } = proof;
  return { backend, isolationId, image, imageId, program, programVersion, podmanVersion: runtimeVersion };
}

function imageProgram(program: string): boolean {
  return posix.normalize(program) === program && !['/work', '/model-home', '/tmp', '/run', '/proc', '/sys', '/dev']
    .some((directory) => program === directory || program.startsWith(`${directory}/`));
}

export function runIsolationPreflight(configPath: string, modelIds: readonly string[]): IsolationPreflight {
  if (!isAbsolute(configPath)) throw new Error('隔离配置必须是受保护的绝对路径');
  if (!modelIds.length) throw new Error('隔离预检需要至少一个模型');
  const probes = modelIds.map((modelId) => verifyScenarioIsolation(configPath, modelId));
  const preflight = probes.map((probe) => probe.preflight);
  const deployment = proofDeployment(preflight[0]);
  validatePreflight({
    manifest: { mode: 'formal', isolation: deployment, platform: `${process.platform}/${process.arch}` },
    models: modelIds.map((id) => ({ id })),
    preflight,
  });
  return { preflight, deployment, configs: new Map(probes.map(({ config }) => [config.modelId, config])) };
}

export function preflightMatches(expected: IsolationProof, observed: IsolationProof): boolean {
  return isRootlessProof(expected) && isRootlessProof(observed) && matchesFrozenBoundary(expected, observed);
}

function mountSource(proof: IsolationProof, destination: string): string | undefined {
  return proof.mounts.find((mount) => mount.destination === destination)?.source;
}

interface PreflightLock {
  readonly manifest: Pick<ProtocolLock['manifest'], 'mode' | 'isolation' | 'platform'>;
  readonly preflight?: ProtocolLock['preflight'];
  readonly models: readonly { readonly id: string }[];
}

export function validatePreflight(lock: PreflightLock): void {
  const { manifest: { mode, isolation, platform }, preflight, models } = lock;
  if (!isolation) {
    if (mode === 'formal' || preflight !== undefined) throw new Error('正式运行缺少已验证的交付隔离');
    return;
  }
  if (isolation.backend !== 'rootless-podman-v1') throw new Error('仅接受 rootless Podman 隔离；旧 setpriv 证明无效');
  if (!platform.startsWith('linux/')) throw new Error('rootless Podman 正式证明只接受 Linux 宿主');
  if (!Array.isArray(preflight) || preflight.length !== models.length) throw new Error('隔离预检不完整');
  const homes = new Set<string>();
  const containers = new Set<string>();
  const expectedDeployment = digestOf(isolation);
  for (const { id } of models) {
    const proof = preflight.find((entry) => record(entry) && entry.modelId === id);
    if (!isRootlessProof(proof) || !imageProgram(proof.program)
      || digestOf(proofDeployment(proof)) !== expectedDeployment || containers.has(proof.containerId)) {
      throw new Error(`无效或重复的 Podman 模型预检: ${id}`);
    }
    const home = mountSource(proof, '/model-home');
    if (!home || [...homes].some((other) => home === other || home.startsWith(`${other}/`) || other.startsWith(`${home}/`))) {
      throw new Error(`Podman 模型 HOME 必须独立: ${id}`);
    }
    containers.add(proof.containerId);
    homes.add(home);
  }
}

export function deliveryProofBlocker(row: CaseResult, expected: IsolationProof | undefined): string | null {
  if (row.caseId !== 'l2-07') return null;
  const checkpoints = row.checkpoints ?? [];
  if (!expected || expected.modelId !== row.modelId || !checkpoints.length) return '缺少交付预检或实际轮次证明';
  const minimum = row.outcome === 'timeout' || row.outcome === 'violation' ? 1 : 2;
  if (checkpoints.length < minimum || checkpoints.length > 2) return '交付实际轮次证明数量不符';
  for (const [index, checkpoint] of checkpoints.entries()) {
    if (!record(checkpoint) || checkpoint.turn !== index + 1 || !record(checkpoint.process)
      || !['exited', 'timeout', 'error'].includes(String(checkpoint.process.status))
      || (index + 1 < checkpoints.length && checkpoint.process.status !== 'exited')) {
      return '交付检查点缺少有效的进程结束状态';
    }
    const { status, exitCode } = checkpoint.process;
    if ((status === 'exited' && exitCode !== 0) || (status === 'timeout' && exitCode !== null)) {
      return '交付检查点的退出码与进程状态不一致';
    }
  }
  const last = checkpoints.at(-1);
  const status = record(last) && record(last.process) ? last.process.status : undefined;
  if ((row.outcome === 'timeout' && status !== 'timeout')
    || ((row.outcome === 'pass' || row.outcome === 'assert_fail') && status !== 'exited')) {
    return '交付结果分类与实际终止状态不一致';
  }
  return scenarioPublicationBlocker(row.caseId, expected, checkpoints.map((checkpoint) =>
    record(checkpoint) ? checkpoint.scenario : undefined), minimum);
}
