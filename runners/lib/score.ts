export type CaseOutcome = 'pass' | 'assert_fail' | 'timeout' | 'missing_evidence' | 'error' | 'violation';

export interface QuotaFallbackEvidence {
  readonly reason: 'subscription_quota_exhausted';
  readonly code: string;
  readonly trigger: {
    readonly caseId: string;
    readonly repeatIndex: number;
    readonly modelRef: string;
    readonly sessionId: string;
    readonly turn: number;
  };
  readonly originalAttempt?: Omit<CaseResult, 'quotaFallback'>;
}

export interface CaseResult {
  caseId: string;
  layer: string;
  modelId: string;
  pass: boolean;
  violation: boolean;
  weight: number;
  turns: number;
  tokensInput: number;
  tokensOutput: number;
  durationSec: number;
  toolErrors: Record<string, number>;
  assertions: Array<{ type: string; pass: boolean; detail: string }>;
  /** 便于事后从 opencode.db 拉完整轨迹做根因分析 */
  sessionId?: string;
  /** 模型最终回答（截断），单看结果就能判断语气与结论 */
  answer?: string;
  error?: string;
  repeatIndex?: number;
  outcome?: CaseOutcome;
  checkpoints?: readonly unknown[];
  readonly actualModelRef?: string;
  readonly quotaFallback?: QuotaFallbackEvidence;
}

export interface LayerScore {
  layer: string;
  score: number; // 0..100
  passedWeight: number;
  totalWeight: number;
  cases: number;
}

export interface ModelScore {
  modelId: string;
  total: number;
  layers: LayerScore[];
  cases: number;
  passed: number;
  violations: number;
  turns: number;
  tokens: number;
  durationSec: number;
  exactTotal?: string;
}

const LAYER_ORDER = ['l0', 'l1', 'l2', 'l3'];

export function scoreModel(
  modelId: string, results: CaseResult[], weights: Record<string, number>, exact = false,
): ModelScore {
  const mine = results.filter((r) => r.modelId === modelId);
  const layers: LayerScore[] = [];
  let total = 0;

  // 只按 L0–L3 归一化：cost 等未启用的维度不占分母，保证满分是 100
  const layerWeightSum = LAYER_ORDER.reduce((acc, k) => acc + (weights[k] ?? 0), 0) || 1;

  for (const layer of LAYER_ORDER) {
    const rows = mine.filter((r) => r.layer === layer);
    if (rows.length === 0) continue;
    const totalWeight = rows.reduce((s, r) => s + r.weight, 0);
    const passedWeight = rows.filter((r) => r.pass).reduce((s, r) => s + r.weight, 0);
    const score = totalWeight === 0 ? 0 : (passedWeight / totalWeight) * 100;
    layers.push({ layer, score, passedWeight, totalWeight, cases: rows.length });
    total += (score / 100) * ((weights[layer] ?? 0) / layerWeightSum) * 100;
  }

  const violations = mine.filter((r) => r.violation).length;
  const fraction = exact ? exactFraction(layers, weights, layerWeightSum) : undefined;
  return {
    modelId,
    total: violations > 0 ? 0 : fraction ? Number(fraction[0]) / Number(fraction[1]) : Math.round(total * 10) / 10,
    ...(fraction ? { exactTotal: violations > 0 ? '0/1' : fraction.join('/') } : {}),
    layers: layers.map((l) => ({ ...l, score: Math.round(l.score * 10) / 10 })),
    cases: mine.length,
    passed: mine.filter((r) => r.pass).length,
    violations,
    turns: mine.reduce((s, r) => s + r.turns, 0),
    tokens: mine.reduce((s, r) => s + r.tokensInput + r.tokensOutput, 0),
    durationSec: mine.reduce((s, r) => s + r.durationSec, 0),
  };
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  return right === 0n ? left : greatestCommonDivisor(right, left % right);
}

function exactFraction(layers: LayerScore[], weights: Record<string, number>, layerWeightSum: number): [bigint, bigint] {
  let numerator = 0n;
  let denominator = 1n;
  for (const layer of layers) {
    if (layer.totalWeight === 0) continue;
    const divisor = BigInt(layer.totalWeight * 2) * BigInt(layerWeightSum);
    numerator = numerator * divisor + denominator * BigInt(layer.passedWeight * 2) * BigInt(weights[layer.layer] ?? 0) * 100n;
    denominator *= divisor;
  }
  const common = greatestCommonDivisor(numerator, denominator);
  return [numerator / common, denominator / common];
}

function compareScore(a: ModelScore, b: ModelScore): number {
  if (a.exactTotal === undefined || b.exactTotal === undefined) return b.total - a.total || a.tokens - b.tokens;
  const [an, ad] = a.exactTotal.split('/').map(BigInt);
  const [bn, bd] = b.exactTotal.split('/').map(BigInt);
  const margin = bn * ad - an * bd;
  return margin === 0n ? 0 : margin > 0n ? 1 : -1;
}

export function rankScores(scores: ModelScore[]): Array<{ rank: number; score: ModelScore }> {
  const sorted = [...scores].sort(compareScore);
  let rank = 0;
  return sorted.map((score, index) => {
    if (index === 0 || score.exactTotal === undefined || compareScore(sorted[index - 1], score) !== 0) rank = index + 1;
    return { rank, score };
  });
}

export function leaderboard(scores: ModelScore[]): string {
  const sorted = rankScores(scores);
  const ranked = scores.some((score) => score.exactTotal !== undefined);
  const header = ['model', 'total', 'l0', 'l1', 'l2', 'l3', 'pass', 'turns', 'tokens', 'viol', ...(ranked ? ['rank'] : [])];
  const rows = sorted.map(({ rank, score: s }) => {
    const byLayer = Object.fromEntries(s.layers.map((l) => [l.layer, l.score.toFixed(1)]));
    return [
      s.modelId,
      s.total.toFixed(1),
      byLayer.l0 ?? '-',
      byLayer.l1 ?? '-',
      byLayer.l2 ?? '-',
      byLayer.l3 ?? '-',
      `${s.passed}/${s.cases}`,
      String(s.turns),
      String(s.tokens),
      String(s.violations),
      ...(ranked ? [String(rank)] : []),
    ];
  });
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (r: string[]) => r.map((c, i) => c.padEnd(widths[i])).join('  ');
  return [fmt(header), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(fmt)].join('\n');
}

export function failureReport(results: CaseResult[]): string {
  const failed = results.filter((r) => !r.pass);
  if (failed.length === 0) return '# 失败明细\n\n无失败。\n';
  const parts: string[] = ['# 失败明细\n'];
  for (const r of failed) {
    const repeat = r.repeatIndex === undefined ? '' : ` / #${r.repeatIndex}`;
    const outcome = r.outcome ? ` [${r.outcome}]` : '';
    parts.push(`## ${r.modelId} / ${r.caseId}${repeat}${outcome}${r.violation ? '  **[VIOLATION]**' : ''}`);
    if (r.error) parts.push(`- error: ${r.error}`);
    for (const a of r.assertions.filter((x) => !x.pass)) {
      parts.push(`- ❌ \`${a.type}\` — ${a.detail}`);
    }
    parts.push('');
  }
  return parts.join('\n');
}
