import {
  digestOf, expectedSlots, FORMAL_CONCURRENCY, FORMAL_COUNTS, FORMAL_REPEAT, FORMAL_WEIGHTS,
  slotKey, type LayerId, type ProtocolLock,
} from './protocol.ts';
import type { CaseOutcome, CaseResult } from './score.ts';
import { validatePreflight } from './protocol-isolation.ts';

const HASH = /^[a-f0-9]{64}$/;
const MODEL = /^[\w.-]+\/[\w.-]+$/;
const HANDOFF = /^[\w.-]+\/[\w.-]+#[\w.-]+$/;
const outcomes: readonly CaseOutcome[] = ['pass', 'assert_fail', 'timeout', 'missing_evidence', 'error', 'violation'];

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checkHandoff({ primary, fallback }: NonNullable<ProtocolLock['manifest']['handoff']>): void {
  check(HANDOFF.test(primary) && HANDOFF.test(fallback) && primary.split('#')[0] !== fallback.split('#')[0],
    '接棒要求两个不同的完整 provider/model#variant');
}

export function validateFormal(
  manifest: Pick<ProtocolLock['manifest'], 'benchmarkVersion' | 'repeat' | 'concurrency' | 'cases' | 'handoff' | 'weights'>,
  models: ProtocolLock['models'],
): void {
  check(/^1\.1(?:\.0)?$/.test(manifest.benchmarkVersion), '正式运行要求 v1.1 配置');
  check(manifest.repeat === FORMAL_REPEAT && manifest.concurrency === FORMAL_CONCURRENCY, '正式协议要求每题重复 3 次、并发 2');
  check(manifest.cases.length === 33, '正式协议必须包含恰好 33 题');
  for (const [layer, count] of Object.entries(FORMAL_COUNTS)) {
    check(manifest.cases.filter((row) => row.layer === layer).length === count, `${layer} 正式用例数必须为 ${count}`);
    check(manifest.weights[layer] === FORMAL_WEIGHTS[layer as LayerId], `${layer} 正式层权不一致`);
  }
  const l2 = manifest.cases.filter(({ layer }) => layer === 'l2');
  check(l2.reduce((sum, row) => sum + row.weight, 0) === 19, 'L2 正式题权合计必须为 19');
  for (const id of ['l2-07', 'l2-08']) check(l2.some((row) => row.id === id && row.weight === 1), `${id} 正式题权必须为 1`);
  check(manifest.cases.some(({ id }) => id === 'l3-08') && manifest.handoff, '正式协议要求 l3-08 和显式接棒映射');
  checkHandoff(manifest.handoff);
  check([manifest.handoff.primary, manifest.handoff.fallback].every((ref) => ref.endsWith('#high')), '正式接棒档位必须为 high');
  check(models.every(({ id, model, variant }) => MODEL.test(id) && id === model && variant === 'high'),
    '正式模型必须使用官方 provider/model 身份和 high 档位');
}

function validateRepairPlan(lock: ProtocolLock): void {
  const { repair, manifest, models } = lock;
  if (!repair) return;
  check(manifest.mode === 'formal' && HASH.test(repair.baseDigest) && Array.isArray(repair.slots)
    && repair.slots.length > 0, '无效正式补槽计划');
  const seen = new Set<string>();
  const selectedModels = new Set<string>();
  for (const slot of repair.slots) {
    const key = slotKey(slot.modelId, slot);
    check(models.some(({ id }) => id === slot.modelId) && manifest.cases.some(({ id }) => id === slot.caseId)
      && Number.isInteger(slot.repeatIndex) && slot.repeatIndex >= 0 && slot.repeatIndex < manifest.repeat
      && !seen.has(key), `无效或重复补槽: ${key}`);
    seen.add(key);
    selectedModels.add(slot.modelId);
  }
  check(selectedModels.size === models.length, '补槽计划和模型集不一致');
}

export function validateLock(lock: ProtocolLock): void {
  const { manifest, models, digest, runId } = lock;
  check(isRecord(manifest) && manifest.schema === 1 && HASH.test(digest)
    && digestOf(manifest) === digest, '协议清单摘要不一致');
  check(typeof runId === 'string' && runId.length > 0 && ['trial', 'formal'].includes(manifest.mode)
    && typeof manifest.benchmarkVersion === 'string' && typeof manifest.opencodeVersion === 'string'
    && manifest.opencodeVersion.length > 0 && /^[a-f0-9]{40,64}$/.test(manifest.mockRepoCommit)
    && typeof manifest.platform === 'string' && /^[\w-]+\/[\w-]+$/.test(manifest.platform),
  '协议运行身份不完整');
  check(Number.isSafeInteger(manifest.repeat) && manifest.repeat > 0
    && Number.isSafeInteger(manifest.concurrency) && manifest.concurrency > 0, '无效重复次数或并发');
  check(HASH.test(manifest.suiteDigest) && isRecord(manifest.files)
    && Object.values(manifest.files).every((hash) => typeof hash === 'string' && HASH.test(hash))
    && 'bench.config.jsonc' in manifest.files && 'runners/lib/runner.ts' in manifest.files
    && Object.keys(manifest.files).some((path) => path.startsWith('cases/')), '协议输入摘要不完整');
  check(isRecord(manifest.weights) && Object.values(manifest.weights).every((w) => Number.isSafeInteger(w) && Number(w) >= 0),
    '无效层权');
  check(Array.isArray(manifest.cases) && manifest.cases.length > 0, '无协议用例');
  const caseIds = new Set<string>();
  for (const row of manifest.cases) {
    check(typeof row.id === 'string' && row.id.startsWith(`${row.layer}-`) && Object.hasOwn(FORMAL_COUNTS, row.layer)
      && !caseIds.has(row.id) && Number.isSafeInteger(row.weight * 2) && row.weight > 0
      && Number.isFinite(row.timeoutSec) && row.timeoutSec > 0, `无效用例声明: ${row.id}`);
    caseIds.add(row.id);
  }
  check(Array.isArray(models) && models.length > 0 && new Set(models.map(({ id }) => id)).size === models.length
    && models.every(({ id, model, variant }) => MODEL.test(id) && MODEL.test(model)
      && (variant === undefined || (typeof variant === 'string' && /^[\w.-]+$/.test(variant)))), '无效或重复模型身份');
  if (manifest.handoff !== undefined) checkHandoff(manifest.handoff);
  if (manifest.mode === 'formal') {
    validateFormal(manifest, models);
    check(digestOf(manifest.cases) === manifest.suiteDigest, '正式用例集与协议完整用例集不一致');
  }
  validatePreflight(lock);
  validateRepairPlan(lock);
}

export function validateRows(lock: ProtocolLock, rows: CaseResult[], allowMissing = false): void {
  check(Array.isArray(rows), '缺少结果数组');
  const expected = new Set(expectedSlots(lock).map((slot) => slotKey(slot.modelId, slot)));
  const cases = new Map(lock.manifest.cases.map((row) => [row.id, row]));
  for (const row of rows) {
    check(row && row.repeatIndex !== undefined && Number.isSafeInteger(row.repeatIndex), '结果缺少 repeatIndex');
    const key = slotKey(row.modelId, { caseId: row.caseId, repeatIndex: row.repeatIndex });
    check(expected.delete(key), `结果槽位重复或不在协议内: ${key}`);
    const caseDef = cases.get(row.caseId);
    check(caseDef && row.layer === caseDef.layer && row.weight === caseDef.weight, `结果题权或层不一致: ${key}`);
    check(row.outcome && outcomes.includes(row.outcome) && row.pass === (row.outcome === 'pass')
      && row.violation === (row.outcome === 'violation'), `结果分类不一致: ${key}`);
    check([row.turns, row.tokensInput, row.tokensOutput].every((value) => Number.isSafeInteger(value) && value >= 0)
      && Number.isFinite(row.durationSec) && row.durationSec >= 0 && isRecord(row.toolErrors)
      && Array.isArray(row.assertions) && row.assertions.every((assertion) => typeof assertion?.type === 'string'
        && typeof assertion.pass === 'boolean' && typeof assertion.detail === 'string')
      && (row.checkpoints === undefined || Array.isArray(row.checkpoints)), `结果指标无效: ${key}`);
    check((!row.pass || row.assertions.every(({ pass }) => pass))
      && (row.violation || !row.assertions.some(({ type, pass }) => type === 'noForbidden' && !pass)),
    `断言与结果分类不一致: ${key}`);
  }
  check(allowMissing || expected.size === 0, `缺少 ${expected.size} 个协议槽位`);
}
