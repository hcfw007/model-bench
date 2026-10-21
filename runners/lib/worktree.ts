import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface WorktreeHandle {
  dir: string;
  branch: string;
  branchesBefore: string[];
}

function safe(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '-');
}

function listBranches(repo: string): string[] {
  try {
    return execSync(`git -C ${repo} branch --format='%(refname:short)'`, { encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function createWorktree(repo: string, root: string, caseId: string, modelId: string, idx: number): WorktreeHandle {
  mkdirSync(root, { recursive: true });
  const branch = `bench/${safe(caseId)}-${safe(modelId)}-${idx}`;
  const dir = resolve(root, branch.replace(/\//g, '_'));
  // 清掉可能残留的目录与分支
  try {
    execSync(`git -C ${repo} worktree remove --force ${dir}`, { stdio: 'ignore' });
  } catch {
    /* ignore */
  }
  try {
    execSync(`git -C ${repo} branch -D ${branch}`, { stdio: 'ignore' });
  } catch {
    /* ignore */
  }
  execSync(`git -C ${repo} worktree add -b ${branch} ${dir} main`, { stdio: 'pipe' });
  return { dir, branch, branchesBefore: listBranches(repo) };
}

export function removeWorktree(repo: string, h: WorktreeHandle): void {
  try {
    execSync(`git -C ${repo} worktree remove --force ${h.dir}`, { stdio: 'ignore' });
  } catch {
    /* ignore */
  }
  try {
    execSync(`git -C ${repo} branch -D ${h.branch}`, { stdio: 'ignore' });
  } catch {
    /* ignore */
  }
  // 清掉模型在 case 期间自己创建的分支，避免污染后续模型/用例
  // （如 l0-04 里模型真的执行了 git checkout -b）
  for (const b of listBranches(repo)) {
    if (!h.branchesBefore.includes(b) && b !== 'main') {
      try {
        execSync(`git -C ${repo} branch -D ${b}`, { stdio: 'ignore' });
      } catch {
        /* ignore */
      }
    }
  }
  try {
    execSync(`git -C ${repo} worktree prune`, { stdio: 'ignore' });
  } catch {
    /* ignore */
  }
}

/** 把 hiddenTests 声明的文件拷进 worktree。格式：`相对cases路径 -> worktree内相对路径` */
export function installHiddenTests(casesRoot: string, wt: string, specs: string[]): void {
  for (const spec of specs) {
    const [from, to] = spec.split('->').map((s) => s.trim());
    if (!from || !to) continue;
    const src = resolve(casesRoot, from);
    const dst = resolve(wt, to);
    // 源文件缺失必须报错：静默跳过会让隐藏测试形同虚设
    if (!existsSync(src)) {
      throw new Error(`hidden test not found: ${src} (spec: ${spec})`);
    }
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst);
  }
}
