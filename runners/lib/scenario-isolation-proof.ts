import { isAbsolute, normalize } from 'node:path';

import type { IsolationProof } from './scenario-isolation.ts';
import { record } from './scenario-json.ts';

function matches(value: unknown, pattern: RegExp): boolean {
  return typeof value === 'string' && pattern.test(value);
}

function validMounts(value: unknown): boolean {
  const expected = new Map<string, boolean>([
    ['/work', true], ['/model-home', true], ['/run/model-bench-delivery.sock', false],
    ['/run/model-bench-provider.sock', false],
  ]);
  if (!Array.isArray(value) || (value.length !== 3 && value.length !== 4)) return false;
  const sources = new Set<string>();
  for (const mount of value as unknown[]) {
    if (!record(mount) || typeof mount.destination !== 'string' || !expected.has(mount.destination)
      || mount.writable !== expected.get(mount.destination) || typeof mount.source !== 'string'
      || !isAbsolute(mount.source) || normalize(mount.source) !== mount.source || sources.has(mount.source)) return false;
    sources.add(mount.source);
    expected.delete(mount.destination);
  }
  return expected.size === 0 || (expected.size === 1 && expected.has('/run/model-bench-provider.sock'));
}

export function isRootlessProof(value: unknown): value is IsolationProof {
  return record(value) && value.backend === 'rootless-podman-v1'
    && matches(value.isolationId, /^[a-f0-9]{64}$/) && typeof value.modelId === 'string' && value.modelId.length > 0
    && matches(value.containerId, /^[a-f0-9]{64}$/) && matches(value.imageId, /^sha256:[a-f0-9]{64}$/)
    && matches(value.ociDigest, /^[a-f0-9]{64}$/)
    && matches(value.image, /^[a-z0-9][a-z0-9._/:-]+@sha256:[a-f0-9]{64}$/)
    && matches(value.program, /^\/[-\w./]+$/) && matches(value.user, /^[1-9]\d*:\d+$/)
    && matches(value.runtimeVersion, /^5\.[\w.+-]+$/) && matches(value.programVersion, /^[0-9][-\w.+]{0,63}$/)
    && value.network === 'none' && value.pid === 'private' && value.ipc === 'private' && value.capDrop === 'ALL'
    && value.securityOption === 'no-new-privileges' && validMounts(value.mounts);
}

export function matchesFrozenBoundary(expected: IsolationProof, observed: IsolationProof): boolean {
  const keys = ['backend', 'isolationId', 'modelId', 'image', 'imageId', 'program', 'programVersion', 'runtimeVersion', 'user'] as const;
  if (!keys.every((key) => expected[key] === observed[key])) return false;
  const source = (proof: IsolationProof, destination: string): string | undefined =>
    proof.mounts.find((mount) => mount.destination === destination)?.source;
  return ['/model-home', '/run/model-bench-provider.sock'].every((mount) => source(expected, mount) === source(observed, mount));
}
