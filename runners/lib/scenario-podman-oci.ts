import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

import { record } from './scenario-json.ts';
import type { PodmanBoundary } from './scenario-podman-inspect.ts';

function ociSpecification(inspection: unknown): { staticDir: string; spec: unknown; digest: string } {
  const data: unknown = Array.isArray(inspection) && inspection.length === 1 ? inspection[0] : null;
  if (!record(data) || typeof data.OCIConfigPath !== 'string' || !isAbsolute(data.OCIConfigPath)
    || !data.OCIConfigPath.endsWith('/config.json') || realpathSync(data.OCIConfigPath) !== data.OCIConfigPath) {
    throw new Error('Podman did not expose a local OCI specification');
  }
  const stat = lstatSync(data.OCIConfigPath);
  if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.size > 1024 * 1024) {
    throw new Error('Podman OCI specification is not a protected regular file');
  }
  const content = readFileSync(data.OCIConfigPath);
  return { staticDir: dirname(data.OCIConfigPath), spec: JSON.parse(content.toString('utf8')) as unknown,
    digest: createHash('sha256').update(content).digest('hex') };
}

function permittedKernelMount(mount: Record<string, unknown>): boolean {
  const expected = new Map([
    ['/proc', 'proc'], ['/dev', 'tmpfs'], ['/dev/pts', 'devpts'], ['/dev/shm', 'tmpfs'], ['/dev/mqueue', 'mqueue'],
    ['/sys', 'sysfs'], ['/sys/fs/cgroup', 'cgroup'], ['/tmp', 'tmpfs'],
  ]);
  return typeof mount.destination === 'string' && expected.get(mount.destination) === mount.type;
}

function generatedFile(mount: Record<string, unknown>, staticDir: string): boolean {
  const expected: Record<string, string> = {
    '/etc/hostname': 'hostname', '/etc/resolv.conf': 'resolv.conf', '/run/.containerenv': '.containerenv',
  };
  if (typeof mount.destination !== 'string' || !Object.hasOwn(expected, mount.destination)) return false;
  return mount.source === `${staticDir}/${expected[mount.destination]}` && mount.type === 'bind';
}

export function verifyOCISpecification(spec: unknown, staticDir: string, boundary: PodmanBoundary): void {
  if (!record(spec) || !record(spec.root) || spec.root.readonly !== true || !record(spec.process)
    || spec.process.noNewPrivileges !== true || !record(spec.linux) || !Array.isArray(spec.linux.namespaces)
    || !Array.isArray(spec.mounts)) throw new Error('Incomplete Podman OCI sandbox specification');
  const process = spec.process;
  if (!record(process.user) || `${process.user.uid}:${process.user.gid}` !== boundary.user) {
    throw new Error('Unexpected OCI execution UID/GID');
  }
  const cap = process.capabilities;
  if (cap !== undefined && (!record(cap) || Object.values(cap).some((value) => !Array.isArray(value) || value.length > 0))) {
    throw new Error('Unexpected effective OCI capabilities');
  }
  for (const type of ['pid', 'ipc', 'mount', 'uts', 'user', 'network']) {
    if (!spec.linux.namespaces.some((namespace: unknown) => record(namespace)
      && namespace.type === type && (namespace.path === undefined || namespace.path === ''))) {
      throw new Error(`Podman did not create a private OCI ${type} namespace`);
    }
  }
  if (spec.linux.devices !== undefined && (!Array.isArray(spec.linux.devices) || spec.linux.devices.length !== 0)) {
    throw new Error('Unexpected OCI device passthrough');
  }
  if (spec.hooks !== undefined && (!record(spec.hooks) || Object.keys(spec.hooks).length > 0)) {
    throw new Error('Unexpected OCI hooks');
  }
  const expected = new Map(boundary.mounts.map((mount) => [mount.destination, mount] as [string, typeof mount]));
  for (const mount of spec.mounts as unknown[]) {
    if (!record(mount) || typeof mount.destination !== 'string') throw new Error('Invalid OCI mount');
    const binding = expected.get(mount.destination);
    if (binding && mount.type === 'bind' && mount.source === binding.source
      && Array.isArray(mount.options) && mount.options.includes(binding.writable ? 'rw' : 'ro')) {
      expected.delete(mount.destination);
      continue;
    }
    if (!permittedKernelMount(mount) && !generatedFile(mount, staticDir)) throw new Error('Unexpected mount in OCI specification');
  }
  if (expected.size !== 0) throw new Error('Required OCI mount missing');
}

export function inspectOCISpecification(inspection: unknown, boundary: PodmanBoundary): string {
  const { spec, staticDir, digest } = ociSpecification(inspection);
  verifyOCISpecification(spec, staticDir, boundary);
  return digest;
}
