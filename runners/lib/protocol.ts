import { createHash } from 'node:crypto';

import type { CaseOutcome, CaseResult } from './score.ts';

export const PROTOCOL_SCHEMA = 2;

export type BenchMode = 'trial' | 'formal';
export type LayerId = 'l0' | 'l1' | 'l2' | 'l3';

export interface ProtocolCase {
  readonly id: string;
  readonly layer: string;
  readonly weight: number;
  readonly timeoutSec: number;
  readonly calibrationTrial?: boolean;
}

export interface Slot {
  readonly caseId: string;
  readonly repeatIndex: number;
}

export interface ModelIdentity {
  readonly id: string;
  readonly model: string;
  readonly variant?: string;
}

export interface ProtocolManifest {
  readonly schema: typeof PROTOCOL_SCHEMA;
  readonly benchmarkVersion: string;
  readonly mode: BenchMode;
  readonly concurrency: number;
  readonly repeat: number;
  readonly opencodeVersion: string;
  readonly mockRepoCommit: string;
  readonly platform: string;
  readonly files: Readonly<Record<string, string>>;
  readonly suiteDigest: string;
  readonly weights: Readonly<Record<string, number>>;
  readonly cases: readonly ProtocolCase[];
  readonly handoff?: { readonly primary: string; readonly fallback: string };
}

export interface RepairPlan {
  readonly baseDigest: string;
  readonly slots: readonly (Slot & { readonly modelId: string })[];
}

export interface ProtocolLock {
  readonly manifest: ProtocolManifest;
  readonly digest: string;
  readonly models: readonly ModelIdentity[];
  readonly runId: string;
  readonly repair?: RepairPlan;
}

export interface SlotAttempt {
  readonly runId: string;
  readonly sourceDigest: string;
  readonly baseDigest: string;
  readonly worker: {
    readonly status: 'complete' | 'incomplete';
    readonly exitCode?: number | null;
    readonly signal?: NodeJS.Signals | null;
    readonly reason?: string;
  };
  readonly previous: CaseResult;
  readonly replacement: CaseResult;
}

export const FORMAL_WEIGHTS = { l0: 10, l1: 20, l2: 40, l3: 25 } as const;
export const FORMAL_COUNTS = { l0: 7, l1: 10, l2: 8, l3: 8 } as const;
export const FORMAL_REPEAT = 3;
export const FORMAL_CONCURRENCY = 2;
export const CALIBRATION_TYPES = new Set(['autoTagConclusion', 'diffFiles', 'diffLines', 'diffAddedText', 'toolOrder',
  'subagents', 'nestedAgents', 'noEditsAfterTurn', 'modelSwitches', 'scenario']);

export function sha256(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function canonicalize(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(canonicalize);
  if (input === null || typeof input !== 'object') return input;
  return Object.fromEntries(Object.entries(input)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => [key, canonicalize(value)]));
}

export function digestOf(value: unknown): string {
  return sha256(JSON.stringify(canonicalize(value)));
}

export function slotKey(modelId: string, slot: Slot): string {
  return JSON.stringify([modelId, slot.caseId, slot.repeatIndex]);
}

export function isRepairable(outcome: CaseOutcome | undefined): boolean {
  return outcome === 'error' || outcome === 'missing_evidence';
}

export function expectedSlots(lock: ProtocolLock): readonly (Slot & { readonly modelId: string })[] {
  return lock.repair?.slots ?? lock.models.flatMap(({ id: modelId }) =>
    Array.from({ length: lock.manifest.repeat }, (_, repeatIndex) => lock.manifest.cases.map(({ id: caseId }) =>
      ({ modelId, repeatIndex, caseId }))).flat());
}
