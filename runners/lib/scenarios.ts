import type { AssertResult } from './assert-artifacts.ts';
import { startDelivery } from './scenario-delivery.ts';
import { startEvidence } from './scenario-evidence.ts';
import { gradeDelivery, gradeEvidence, isDeliveryPair, isEvidencePair } from './scenario-grading.ts';
import type { Trace } from './trace.ts';

export interface Scenario {
  readonly promptSuffix: string;
  checkpoint(turn: number, trace: Trace | null): unknown;
  close(): void;
}

export function startScenario(caseId: string, cwd: string): Scenario {
  if (caseId === 'l2-07') return startDelivery(cwd);
  if (caseId === 'l2-08') {
    if (process.getuid?.() === 0 || process.geteuid?.() === 0) {
      throw new Error('Benchmark scenarios must be executed by an unprivileged runner');
    }
    return startEvidence(cwd);
  }
  throw new Error(`Unknown benchmark scenario ${caseId}`);
}

export function assertScenario(caseId: string, snapshots: unknown[], _trace: Trace | null): AssertResult {
  let detail: string | null;
  let missingEvidence = false;
  if (caseId === 'l2-07') {
    if (isDeliveryPair(snapshots)) {
      detail = gradeDelivery(snapshots);
    } else {
      detail = 'missing_evidence: both delivery checkpoints and per-turn answers required';
      missingEvidence = true;
    }
  } else if (caseId === 'l2-08') {
    if (isEvidencePair(snapshots)) {
      detail = gradeEvidence(snapshots);
    } else {
      detail = 'missing_evidence: both evidence checkpoints and per-turn answers required';
      missingEvidence = true;
    }
  } else {
    detail = `unknown benchmark scenario ${caseId}`;
  }
  return {
    type: 'scenario', pass: detail === null, detail: detail ?? 'both scenario checkpoints verified',
    ...(missingEvidence ? { missingEvidence: true } : {}),
  };
}
