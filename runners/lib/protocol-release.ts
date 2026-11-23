import { digestOf, FORMAL_REPEAT, isRepairable, type ProtocolLock } from './protocol.ts';
import { validateResults, type RunResults } from './protocol-results.ts';
import { validateLock } from './protocol-validate.ts';

export const REQUIRED_MODELS = ['openai/gpt-6.1-sol', 'openai/gpt-6-astra', 'openai/gpt-6.2-sol', 'openai/gpt-6.2-astra'] as const;
export const CALIBRATION_GROUPS = ['turns-outcomes', 'text', 'artifacts', 'order', 'parallel', 'l2-08', 'l2-07'] as const;
const MANDATORY_CASES = ['l1-04', 'l1-05', 'l2-07', 'l2-08', 'l3-01', 'l3-02', 'l3-08'] as const;
const HASH = /^[a-f0-9]{64}$/;

export interface CalibrationReceipt {
  readonly contentDigest: string;
  readonly commands: readonly { readonly command: string; readonly exitCode: number; readonly logDigest: string }[];
}

export interface CalibrationReview {
  readonly contentDigest: string;
  readonly reviewer: string;
  readonly groups: Readonly<Record<string, { readonly positive: number; readonly negative: number }>>;
  readonly replayDigest: string;
}

export function contentDigest(lock: ProtocolLock): string {
  const { schema, benchmarkVersion, opencodeVersion, mockRepoCommit, files, suiteDigest, weights, handoff, platform } = lock.manifest;
  return digestOf({ schema, benchmarkVersion, opencodeVersion, mockRepoCommit, files, suiteDigest, weights, handoff, platform });
}

export function calibrationTrialCases(lock: ProtocolLock): string[] {
  return lock.manifest.cases.filter(({ id, calibrationTrial }) => calibrationTrial
    || (MANDATORY_CASES as readonly string[]).includes(id)).map(({ id }) => id);
}

export function verifyCalibrationTrial(formalLock: ProtocolLock, trial: RunResults): void {
  validateLock(formalLock);
  validateResults(trial);
  const trialLock = trial.protocol;
  if (formalLock.manifest.mode !== 'formal' || formalLock.repair || trialLock.manifest.mode !== 'trial'
    || trialLock.manifest.repeat !== FORMAL_REPEAT || trialLock.manifest.concurrency !== formalLock.manifest.concurrency
    || trialLock.repair || contentDigest(formalLock) !== contentDigest(trialLock)) {
    throw new Error('试跑必须基于同一内容锁、每题 3 次、并发 2 且模式为 trial');
  }
  const expected = formalLock.manifest.cases.filter(({ id }) => calibrationTrialCases(formalLock).includes(id));
  if (digestOf(expected) !== digestOf(trialLock.manifest.cases)) throw new Error('试跑未精确覆盖改题集');
  const identities = trialLock.models.map(({ id, model, variant }) => `${id}:${model}#${variant}`);
  if (!REQUIRED_MODELS.every((id) => identities.includes(`${id}:${id}#high`))
    || !trialLock.models.some(({ id, model, variant }) => id === model && !model.startsWith('openai/')
      && /(?:^|[-./])flash(?:$|[-.0-9])/.test(model) && variant === 'high')) {
    throw new Error('试跑缺少两代 Sol/Astra 或非 OpenAI Flash（均需 high）');
  }
  if (trial.results.some(({ outcome }) => isRepairable(outcome))) throw new Error('试跑存在未解决的证据或运行故障');
}

export function verifyReceipts(
  lock: ProtocolLock, calibration: CalibrationReceipt, review: CalibrationReview,
): void {
  validateLock(lock);
  const target = contentDigest(lock);
  if (![calibration, review].every((receipt) => receipt?.contentDigest === target)) throw new Error('验收凭证与冻结内容摘要不符');
  const expectedCommands = ['runners/selftest.ts', 'runners/run-bench.ts --dry-run --mode formal'];
  if (!Array.isArray(calibration.commands) || calibration.commands.length !== expectedCommands.length
    || !expectedCommands.every((command, index) => calibration.commands[index].command === command
      && calibration.commands[index].exitCode === 0 && HASH.test(calibration.commands[index].logDigest))) {
    throw new Error('离线校准未完整通过');
  }
  if (!review.reviewer?.trim() || !HASH.test(review.replayDigest) || !CALIBRATION_GROUPS.every((group) => {
    const counts = review.groups?.[group];
    return counts && Number.isSafeInteger(counts.positive) && counts.positive >= 1
      && Number.isSafeInteger(counts.negative) && counts.negative >= 2;
  })) throw new Error('离线正反例或历史回放复核凭证不足');
}
