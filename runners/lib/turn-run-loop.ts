import { join } from 'node:path';

import type { AssertCtx, AssertResult } from './assert-artifacts.ts';
import { assertTrajectory } from './assert-trajectory.ts';
import type { RunOpts } from './runner.ts';
import type { CaseOutcome } from './score.ts';
import type { Trace } from './trace.ts';
import { captureTurn, type CapturedTurn, type CaptureContext } from './turn-run-checkpoint.ts';
import { runTurnProcess, switchModelRef } from './turn-run-process.ts';
import type { TurnCheckpoint } from './turn-run-types.ts';

export interface RunEvidence {
  trace: Trace | null;
  checkpoints: TurnCheckpoint[];
  errors: string[];
  assertions: AssertResult[];
  interruption?: Exclude<CaseOutcome, 'pass' | 'assert_fail'>;
}

export function assertContext(opts: RunOpts, cwd: string, startedAt: number, evidence: RunEvidence): AssertCtx {
  const last = evidence.checkpoints.at(-1);
  return {
    worktree: cwd, startedAt, trace: evidence.trace, answer: last?.answer ?? '',
    forbidden: opts.cfg.safety.forbiddenCommands, netDiff: last?.netDiff, netTrees: last?.netTrees,
  };
}

export function runTurns(
  opts: RunOpts, ctx: CaptureContext, scratch: string, startedAt: number, evidence: RunEvidence,
): void {
  runTurnSequence(opts, ctx.cwd, ctx.scenario?.promptSuffix, startedAt, evidence, (turn) => {
    const sessionArgs = turn.sessionId ? ['--session', turn.sessionId] : ['--title', ctx.title];
    const process = runTurnProcess(
      opts.cfg.bench.opencodeBin, ctx.cwd, join(scratch, 'stderr'), sessionArgs, turn.modelRef, turn.prompt, turn.timeoutSec,
    );
    return captureTurn({ ctx, turn: turn.index, modelRef: turn.modelRef, sessionId: turn.sessionId, process });
  });
}

interface TurnInput {
  readonly index: number;
  readonly modelRef: string;
  readonly sessionId: string | null;
  readonly prompt: string;
  readonly timeoutSec: number;
}

export function runTurnSequence(
  opts: RunOpts, cwd: string, promptSuffix: string | undefined, startedAt: number, evidence: RunEvidence,
  observe: (turn: TurnInput) => CapturedTurn,
): void {
  const { cfg, caseDef, modelRef } = opts;
  const { switchModelAfterTurn } = caseDef;
  const replacement = switchModelAfterTurn === undefined ? modelRef : switchModelRef(cfg, modelRef);
  const firstPrompt = promptSuffix ? `${caseDef.prompt}\n\n${promptSuffix}` : caseDef.prompt;
  const prompts = [firstPrompt, ...(caseDef.followUps ?? [])];
  const timeoutSec = caseDef.timeoutSec ?? cfg.run.timeoutSec;
  let sessionId: string | null = null;

  for (const [index, prompt] of prompts.entries()) {
    const turn = index + 1;
    const turnModel = index > 0 && switchModelAfterTurn !== undefined && index >= switchModelAfterTurn
      ? replacement : modelRef;
    const { trace, checkpoint, missingEvidence, missingIsolationEvidence } = observe({
      index: turn, modelRef: turnModel, sessionId, prompt, timeoutSec,
    });
    const { process } = checkpoint;
    sessionId = checkpoint.sessionId;
    evidence.trace = trace ?? evidence.trace;
    evidence.checkpoints.push(checkpoint);
    if (process.error) evidence.errors.push(`turn ${turn}: ${process.error}`);
    if (checkpoint.errors) evidence.errors.push(...checkpoint.errors.map((error) => `turn ${turn}: ${error}`));
    if (missingIsolationEvidence) evidence.errors.push(missingIsolationEvidence);
    else if (missingEvidence && process.status === 'exited') evidence.errors.push(missingEvidence);

    if (trace) {
      const guard = assertTrajectory({ type: 'noForbidden' }, assertContext(opts, cwd, startedAt, evidence));
      if (guard) {
        evidence.assertions = [guard];
        if (!guard.pass) evidence.interruption = 'violation';
      }
    }
    if (!evidence.interruption) {
      if (missingIsolationEvidence) evidence.interruption = 'missing_evidence';
      else if (process.status === 'timeout') evidence.interruption = 'timeout';
      else if (process.status === 'error' || checkpoint.errors) evidence.interruption = 'error';
      else if (!sessionId || missingEvidence) evidence.interruption = 'missing_evidence';
    }
    if (evidence.interruption) return;
  }
}
