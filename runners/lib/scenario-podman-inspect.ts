import { record } from './scenario-json.ts';

export interface PodmanMount {
  readonly source: string;
  readonly destination: '/work' | '/model-home' | '/run/model-bench-delivery.sock' | '/run/model-bench-provider.sock';
  readonly writable: boolean;
}

export interface PodmanBoundary {
  readonly containerId: string;
  readonly imageId: string;
  readonly program: string;
  readonly user: string;
  readonly network: 'none';
  readonly pid: 'private';
  readonly ipc: 'private';
  readonly capDrop: 'ALL';
  readonly securityOption: 'no-new-privileges';
  readonly mounts: readonly PodmanMount[];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string') ? value : [];
}

function isEmptyArray(value: unknown): boolean {
  return value === undefined || value === null || (Array.isArray(value) && value.length === 0);
}

export function inspectBoundary(
  value: unknown, expected: Pick<PodmanBoundary, 'containerId' | 'imageId' | 'program' | 'user' | 'mounts'>,
): PodmanBoundary {
  const inspection: unknown = Array.isArray(value) && value.length === 1 ? value[0] : null;
  if (!record(inspection) || !record(inspection.HostConfig) || !record(inspection.Config)) {
    throw new Error('Podman did not return a single container inspection');
  }
  const { HostConfig: host, Config: container } = inspection;
  if (inspection.Id !== expected.containerId
    || (inspection.Image !== expected.imageId && inspection.Image !== expected.imageId.slice('sha256:'.length)) || inspection.Path !== expected.program
    || container.User !== expected.user || container.WorkingDir !== '/work'
    || host.Privileged !== false || host.ReadonlyRootfs !== true || host.NetworkMode !== 'none'
    || !['', 'private'].includes(String(host.PidMode)) || host.IpcMode !== 'private'
    || host.UsernsMode !== 'keep-id' || !['', 'private'].includes(String(host.UTSMode))
    || !isEmptyArray(host.CapAdd) || !isEmptyArray(host.Devices) || !isEmptyArray(host.DeviceCgroupRules)
    || !isEmptyArray(host.GroupAdd) || !strings(host.CapDrop).includes('ALL')
    || !strings(host.SecurityOpt).every((option) => option === 'no-new-privileges' || option === 'no-new-privileges=true')
    || strings(host.SecurityOpt).length !== 1 || !isEmptyArray(inspection.EffectiveCaps)
    || !isEmptyArray(inspection.BoundingCaps)) {
    throw new Error('Podman inspect did not establish the required isolated execution boundary');
  }
  if (!Array.isArray(inspection.Mounts) || inspection.Mounts.length !== expected.mounts.length
    || !expected.mounts.every((expectedMount) => inspection.Mounts.some((mount: unknown) =>
      record(mount) && mount.Type === 'bind' && mount.Source === expectedMount.source
      && mount.Destination === expectedMount.destination && mount.RW === expectedMount.writable
      && (mount.Propagation === 'private' || mount.Propagation === 'rprivate')))) {
    throw new Error('Podman inspect showed unexpected or missing bind mounts');
  }
  if (host.PortBindings != null && (!record(host.PortBindings) || Object.keys(host.PortBindings).length !== 0)) {
    throw new Error('Podman inspect showed unexpected port bindings');
  }
  return {
    ...expected, network: 'none', pid: 'private', ipc: 'private', capDrop: 'ALL', securityOption: 'no-new-privileges',
  };
}

export function inspectedRootless(value: unknown): string {
  if (!record(value) || !record(value.host) || !record(value.host.security) || value.host.security.rootless !== true
    || value.host.serviceIsRemote !== false || !record(value.version) || typeof value.version.Version !== 'string'
    || !/^5\.[\w.+-]+$/.test(value.version.Version)) {
    throw new Error('Expected verified local Linux rootless Podman 5.x');
  }
  return value.version.Version;
}

export function inspectImage(value: unknown, ref: string, id: string): void {
  const image: unknown = Array.isArray(value) && value.length === 1 ? value[0] : null;
  if (!record(image) || (image.Id !== id && image.Id !== id.slice('sha256:'.length))
    || !strings(image.RepoDigests).includes(ref) || image.Os !== 'linux') {
    throw new Error('Podman image does not match the frozen digest and image ID');
  }
}
