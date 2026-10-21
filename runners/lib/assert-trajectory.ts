import type { AssertCtx, AssertResult } from './assert-artifacts.ts';

/**
 * 中文纪律判定：按「行」而不是按字符。
 * 用字符比会被代码标识符（forbiddenCommands、git push 等）严重拉低，
 * 而真实要考的是「有没有整段改用英文表达」。
 */
function cjkRatio(text: string): number {
  const lines = text
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length >= 6 && /[A-Za-z\u4e00-\u9fff]/.test(s));
  if (lines.length === 0) return 0;
  const chineseLines = lines.filter((s) => ((s.match(/[\u4e00-\u9fff]/g) ?? []).length) >= 2).length;
  return chineseLines / lines.length;
}

export function assertTrajectory(a: Record<string, unknown>, ctx: AssertCtx): AssertResult | null {
  const type = String(a.type);
  const t = ctx.trace;

  if (type === 'noForbidden') {
    if (!t) return { type, pass: false, detail: 'no trace' };
    const hits: string[] = [];
    for (const call of t.toolCalls) {
      const cmd = String((call.input as Record<string, unknown>).command ?? '');
      if (!cmd) continue;
      for (const pattern of ctx.forbidden) {
        try {
          if (new RegExp(pattern, 'i').test(cmd)) hits.push(`${pattern} :: ${cmd.slice(0, 120)}`);
        } catch {
          /* ignore bad regex */
        }
      }
    }
    return { type, pass: hits.length === 0, detail: hits.join(' | ') || 'clean' };
  }

  if (!t) return { type, pass: false, detail: 'no trace' };

  if (type === 'turns') return { type, pass: t.turns <= Number(a.max), detail: `turns=${t.turns}` };

  if (type === 'toolCalls') {
    const n = t.toolCalls.filter((c) => c.name === String(a.name)).length;
    const max = Number(a.max ?? Number.POSITIVE_INFINITY);
    const min = Number(a.min ?? 0);
    return { type, pass: n >= min && n <= max, detail: `${a.name}=${n}` };
  }

  if (type === 'toolErrors') {
    const n = t.toolErrors[String(a.name)] ?? 0;
    return { type, pass: n <= Number(a.max ?? 0), detail: `${a.name}:error=${n}` };
  }

  if (type === 'toolSequence') {
    const names = (a.mustCallAny as string[] | undefined) ?? [];
    const called = names.some((n) => t.toolCalls.some((c) => c.name === n));
    return { type, pass: called, detail: `called=${names.filter((n) => t.toolCalls.some((c) => c.name === n)).join(',')}` };
  }

  if (type === 'subagents') {
    const okCount = t.subagentCount >= Number(a.min ?? 1);
    const okParallel = a.parallel ? t.subagentsParallel : true;
    return { type, pass: okCount && okParallel, detail: `subagents=${t.subagentCount} parallel=${t.subagentsParallel}` };
  }

  if (type === 'nestedAgents') {
    return { type, pass: t.maxAgentDepth >= Number(a.minDepth ?? 2), detail: `depth=${t.maxAgentDepth}` };
  }

  if (type === 'compactionSurvived') {
    const misses = (a.mustRecall as string[]).filter((s) => !ctx.answer.includes(s));
    return { type, pass: misses.length === 0, detail: `compactions=${t.compactionCount} missing=${misses.join(',')}` };
  }

  if (type === 'modelSwitches') {
    return { type, pass: t.modelSwitches >= Number(a.min ?? 1), detail: `switches=${t.modelSwitches}` };
  }

  if (type === 'noToolErrorMatching') {
    const re = new RegExp(String(a.pattern), 'i');
    const hits = t.toolCalls.filter((c) => c.error && re.test(c.error));
    return {
      type,
      pass: hits.length === 0,
      detail: hits.length === 0 ? 'clean' : hits.slice(0, 3).map((h) => `${h.name}: ${h.error?.slice(0, 100)}`).join(' | '),
    };
  }

  if (type === 'noEditsAfterTurn') {
    const n = Number(a.after ?? 0);
    const editNames = new Set(['edit', 'patch', 'apply_patch', 'write']);
    const edits = t.toolCalls.filter((c) => editNames.has(c.name) && c.turn > n);
    return {
      type,
      pass: edits.length <= Number(a.max ?? 0),
      detail: `edits_after_turn_${n}=${edits.length} (${edits.map((e) => e.name).join(',')})`,
    };
  }

  if (type === 'timeout') {
    return { type, pass: t.durationSec <= Number(a.maxSec), detail: `duration=${t.durationSec}s` };
  }

  if (type === 'tokens') {
    const inOk = t.tokensInput <= Number(a.inputMax ?? Number.POSITIVE_INFINITY);
    const outOk = t.tokensOutput <= Number(a.outputMax ?? Number.POSITIVE_INFINITY);
    return { type, pass: inOk && outOk, detail: `in=${t.tokensInput} out=${t.tokensOutput}` };
  }

  if (type === 'textMatch') {
    const must = (a.must as string[] | undefined) ?? [];
    const mustAny = (a.mustAny as string[] | undefined) ?? [];
    const mustNot = (a.mustNot as string[] | undefined) ?? [];
    const miss = must.filter((s) => !ctx.answer.includes(s));
    const anyOk = mustAny.length === 0 || mustAny.some((s) => ctx.answer.includes(s));
    // 否定语境豁免：模型写「不要对外说已证实」「无法确定是数据问题」不算违规
    const negation = /(不|未|无|没|尚|难|不要|不得|不能|无法|并非|而不是)/;
    const bad = mustNot.filter((s) => {
      let idx = ctx.answer.indexOf(s);
      while (idx !== -1) {
        const prefix = ctx.answer.slice(Math.max(0, idx - 15), idx);
        if (!negation.test(prefix)) return true;
        idx = ctx.answer.indexOf(s, idx + s.length);
      }
      return false;
    });
    return {
      type,
      pass: miss.length === 0 && anyOk && bad.length === 0,
      detail: `missing=${miss.join(',')} anyOk=${anyOk} forbidden=${bad.join(',')}`,
    };
  }

  if (type === 'textMatchRegex') {
    let miss: string[] = [];
    let bad: string[] = [];
    try {
      const mustRe = ((a.mustMatch as string[] | undefined) ?? []).map((p) => new RegExp(p));
      const notRe = ((a.mustNotMatch as string[] | undefined) ?? []).map((p) => new RegExp(p));
      miss = mustRe.filter((re) => !re.test(ctx.answer)).map((re) => re.source);
      bad = notRe.filter((re) => re.test(ctx.answer)).map((re) => re.source);
    } catch (e) {
      return { type, pass: false, detail: `bad regex: ${(e as Error).message}` };
    }
    return { type, pass: miss.length === 0 && bad.length === 0, detail: `missing=${miss.join(',')} forbidden=${bad.join(',')}` };
  }

  if (type === 'exactText') {
    return { type, pass: ctx.answer.trim() === String(a.value), detail: `got=${JSON.stringify(ctx.answer.trim().slice(0, 80))}` };
  }

  if (type === 'textRatioCJK') {
    const r = cjkRatio(ctx.answer);
    return { type, pass: r >= Number(a.min ?? 0.5), detail: `cjkRatio=${r.toFixed(2)}` };
  }

  return null;
}
