import type { AssertResult } from './assert-artifacts.ts';
import { conclusion } from './scenario-json.ts';
import type { TurnCheckpoint } from './turn-run-types.ts';

const ACTION_DETAILS = {
  verify_review_revision: /版本|分支|提交|revision|commit|sha/i,
  provide_repro: /复现|步骤|截图|行号|日志|响应|job\s*id|canConfirm/i,
  request_approval: /提交|开分支|部署|重跑|重新评审|复验|commit/i,
} as const;
const REQUEST_DETAIL = /核对|比对|核实|确认|检查|提供|发来|复现|授权|批准|是否|验证|重跑|check|verify|confirm|compare|provide|approve/i;

function validAction(action: unknown): action is keyof typeof ACTION_DETAILS {
  return typeof action === 'string' && Object.hasOwn(ACTION_DETAILS, action);
}

export function assertReviewHandoff(checkpoints: readonly TurnCheckpoint[]): AssertResult {
  const type = 'reviewHandoff';
  const [first, second, third] = checkpoints;
  if (first?.turn !== 1 || second?.turn !== 2 || third?.turn !== 3
    || !second.netTrees || !third.netTrees || !third.finalObserved) {
    return { type, pass: false, detail: 'missing review checkpoints or final answer', missingEvidence: true };
  }
  if (second.netTrees.end !== third.netTrees.end) {
    return { type, pass: false, detail: 'worktree changed after the second review' };
  }
  const handoff = conclusion(third.answer)?.value;
  if (!handoff || Object.keys(handoff).length !== 2 || !validAction(handoff.action)
    || typeof handoff.detail !== 'string' || !REQUEST_DETAIL.test(handoff.detail)
    || !ACTION_DETAILS[handoff.action].test(handoff.detail)) {
    return { type, pass: false, detail: 'expected one actionable review handoff' };
  }
  return { type, pass: true, detail: `worktree unchanged; handoff action=${handoff.action}` };
}
