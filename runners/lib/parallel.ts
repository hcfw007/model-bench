/**
 * 并行跑分只涉及「调度与合并」，判分本身必须与串行完全一致。
 * 这里只放纯函数：校验每个模型的产物完整、按固定顺序合并。
 */
import type { CaseResult } from './score.ts';

export interface RunMeta {
  mode: 'serial' | 'parallel';
  concurrency: number;
  mockRepoCommit?: string;
  startedAt: string;
  finishedAt?: string;
  wallSec?: number;
  workers: Array<{
    modelId: string;
    status: 'complete' | 'incomplete';
    reason?: string;
    durationSec?: number;
  }>;
}

export type PartitionCheck = { ok: true } | { ok: false; error: string };

/**
 * 单个模型必须恰好产出 `caseIds × repeat` 条结果，且模型、用例都对得上。
 * 缺一条就判该模型不完整：计分按已有用例归一化，缺用例会虚高。
 */
export function checkPartition(
  modelId: string,
  results: CaseResult[],
  caseIds: string[],
  repeat: number,
): PartitionCheck {
  const expected = new Map<string, number>();
  for (const caseId of caseIds) {
    if (expected.has(caseId)) return { ok: false, error: `用例重复: ${caseId}` };
    expected.set(caseId, repeat);
  }
  const seen = new Map<string, number>();
  for (const r of results) {
    if (r.modelId !== modelId) return { ok: false, error: `结果含其他模型: ${r.modelId}` };
    if (!expected.has(r.caseId)) return { ok: false, error: `结果含未执行用例: ${r.caseId}` };
    const n = (seen.get(r.caseId) ?? 0) + 1;
    if (n > repeat) return { ok: false, error: `用例结果重复: ${r.caseId}` };
    seen.set(r.caseId, n);
  }
  const missing = [...expected].filter(([id, n]) => (seen.get(id) ?? 0) !== n).map(([id]) => id);
  if (missing.length > 0) return { ok: false, error: `缺少结果: ${missing.join(',')}` };
  return { ok: true };
}

/**
 * 按「模型顺序 → 重复轮次 → 用例顺序」重排，与串行 runner 写出的顺序一致。
 * 行内容原样保留，不做任何改写或补齐。
 */
export function orderResults(
  modelOrder: string[],
  caseIds: string[],
  repeat: number,
  parts: Map<string, CaseResult[]>,
): CaseResult[] {
  const out: CaseResult[] = [];
  for (const modelId of modelOrder) {
    const queues = new Map<string, CaseResult[]>();
    for (const r of parts.get(modelId) ?? []) {
      const queue = queues.get(r.caseId) ?? [];
      queue.push(r);
      queues.set(r.caseId, queue);
    }
    for (let i = 0; i < repeat; i++) {
      for (const caseId of caseIds) {
        const row = queues.get(caseId)?.[i];
        if (row) out.push(row);
      }
    }
  }
  return out;
}

/** 分数只应覆盖完整模型，缺用例的模型单独列出，不进排行。 */
export function incompleteReasons(
  modelOrder: string[],
  parts: Map<string, unknown[]>,
  incomplete: Map<string, string>,
): Array<{ modelId: string; reason: string }> {
  return modelOrder
    .filter((modelId) => incomplete.has(modelId) || !parts.has(modelId))
    .map((modelId) => ({ modelId, reason: incomplete.get(modelId) ?? '无结果' }));
}
