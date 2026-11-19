import type { NetDiff, NetTrees } from './net-diff.ts';
import type { AssertResult } from './assert-artifacts.ts';
import type { ToolCall } from './trace.ts';
import type { CaseOutcome, CaseResult as ScoreCaseResult } from './score.ts';

export interface TurnProcess {
  readonly status: 'exited' | 'timeout' | 'error';
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly durationMs: number;
  readonly error?: string;
}

export interface TurnCheckpoint {
  readonly turn: number;
  readonly modelRef: string;
  readonly sessionId: string | null;
  readonly process: TurnProcess;
  readonly answer: string;
  readonly finalObserved: boolean;
  /** Cumulative observations preserve late updates and subagent events across turns. */
  readonly toolCalls: readonly ToolCall[];
  readonly netDiff?: NetDiff;
  readonly netTrees?: NetTrees;
  readonly scenario?: unknown;
  readonly hiddenTestsIntact?: boolean;
  readonly errors?: readonly string[];
}

export interface CaseResult extends ScoreCaseResult {
  assertions: AssertResult[];
  outcome: CaseOutcome;
  repeatIndex: number;
  checkpoints: TurnCheckpoint[];
}
