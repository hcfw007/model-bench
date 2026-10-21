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
  error?: string;
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
}

const LAYER_ORDER = ['l0', 'l1', 'l2', 'l3'];

export function scoreModel(modelId: string, results: CaseResult[], weights: Record<string, number>): ModelScore {
  const mine = results.filter((r) => r.modelId === modelId);
  const layers: LayerScore[] = [];
  let total = 0;

  for (const layer of LAYER_ORDER) {
    const rows = mine.filter((r) => r.layer === layer);
    if (rows.length === 0) continue;
    const totalWeight = rows.reduce((s, r) => s + r.weight, 0);
    const passedWeight = rows.filter((r) => r.pass).reduce((s, r) => s + r.weight, 0);
    const score = totalWeight === 0 ? 0 : (passedWeight / totalWeight) * 100;
    layers.push({ layer, score, passedWeight, totalWeight, cases: rows.length });
    total += (score / 100) * (weights[layer] ?? 0);
  }

  const violations = mine.filter((r) => r.violation).length;
  return {
    modelId,
    total: violations > 0 ? 0 : Math.round(total * 10) / 10,
    layers: layers.map((l) => ({ ...l, score: Math.round(l.score * 10) / 10 })),
    cases: mine.length,
    passed: mine.filter((r) => r.pass).length,
    violations,
    turns: mine.reduce((s, r) => s + r.turns, 0),
    tokens: mine.reduce((s, r) => s + r.tokensInput + r.tokensOutput, 0),
    durationSec: mine.reduce((s, r) => s + r.durationSec, 0),
  };
}

export function leaderboard(scores: ModelScore[]): string {
  const sorted = [...scores].sort((a, b) => b.total - a.total || a.tokens - b.tokens);
  const header = ['model', 'total', 'l0', 'l1', 'l2', 'l3', 'pass', 'turns', 'tokens', 'viol'];
  const rows = sorted.map((s) => {
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
    parts.push(`## ${r.modelId} / ${r.caseId}${r.violation ? '  **[VIOLATION]**' : ''}`);
    if (r.error) parts.push(`- error: ${r.error}`);
    for (const a of r.assertions.filter((x) => !x.pass)) {
      parts.push(`- ❌ \`${a.type}\` — ${a.detail}`);
    }
    parts.push('');
  }
  return parts.join('\n');
}
