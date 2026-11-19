import type { NetDiff, NetTrees } from './net-diff.ts';
import type { RunOpts } from './runner.ts';
import type { Trace } from './trace.ts';
import { missingTurnEvidence } from './turn-run-checkpoint.ts';
import { runTurnSequence, type RunEvidence } from './turn-run-loop.ts';
import type { TurnProcess } from './turn-run-types.ts';

export interface DeliveryTurn {
  readonly process: TurnProcess;
  readonly trace: Trace | null;
  readonly scenario: unknown;
  readonly netDiff: NetDiff;
  readonly netTrees?: NetTrees;
  readonly evidenceError?: string;
  readonly traceError?: string;
}

export interface DeliveryExecution {
  readonly promptSuffix: string;
  runTurn(opts: {
    readonly turn: number;
    readonly modelRef: string;
    readonly title: string;
    readonly sessionId: string | null;
    readonly prompt: string;
    readonly timeoutSec: number;
  }): DeliveryTurn;
  close(): void;
}

export interface DeliveryAdapter {
  readonly backend: string;
  readonly isolationId: string;
  readonly modelId: string;
  openDelivery(): DeliveryExecution;
}

export function runDeliveryTurns(
  opts: RunOpts, delivery: DeliveryExecution, title: string, startedAt: number, evidence: RunEvidence,
): void {
  runTurnSequence(opts, '', delivery.promptSuffix, startedAt, evidence, (input) => {
    const result = delivery.runTurn({ ...input, turn: input.index, title });
    const { trace, process, scenario, netDiff, netTrees, evidenceError, traceError } = result;
    const observedSessionId = trace?.sessionId ?? null;
    const sessionId = input.sessionId ?? observedSessionId;
    const missingEvidence = evidenceError ?? traceError
      ?? (observedSessionId && !/^ses_[\w-]{1,128}$/.test(observedSessionId) ? 'invalid isolated root session ID' : undefined)
      ?? (observedSessionId && observedSessionId !== sessionId ? 'isolated trace changed root session' : undefined)
      ?? missingTurnEvidence(trace, input.index);
    return {
      trace, missingEvidence, missingIsolationEvidence: evidenceError ?? (scenario == null ? 'missing isolated delivery checkpoint' : undefined),
      checkpoint: {
        turn: input.index, modelRef: input.modelRef, sessionId, process, scenario, netDiff, netTrees,
        answer: trace?.answersByTurn?.[input.index - 1] ?? '',
        finalObserved: trace?.finalObservedByTurn?.[input.index - 1] === true,
        toolCalls: trace?.toolCalls ?? [],
        errors: traceError ? [traceError] : undefined,
      },
    };
  });
}
