import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { sha256, type ProtocolLock } from './protocol.ts';
import { verifyCalibrationTrial, verifyReceipts, type CalibrationReceipt, type CalibrationReview } from './protocol-release.ts';
import { readRunResults } from './report.ts';

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function verifiedLogDigest(path: string): string {
  const content = readFileSync(path);
  if (!content.toString('utf8').trim()) throw new Error(`验收日志为空: ${path}`);
  return sha256(content);
}

export function verifyReleaseEvidence(lock: ProtocolLock, directory: string): void {
  const calibration = readJson<CalibrationReceipt>(resolve(directory, 'calibration.json'));
  const review = readJson<CalibrationReview>(resolve(directory, 'review.json'));
  verifyReceipts(lock, calibration, review);
  for (const [index, { logDigest }] of calibration.commands.entries()) {
    if (logDigest !== verifiedLogDigest(resolve(directory, `calibration-${index}.log`))) throw new Error('离线校准日志摘要不匹配');
  }
  if (review.replayDigest !== verifiedLogDigest(resolve(directory, 'replay.md'))) throw new Error('人工验收原件摘要不匹配');
  verifyCalibrationTrial(lock, readRunResults(resolve(directory, 'trial')));
}
