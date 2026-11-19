import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { IsolationConfig } from './scenario-isolation-config.ts';
import { inspectBoundary, inspectedRootless, inspectImage, requireStartedContainer, type PodmanBoundary, type PodmanMount } from './scenario-podman-inspect.ts';
import { inspectOCISpecification } from './scenario-podman-oci.ts';

export interface IsolationProof extends PodmanBoundary {
  readonly backend: 'rootless-podman-v1';
  readonly isolationId: string;
  readonly modelId: string;
  readonly image: string;
  readonly programVersion: string;
  readonly runtimeVersion: string;
  readonly ociDigest: string;
}

export interface IsolatedTurn {
  readonly cwd: string;
  readonly home: string;
  readonly dbPath: string;
  readonly config: IsolationConfig;
  readonly hooksDirectory: string;
  close(): void;
}

export interface IsolatedExecution {
  readonly child: SpawnSyncReturns<string>;
  readonly proof: IsolationProof;
}

export const DELIVERY_ISOLATION_BLOCKER = 'Formal l2-07 requires verified local rootless Podman isolation.';

function invoke(config: IsolationConfig, args: string[], timeout: number): SpawnSyncReturns<string> {
  const { HOME, XDG_RUNTIME_DIR } = process.env;
  return spawnSync(config.podman, ['--remote=false', ...args], {
    cwd: '/', env: { HOME, XDG_RUNTIME_DIR, PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' },
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
  });
}

function response(config: IsolationConfig, args: string[]): string {
  const result = invoke(config, args, 10_000);
  if (result.status !== 0 || result.error) {
    throw new Error(`Podman ${args[0]} failed: ${result.error?.message ?? result.stderr.trim().slice(0, 400)}`);
  }
  return result.stdout.trim();
}

function assertMountable(path: string, type: 'directory' | 'socket'): void {
  const stat = lstatSync(path);
  if (/[,\r\n]/.test(path) || realpathSync(path) !== path || (type === 'socket' ? !stat.isSocket() : !stat.isDirectory())) {
    throw new Error(`Invalid Podman ${type} source`);
  }
}

function mountList(config: IsolationConfig, workspace: IsolatedTurn, delivery: string): PodmanMount[] {
  assertMountable(workspace.cwd, 'directory');
  assertMountable(workspace.home, 'directory');
  assertMountable(delivery, 'socket');
  if (config.providerSocket) assertMountable(config.providerSocket, 'socket');
  return [
    { source: workspace.cwd, destination: '/work', writable: true },
    { source: workspace.home, destination: '/model-home', writable: true },
    { source: delivery, destination: '/run/model-bench-delivery.sock', writable: false },
    ...(config.providerSocket ? [{
      source: config.providerSocket, destination: '/run/model-bench-provider.sock' as const, writable: false,
    }] : []),
  ];
}

function createArgs(
  config: IsolationConfig, name: string, user: string, program: string, hooksDirectory: string,
  mounts: PodmanMount[], args: string[],
): string[] {
  const bindings = mounts.flatMap(({ source, destination, writable }) => [
    '--mount', `type=bind,source=${source},destination=${destination},${writable ? 'rw' : 'ro'},bind-propagation=private,bind-nonrecursive`,
  ]);
  return [
    '--hooks-dir', hooksDirectory, 'create', '--name', name, '--pull=never', '--network=none', '--pid=private', '--ipc=private',
    '--uts=private', '--cgroupns=private', '--userns=keep-id', '--user', user, '--cap-drop=ALL',
    '--security-opt=no-new-privileges', '--read-only', '--read-only-tmpfs=false', '--tmpfs=/tmp:rw,nosuid,nodev,noexec',
    '--pids-limit=256', '--no-hosts', '--no-healthcheck', '--http-proxy=false', '--image-volume=ignore', '--systemd=false',
    '--workdir=/work', '--env=HOME=/model-home', '--env=XDG_CONFIG_HOME=/model-home/.config',
    '--env=XDG_DATA_HOME=/model-home/.local/share', '--env=XDG_CACHE_HOME=/model-home/.cache',
    '--env=XDG_STATE_HOME=/model-home/.local/state', '--env=OPENCODE_BENCH=1', '--entrypoint', program,
    ...bindings, config.image, ...args,
  ];
}

function execute(
  config: IsolationConfig, workspace: IsolatedTurn, publicSocket: string, program: string, args: string[], timeoutMs: number,
): IsolatedExecution {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (process.platform !== 'linux' || !uid || gid === undefined || uid !== process.geteuid?.()) {
    throw new Error(DELIVERY_ISOLATION_BLOCKER);
  }
  if (workspace.config !== config || workspace.home !== config.home) throw new Error('Podman workspace differs from its configuration');
  const runtimeVersion = inspectedRootless(JSON.parse(response(config, ['info', '--format=json'])));
  inspectImage(JSON.parse(response(config, ['image', 'inspect', config.image])), config.image, config.imageId);
  const name = `model-bench-${randomUUID()}`;
  const mounts = mountList(config, workspace, publicSocket);
  const user = `${uid}:${gid}`;
  try {
    const containerId = response(config, createArgs(config, name, user, program, workspace.hooksDirectory, mounts, args));
    if (!/^[a-f0-9]{64}$/.test(containerId)) throw new Error('Podman returned an invalid container ID');
    const expected = { containerId, imageId: config.imageId, program, user, mounts };
    const inspect = (): unknown => JSON.parse(response(config, ['container', 'inspect', containerId]));
    response(config, ['--hooks-dir', workspace.hooksDirectory, 'init', containerId]);
    const initialized = inspect();
    const initialBoundary = inspectBoundary(initialized, expected);
    const ociDigest = inspectOCISpecification(initialized, initialBoundary);
    const child = invoke(config, ['--hooks-dir', workspace.hooksDirectory, 'start', '--attach', containerId], timeoutMs);
    const completed = inspect();
    requireStartedContainer(completed);
    const boundary = inspectBoundary(completed, expected);
    return {
      child, proof: { ...boundary, backend: 'rootless-podman-v1', isolationId: config.isolationId,
        modelId: config.modelId, image: config.image, programVersion: config.version, runtimeVersion, ociDigest },
    };
  } finally {
    response(config, ['rm', '--force', '--ignore', name]);
  }
}

export function runIsolatedModel(
  config: IsolationConfig, workspace: IsolatedTurn, publicSocket: string, args: string[],
  options: { timeoutMs: number },
): IsolatedExecution {
  return execute(config, workspace, publicSocket, config.program, args, options.timeoutMs);
}

export function runIsolatedNode(
  config: IsolationConfig, workspace: IsolatedTurn, publicSocket: string, args: string[],
  options: { timeoutMs: number },
): IsolatedExecution {
  return execute(config, workspace, publicSocket, '/usr/bin/node', args, options.timeoutMs);
}

export function probeIsolatedModel(
  config: IsolationConfig, workspace: IsolatedTurn, publicSocket: string, publicUrl: string,
): IsolationProof {
  const socket = execute(config, workspace, publicSocket, '/usr/bin/curl',
    ['--fail', '--silent', '--unix-socket', '/run/model-bench-delivery.sock', `${publicUrl}/repo/C/status`], 5000);
  if (socket.child.status !== 0) throw new Error(`Podman could not reach the mounted delivery socket: ${socket.child.stderr}`);
  const node = runIsolatedNode(config, workspace, publicSocket, ['-e', 'require("node:sqlite")'], { timeoutMs: 5000 });
  if (node.child.status !== 0) throw new Error('Podman image does not contain the required Node SQLite runtime');
  const version = runIsolatedModel(config, workspace, publicSocket, ['--version'], { timeoutMs: 5000 });
  if (version.child.status !== 0 || version.child.stdout.trim() !== config.version) {
    throw new Error(`Podman model program did not report the pinned version ${config.version}`);
  }
  return version.proof;
}

export function isolatedWorkspace(config: IsolationConfig): IsolatedTurn {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'model-bench-oci-'));
  const close = (): void => rmSync(parent, { recursive: true, force: true });
  try {
    const cwd = mkdtempSync(join(parent, 'work-'));
    const hooksDirectory = mkdtempSync(join(parent, 'hooks-'));
    return { cwd, home: config.home, dbPath: join(config.home, '.local/share/opencode/opencode.db'), config, hooksDirectory, close };
  } catch (error: unknown) {
    close();
    throw error;
  }
}
