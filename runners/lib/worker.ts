/**
 * 并行测试床：启动时冻结一份参考快照（代码/用例/配置 + mockrepo 克隆），
 * 每个模型从这份快照复制，保证同一次跑分里所有模型看到完全相同的输入。
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripJsonc } from './config.ts';

/** 跑分所需的最小集合；reports/.worktrees 等运行产物不复制 */
const WORKER_ENTRIES = ['runners', 'cases', 'fixtures', 'judges', 'package.json'];

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function mockRepoHead(repo: string): string {
  return git(repo, ['rev-parse', 'HEAD']);
}

/**
 * 克隆只带走已提交内容，未提交改动会让并行测试床与当前仓不一致。
 * 串行模式不受此限制，这里只在并行前调用。
 */
export function assertMockRepoClean(repo: string): void {
  const dirty = git(repo, ['status', '--porcelain']);
  if (dirty.length > 0) {
    throw new Error(`mockrepo 有未提交改动，并行克隆无法保证与当前测试床一致:\n${dirty}`);
  }
}

/**
 * 冻结参考快照：复制代码/用例，重写配置强制指向本地克隆，再克隆 mockrepo。
 * 配置改写是隔离的关键：绝对路径的 mockRepo/worktreeRoot 会让子进程回到主仓。
 */
export function prepareReference(opts: {
  repoRoot: string;
  dest: string;
  configPath: string;
  mockRepo: string;
}): { dir: string; commit: string } {
  const { repoRoot, dest, configPath, mockRepo } = opts;
  if (existsSync(dest)) throw new Error(`参考快照已存在: ${dest}`);
  mkdirSync(dest, { recursive: true });

  for (const entry of WORKER_ENTRIES) {
    const src = join(repoRoot, entry);
    if (existsSync(src)) cpSync(src, join(dest, entry), { recursive: true });
  }

  const cfg = JSON.parse(stripJsonc(readFileSync(configPath, 'utf8'))) as {
    bench: Record<string, unknown>;
  };
  cfg.bench = { ...cfg.bench, mockRepo: './mockrepo', worktreeRoot: './.worktrees', reportsDir: './reports' };
  writeFileSync(join(dest, 'bench.config.jsonc'), `${JSON.stringify(cfg, null, 2)}\n`);

  execFileSync(
    'git',
    ['clone', '--quiet', '--no-hardlinks', '--single-branch', '--branch', 'main', mockRepo, join(dest, 'mockrepo')],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const commit = mockRepoHead(join(dest, 'mockrepo'));
  const expected = mockRepoHead(mockRepo);
  if (commit !== expected) throw new Error(`mockrepo 克隆提交不一致: ${commit} != ${expected}`);
  return { dir: dest, commit };
}

/** 从冻结快照复制出该模型的执行根，提交用快照提交校验 */
export function prepareWorkerRoot(opts: {
  reference: string;
  referenceCommit: string;
  dest: string;
}): { dir: string; commit: string } {
  const { reference, referenceCommit, dest } = opts;
  if (existsSync(dest)) throw new Error(`工作目录已存在: ${dest}`);
  cpSync(reference, dest, { recursive: true });
  const commit = mockRepoHead(join(dest, 'mockrepo'));
  if (commit !== referenceCommit) throw new Error(`工作目录提交不一致: ${commit} != ${referenceCommit}`);
  return { dir: dest, commit };
}

/** 删除整份测试床；调用方负责确认无活跃子进程 */
export function removeWorkerRoot(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
