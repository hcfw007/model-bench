import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

export function expandHome(p: string): string {
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return p;
}

/** 极简 jsonc → json：去行注释、去尾逗号。不处理字符串内部的 //。 */
export function stripJsonc(src: string): string {
  const noComment = src
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  return noComment.replace(/,(\s*[}\]])/g, '$1');
}

export interface ModelSpec {
  id: string;
  model: string;
  variant?: string;
  note?: string;
}

export interface BenchConfig {
  bench: {
    name: string;
    version: string;
    opencodeBin: string;
    dbPath: string;
    mockRepo: string;
    worktreeRoot: string;
    reportsDir: string;
  };
  models: ModelSpec[];
  run: {
    repeat: number;
    concurrency: number;
    timeoutSec: number;
    maxTurns: number;
    keepWorktree: boolean;
  };
  weights: Record<string, number>;
  layers: Record<string, boolean>;
  safety: { forbiddenCommands: string[]; protectedPaths: string[] };
  scoring: { reworkPenalty: number; maxReworkTurns: number; violationZeroesRun: boolean };
}

export function loadConfig(configPath: string): BenchConfig {
  const raw = readFileSync(configPath, 'utf8');
  const cfg = JSON.parse(stripJsonc(raw)) as BenchConfig;
  const base = dirname(resolve(configPath));

  cfg.bench.dbPath = expandHome(cfg.bench.dbPath);
  cfg.bench.mockRepo = resolve(base, cfg.bench.mockRepo);
  cfg.bench.worktreeRoot = resolve(base, cfg.bench.worktreeRoot);
  cfg.bench.reportsDir = resolve(base, cfg.bench.reportsDir);
  return cfg;
}

/**
 * 把模型引用解析成真实 model id。
 * 支持 {file:~/.config/opencode/models/pro} 档位引用。
 */
export function resolveModelRef(spec: string): string {
  const m = spec.match(/^\{file:(.+)\}$/);
  if (!m) return spec;
  const file = expandHome(m[1].trim());
  return readFileSync(file, 'utf8').trim();
}
