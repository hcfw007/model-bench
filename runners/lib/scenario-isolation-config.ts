import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, normalize, resolve, sep } from 'node:path';

import { record } from './scenario-json.ts';

export interface IsolationConfig {
  readonly isolationId: string;
  readonly podman: string;
  readonly image: string;
  readonly imageId: string;
  readonly program: string;
  readonly version: string;
  readonly providerSocket?: string;
  readonly modelId: string;
  readonly home: string;
}

export function loadIsolationConfig(path: string, modelId: string): IsolationConfig {
  const uid = process.getuid?.();
  if (process.platform !== 'linux' || !uid || uid !== process.geteuid?.()) {
    throw new Error('Rootless Podman isolation requires a non-root Linux host runner');
  }
  trustedFile(path);
  const source = readFileSync(path);
  const input: unknown = JSON.parse(source.toString('utf8'));
  if (!record(input) || typeof input.podman !== 'string' || typeof input.image !== 'string'
    || !/^[a-z0-9][a-z0-9._/:-]+@sha256:[a-f0-9]{64}$/.test(input.image)
    || typeof input.imageId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(input.imageId)
    || typeof input.program !== 'string' || !/^\/[-\w./]+$/.test(input.program) || normalize(input.program) !== input.program
    || typeof input.version !== 'string' || !/^[0-9][-\w.+]{0,63}$/.test(input.version)
    || !record(input.modelHomes) || !Object.hasOwn(input.modelHomes, modelId)) {
    throw new Error('Invalid rootless Podman isolation configuration');
  }
  trustedFile(input.podman);
  const homes = Object.values(input.modelHomes).map((home) => privateModelHome(home, uid));
  if (homes.some((home, index) => homes.some((other, peer) => index !== peer
    && (home === other || home.startsWith(`${other}/`))))) throw new Error('Model HOME paths must be distinct and disjoint');
  const home = privateModelHome(input.modelHomes[modelId], uid);
  assertDisjointModelHome(home, [process.cwd()]);
  const providerSocket = input.providerSocket;
  if (providerSocket !== undefined) {
    if (typeof providerSocket !== 'string' || /[,\r\n]/.test(providerSocket) || realpathSync(providerSocket) !== providerSocket) {
      throw new Error('Provider socket must have a canonical path');
    }
    const stat = lstatSync(providerSocket);
    if (!stat.isSocket() || stat.uid !== 0) throw new Error('Provider socket must be created by the trusted host deployment');
    trustPath(dirname(providerSocket), false);
  }
  const isolationId = createHash('sha256').update(source).update(readFileSync(input.podman)).digest('hex');
  return { isolationId, podman: input.podman, image: input.image, imageId: input.imageId,
    program: input.program, version: input.version, modelId, home, providerSocket };
}

export function assertDisjointModelHome(home: string, protectedPaths: readonly string[]): void {
  for (const item of protectedPaths) {
    const path = resolve(item);
    if (path === home || path.startsWith(`${home}${sep}`) || home.startsWith(`${path}${sep}`)) {
      throw new Error(`Isolated model HOME must not overlap a protected path: ${path}`);
    }
  }
}

function privateModelHome(home: unknown, uid: number): string {
  if (typeof home !== 'string' || !isAbsolute(home) || /[,\r\n]/.test(home) || realpathSync(home) !== home) {
    throw new Error('Model HOME must have a canonical mountable path');
  }
  const stat = lstatSync(home);
  if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0 || home === process.env.HOME) {
    throw new Error('Model HOME must be a dedicated private directory, not the runner HOME');
  }
  return home;
}

export function trustedFile(path: string): void {
  trustPath(path, true);
}

function trustPath(path: string, file: boolean): void {
  if (!isAbsolute(path) || normalize(path) !== path) throw new Error(`Expected canonical absolute path: ${path}`);
  for (let entry = path;; entry = dirname(entry)) {
    const stat = lstatSync(entry);
    if (stat.uid !== 0 || (stat.mode & 0o022) !== 0 || (entry === path && file ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error(`Untrusted isolation path component: ${entry}`);
    }
    if (dirname(entry) === entry) return;
  }
}
