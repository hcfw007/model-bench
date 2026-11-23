import { join } from 'node:path';

import type { AssertCtx, AssertResult } from './assert-artifacts.ts';
import { assertTrajectory } from './assert-trajectory.ts';
import type { RunOpts } from './runner.ts';
import type { CaseOutcome } from './score.ts';
import type { Trace } from './trace.ts';
import { captureTurn, type CaptureContext } from './turn-run-checkpoint.ts';
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
  const { cfg, caseDef, modelRef } = opts;
  const { cwd, title, scenario } = ctx;
  const { switchModelAfterTurn } = caseDef;
  const replacement = switchModelAfterTurn === undefined ? modelRef : switchModelRef(cfg, modelRef);
  const promptSuffix = scenario?.promptSuffix;
  const firstPrompt = promptSuffix ? `${caseDef.prompt}\n\n${promptSuffix}` : caseDef.prompt;
  const prompts = [firstPrompt, ...(caseDef.followUps ?? [])];
  const timeoutSec = caseDef.timeoutSec ?? cfg.run.timeoutSec;
  let sessionId: string | null = null;

  for (const [index, prompt] of prompts.entries()) {
    const turn = index + 1;
    const turnModel = index > 0 && switchModelAfterTurn !== undefined && index >= switchModelAfterTurn
      ? replacement : modelRef;
    const sessionArgs = sessionId ? ['--session', sessionId] : ['--title', title];
    const process = runTurnProcess(cfg.bench.opencodeBin, cwd, join(scratch, 'stderr'), sessionArgs, turnModel, prompt, timeoutSec);
    const { trace, checkpoint, missingEvidence } = captureTurn({
      ctx, turn, modelRef: turnModel, sessionId, process,
    });
    sessionId = checkpoint.sessionId;
    evidence.trace = trace ?? evidence.trace;
    evidence.checkpoints.push(checkpoint);
    if (process.error) evidence.errors.push(`turn ${turn}: ${process.error}`);
    if (checkpoint.errors) evidence.errors.push(...checkpoint.errors.map((error) => `turn ${turn}: ${error}`));
    if (missingEvidence && process.status === 'exited') evidence.errors.push(missingEvidence);

    if (trace) {
      const guard = assertTrajectory({ type: 'noForbidden' }, assertContext(opts, cwd, startedAt, evidence));
      if (guard) {
        evidence.assertions = [guard];
        if (!guard.pass) evidence.interruption = 'violation';
      }
    }
    if (!evidence.interruption) {
      if (process.status === 'timeout') evidence.interruption = 'timeout';
      else if (process.status === 'error' || checkpoint.errors) evidence.interruption = 'error';
      else if (!sessionId || missingEvidence) evidence.interruption = 'missing_evidence';
    }
    if (evidence.interruption) return;
  }
}
