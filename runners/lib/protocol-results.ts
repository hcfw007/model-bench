import type { BenchConfig } from './config.ts';
import type { RunMeta } from './parallel.ts';
import { digestOf, isRepairable, slotKey, type ProtocolLock, type RepairPlan, type SlotAttempt } from './protocol.ts';
import { validateLock, validateRows } from './protocol-validate.ts';
import { scoreModel, type CaseResult, type ModelScore } from './score.ts';

export interface RunResults {
  config: BenchConfig;
  results: CaseResult[];
  meta: RunMeta;
  protocol: ProtocolLock;
  repairs?: SlotAttempt[];
}

function rowKey(row: CaseResult): string {
  if (row.repeatIndex === undefined) throw new Error('无结果槽位编号');
  return slotKey(row.modelId, { caseId: row.caseId, repeatIndex: row.repeatIndex });
}

function resultsDigest(data: RunResults): string {
  const { config, results, meta, protocol, repairs } = data;
  return digestOf({ config, results, meta, protocol, repairs: repairs?.length ? repairs : undefined });
}

function verifyAttemptHistory(data: RunResults): void {
  const { repairs, protocol, results } = data;
  if (repairs === undefined) return;
  if (!Array.isArray(repairs) || protocol.repair) throw new Error('补槽历史结构无效');
  const current = new Map(results.map((row) => [rowKey(row), row]));
  const seenRuns = new Set<string>();
  const hashes = /^[a-f0-9]{64}$/;
  let index = repairs.length;
  while (index > 0) {
    const group = repairs[index - 1];
    if (!group.runId || group.runId === protocol.runId || seenRuns.has(group.runId)
      || !hashes.test(group.sourceDigest) || !hashes.test(group.baseDigest)) throw new Error('无效补槽来源');
    const seenSlots = new Set<string>();
    while (index > 0 && repairs[index - 1].runId === group.runId) {
      const attempt = repairs[--index];
      const key = rowKey(attempt.previous);
      if (seenSlots.has(key) || attempt.sourceDigest !== group.sourceDigest || attempt.baseDigest !== group.baseDigest
        || !['complete', 'incomplete'].includes(attempt.worker?.status)
        || key !== rowKey(attempt.replacement) || !isRepairable(attempt.previous.outcome)
        || digestOf(attempt.replacement) !== digestOf(current.get(key) ?? null)) throw new Error(`补槽历史不连贯: ${key}`);
      seenSlots.add(key);
      current.set(key, attempt.previous);
    }
    seenRuns.add(group.runId);
    const previous = { ...data, results: [...current.values()], repairs: index > 0 ? repairs.slice(0, index) : undefined };
    if (group.baseDigest !== resultsDigest(previous)) throw new Error('补槽前基线摘要不一致');
    validateRows(protocol, previous.results);
  }
}

export function validateResults(data: RunResults): void {
  validateLock(data.protocol);
  const { config, meta, protocol } = data;
  const { manifest, models } = protocol;
  if (config.bench.version !== manifest.benchmarkVersion || digestOf(config.weights) !== digestOf(manifest.weights)
    || meta.concurrency !== manifest.concurrency || meta.mockRepoCommit !== manifest.mockRepoCommit
    || meta.mode !== (manifest.concurrency === 1 ? 'serial' : 'parallel')
    || meta.workers.length !== models.length
    || models.some(({ id }) => meta.workers.filter(({ modelId, status }) => modelId === id
      && (status === 'complete' || status === 'incomplete')).length !== 1)) throw new Error('运行记录与协议清单不一致');
  if (manifest.handoff && (config.run?.switchModel !== manifest.handoff.primary
    || config.run?.switchFallback !== manifest.handoff.fallback)) throw new Error('运行接棒配置与锁定映射不一致');
  validateRows(protocol, data.results);
  verifyAttemptHistory(data);
}

export function makeRepairPlan(data: RunResults): RepairPlan {
  validateResults(data);
  if (data.protocol.manifest.mode !== 'formal' || data.protocol.repair) throw new Error('补槽只接受正式主运行');
  const slots = data.results.filter(({ outcome }) => isRepairable(outcome)).map(({ modelId, caseId, repeatIndex }) =>
    ({ modelId, caseId, repeatIndex: repeatIndex! }));
  if (slots.length === 0) throw new Error('没有可补跑的故障槽位');
  return { baseDigest: resultsDigest(data), slots };
}

export function mergeRepair(base: RunResults, overlay: RunResults): RunResults {
  const plan = makeRepairPlan(base);
  validateResults(overlay);
  if (!overlay.protocol.repair || base.protocol.digest !== overlay.protocol.digest
    || plan.baseDigest !== overlay.protocol.repair.baseDigest || overlay.protocol.runId === base.protocol.runId) {
    throw new Error('补槽产物不是此基线的同协议运行');
  }
  const expectedModels = base.protocol.models.filter(({ id }) => overlay.protocol.models.some((model) => model.id === id));
  if (digestOf(expectedModels) !== digestOf(overlay.protocol.models)) throw new Error('补槽模型身份或档位变化');
  const eligible = new Set(plan.slots.map((slot) => slotKey(slot.modelId, slot)));
  const previous = new Map(base.results.map((row) => [rowKey(row), row]));
  const sourceDigest = resultsDigest(overlay);
  const repairs = overlay.results.map((replacement): SlotAttempt => {
    const key = rowKey(replacement);
    if (!eligible.has(key)) throw new Error(`不能覆盖已判定槽位: ${key}`);
    const worker = overlay.meta.workers.find(({ modelId }) => modelId === replacement.modelId)!;
    return { runId: overlay.protocol.runId, sourceDigest, baseDigest: plan.baseDigest, worker,
      previous: previous.get(key)!, replacement };
  });
  const replacements = new Map(repairs.map(({ replacement }) => [rowKey(replacement), replacement]));
  const merged = { ...base, results: base.results.map((row) => replacements.get(rowKey(row)) ?? row),
    repairs: [...(base.repairs ?? []), ...repairs] };
  validateResults(merged);
  return merged;
}

export function scoresForRun(data: RunResults): { scores: ModelScore[]; excluded: Array<{ modelId: string; reason: string }> } {
  validateResults(data);
  const { protocol, results } = data;
  const scores: ModelScore[] = [];
  const excluded: Array<{ modelId: string; reason: string }> = [];
  for (const { id: modelId } of protocol.models) {
    const rows = results.filter((row) => row.modelId === modelId);
    const unresolved = rows.filter(({ outcome }) => isRepairable(outcome)).length;
    const reason = rows.some(({ outcome }) => outcome === 'violation') ? '确认全局违规，失格'
      : unresolved > 0 ? `${unresolved} 个故障槽位待补`
      : protocol.repair ? '补槽运行不单独计分' : undefined;
    if (reason) excluded.push({ modelId, reason });
    else scores.push(scoreModel(modelId, rows, { ...protocol.manifest.weights }, true));
  }
  return { scores, excluded };
}

export function publicationScores(data: RunResults): ModelScore[] {
  const { scores } = scoresForRun(data);
  if (data.protocol.manifest.mode !== 'formal' || data.protocol.repair) throw new Error('只发布正式主运行');
  if (data.results.some(({ outcome }) => isRepairable(outcome))) {
    throw new Error('仍有未解决故障或不完整结果，拒绝发布');
  }
  if (scores.length === 0) throw new Error('没有合格模型，拒绝发布');
  return scores;
}
