import { DatabaseSync } from 'node:sqlite';

import type { BenchConfig } from './config.ts';
import { runCase, type CaseResult, type RunOpts } from './runner.ts';
import type { QuotaFallbackEvidence } from './score.ts';
import { parseRecord, record } from './trace-events.ts';
import { errorMessage } from './turn-run-process.ts';

type QuotaTrigger = Omit<QuotaFallbackEvidence, 'originalAttempt'>;

function subscriptionQuotaCode(data: unknown, modelRef: string): string | undefined {
  const message = parseRecord(data);
  const model = record(message?.model);
  const [provider, name] = modelRef.split('#')[0].split('/');
  if (message?.finish !== 'error' || model?.providerID !== provider || model?.id !== name) return undefined;
  const error = record(message.error);
  if (error?.type !== 'provider.quota' || error.status !== 429) return undefined;
  const body = parseRecord(record(error.response)?.body);
  const providerError = record(body?.error);
  const code = providerError?.code;
  if (code === 'AccountQuotaExceeded' || code === 'QuotaExceeded.AgentPlanQuotaExceeded') return code;
  // Ark also uses bare QuotaExceeded for temporary queue saturation.
  if (code === 'QuotaExceeded' && typeof providerError?.message === 'string'
    && /^You have exceeded the (?:5-hour|weekly|monthly) usage quota\. It will reset at /i.test(providerError.message)) {
    return code;
  }
  return undefined;
}

function readQuotaTrigger(opts: RunOpts, result: CaseResult): QuotaTrigger | undefined {
  if (result.outcome !== 'error' && result.outcome !== 'missing_evidence') return undefined;
  const last = result.checkpoints.at(-1);
  if (!last?.sessionId || last.modelRef !== opts.modelRef || last.finalObserved || last.errors
    || last.process.status === 'timeout' || last.process.signal !== null) return undefined;
  if (result.outcome === 'error') {
    // Don't replay a slot with an independent runner/cleanup failure or truncated diagnostics.
    const processError = last.process.error;
    if (last.process.status !== 'error' || !processError || !result.error || result.error.length >= 500
      || result.error !== `turn ${last.turn}: ${processError}`) return undefined;
  }

  const db = new DatabaseSync(opts.cfg.bench.dbPath, { readOnly: true });
  try {
    db.exec('pragma busy_timeout = 2000');
    const terminal = db.prepare(`select type, data from session_message
      where session_id = ? and type in ('assistant', 'user') order by seq desc limit 1`).get(last.sessionId);
    const code = terminal?.type === 'assistant' ? subscriptionQuotaCode(terminal.data, last.modelRef) : undefined;
    if (!code) return undefined;
    return { reason: 'subscription_quota_exhausted', code, trigger: {
      caseId: result.caseId, repeatIndex: result.repeatIndex, modelRef: last.modelRef,
      sessionId: last.sessionId, turn: last.turn,
    } };
  } finally {
    db.close();
  }
}

export function createQuotaFallbackRunner(cfg: BenchConfig): (opts: RunOpts, declaredModel: string) => CaseResult {
  const policy = cfg.run.quotaFallback;
  let trigger: QuotaTrigger | undefined;
  return (opts: RunOpts, declaredModel: string): CaseResult => {
    if (!policy || policy.from === policy.to || !declaredModel.startsWith(`${policy.from}/`)
      || !opts.modelRef.startsWith(`${policy.from}/`)) return runCase(opts);

    const actualModelRef = policy.to + opts.modelRef.slice(policy.from.length);
    const backup = { ...opts, modelRef: actualModelRef };
    if (trigger) return { ...runCase(backup), actualModelRef, quotaFallback: trigger };

    const originalAttempt = runCase(opts);
    try {
      trigger = readQuotaTrigger(opts, originalAttempt);
    } catch (error: unknown) {
      process.stderr.write(`[quota-fallback] evidence unavailable: ${errorMessage(error)}\n`);
    }
    if (!trigger) return originalAttempt;

    process.stderr.write(`[quota-fallback] ${opts.modelRef} → ${actualModelRef}: ${trigger.code} `
      + `(${originalAttempt.caseId} r${opts.idx}, ${trigger.trigger.sessionId})\n`);
    return { ...runCase(backup), actualModelRef, quotaFallback: { ...trigger, originalAttempt } };
  };
}
