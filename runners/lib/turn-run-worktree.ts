import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { BenchConfig } from './config.ts';

interface Workspace {
  readonly cwd: string;
  close(): void;
}

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function branches(repo: string): string[] {
  return git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').trimEnd().split('\n').filter(Boolean);
}

export function openWorkspace(cfg: BenchConfig, useWorktree: boolean): Workspace {
  const { mockRepo, worktreeRoot } = cfg.bench;
  if (!useWorktree) return { cwd: mockRepo, close(): void {} };

  const existing = new Set(branches(mockRepo));
  const name = randomUUID();
  const cwd = join(worktreeRoot, `bench_${name}`);
  mkdirSync(worktreeRoot, { recursive: true });
  const branch = `bench/${name}`;
  try {
    git(mockRepo, 'worktree', 'add', '-b', branch, cwd, 'main');
  } catch (error: unknown) {
    try {
      if (branches(mockRepo).includes(branch)) git(mockRepo, 'branch', '-D', '--', branch);
    } catch (cleanupError: unknown) {
      throw new AggregateError([error, cleanupError], 'worktree creation and rollback failed');
    }
    throw error;
  }

  return {
    cwd,
    close(): void {
      if (cfg.run.keepWorktree) return;
      git(mockRepo, 'worktree', 'remove', '--force', cwd);
      for (const existingBranch of branches(mockRepo)) {
        if (!existing.has(existingBranch)) git(mockRepo, 'branch', '-D', '--', existingBranch);
      }
    },
  };
}
