import type { DatabaseSync } from 'node:sqlite';

import { netDiff, snapshotTree } from './net-diff.ts';
import type { startScenario } from './scenarios.ts';
import { collectTrace, type Trace } from './trace.ts';
import { hiddenTestsIntact, type HiddenTest } from './turn-run-fixtures.ts';
import { errorMessage, findSessionByTitle } from './turn-run-process.ts';
import type { TurnCheckpoint, TurnProcess } from './turn-run-types.ts';

export interface CaptureContext {
  readonly cwd: string;
  readonly hidden: readonly HiddenTest[];
  readonly excludes: string[];
  readonly title: string;
  readonly scenario?: ReturnType<typeof startScenario>;
  readonly db: DatabaseSync;
  readonly baseline: string;
}

interface CaptureOptions {
  readonly ctx: CaptureContext;
  readonly turn: number;
  readonly modelRef: string;
  readonly sessionId: string | null;
  readonly process: TurnProcess;
}

interface CapturedTurn {
  readonly checkpoint: TurnCheckpoint;
  readonly trace: Trace | null;
  readonly missingEvidence?: string;
}

function missingTurnEvidence(trace: Trace | null, turn: number): string | undefined {
  return !trace || trace.turns < turn ? `missing root session or user turn ${turn}`
    : trace.incompleteSessions?.length ? `incomplete trace for sessions: ${trace.incompleteSessions.join(', ')}`
    : trace.finalObservedByTurn?.[turn - 1] !== true ? `missing terminal assistant event in turn ${turn}` : undefined;
}

export function captureTurn(opts: CaptureOptions): CapturedTurn {
  const { ctx, turn, modelRef, process } = opts;
  const errors: string[] = [];
  function attempt<T>(stage: string, capture: () => T): T | undefined {
    try {
      return capture();
    } catch (error: unknown) {
      errors.push(`${stage}: ${errorMessage(error)}`);
      return undefined;
    }
  }

  const observation = attempt('trace collection', () => {
    const sessionId = opts.sessionId ?? findSessionByTitle(ctx.db, ctx.title);
    return { sessionId, trace: collectTrace(ctx.db, sessionId) };
  });
  const sessionId = observation?.sessionId ?? opts.sessionId;
  const trace = observation?.trace ?? null;
  const finalObserved = trace?.finalObservedByTurn?.[turn - 1] === true;
  const answer = trace?.answersByTurn?.[turn - 1] ?? '';
  const missingEvidence = missingTurnEvidence(trace, turn);
  const integrity = ctx.hidden.length > 0
    ? attempt('hidden-test integrity', () => hiddenTestsIntact(ctx.cwd, ctx.hidden)) : undefined;
  const artifacts = attempt('snapshot', () => {
    const netTrees = { base: ctx.baseline, end: snapshotTree(ctx.cwd, ctx.excludes) };
    return { netTrees, netDiff: netDiff(ctx.cwd, netTrees.base, netTrees.end) };
  });
  const scenario = ctx.scenario;
  const scenarioSnapshot = scenario
    ? attempt('scenario checkpoint', () => scenario.checkpoint(turn, trace)) : undefined;
  return {
    trace, missingEvidence, checkpoint: {
      turn, modelRef, sessionId, process, answer, finalObserved, toolCalls: trace?.toolCalls ?? [],
      ...artifacts, scenario: scenarioSnapshot, hiddenTestsIntact: integrity, errors: errors.length ? errors : undefined,
    },
  };
}
