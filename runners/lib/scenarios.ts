import type { AssertResult } from './assert-artifacts.ts';
import { startDelivery } from './scenario-delivery.ts';
import { startEvidence } from './scenario-evidence.ts';
import { gradeDelivery, gradeEvidence, isDeliveryPair, isEvidencePair } from './scenario-grading.ts';
import { loadIsolationConfig, type IsolationConfig } from './scenario-isolation-config.ts';
import { DELIVERY_ISOLATION_BLOCKER, isolatedWorkspace, probeIsolatedModel, type IsolationProof } from './scenario-isolation.ts';
import { matchesFrozenBoundary, isRootlessProof } from './scenario-isolation-proof.ts';
import { record } from './scenario-json.ts';
import type { Trace } from './trace.ts';

export interface Scenario {
  readonly promptSuffix: string;
  readonly publicSocket?: string;
  checkpoint(turn: number, trace: Trace | null, proof?: IsolationProof): unknown;
  close(): void;
}

export function startScenario(caseId: string, cwd: string, options?: { formal?: boolean; isolation?: IsolationConfig }): Scenario {
  if (process.getuid?.() === 0 || process.geteuid?.() === 0) {
    throw new Error('Benchmark scenarios must be executed by an unprivileged runner');
  }
  if (caseId === 'l2-07') {
    if (options?.formal && !options.isolation) throw new Error(DELIVERY_ISOLATION_BLOCKER);
    return startDelivery(cwd, options?.isolation !== undefined);
  }
  if (caseId === 'l2-08') return startEvidence(cwd);
  throw new Error(`Unknown benchmark scenario ${caseId}`);
}

export function assertScenario(caseId: string, snapshots: unknown[], _trace: Trace | null): AssertResult {
  let detail: string | null;
  let missingEvidence = false;
  if (caseId === 'l2-07') {
    if (isDeliveryPair(snapshots)) {
      missingEvidence = snapshots.some((snapshot) => snapshot.isolationRequired && !isRootlessProof(snapshot.isolation));
      detail = missingEvidence ? 'missing_evidence: Podman boundary proof was not captured' : gradeDelivery(snapshots);
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

export function verifyScenarioIsolation(
  configPath: string, modelId: string, _executable?: string,
): { config: IsolationConfig; preflight: IsolationProof } {
  const config = loadIsolationConfig(configPath, modelId);
  const workspace = isolatedWorkspace(config);
  try {
    const service = startDelivery(workspace.cwd, true);
    try {
      if (!service.publicSocket) throw new Error(DELIVERY_ISOLATION_BLOCKER);
      const preflight = probeIsolatedModel(config, workspace, service.publicSocket, service.publicUrl);
      return { config, preflight };
    } finally {
      service.close();
    }
  } finally {
    workspace.close();
  }
}

export function scenarioPublicationBlocker(
  caseId: string,
  expected?: IsolationProof,
  snapshots?: readonly unknown[],
  minimumCheckpoints = 2,
): string | null {
  if (caseId !== 'l2-07') return null;
  if (!isRootlessProof(expected) || !snapshots || snapshots.length < minimumCheckpoints || !snapshots.length || snapshots.length > 2) {
    return DELIVERY_ISOLATION_BLOCKER;
  }
  const containers = new Set([expected.containerId]);
  let delivery: string | undefined;
  let workspace: string | undefined;
  for (const [index, snapshot] of snapshots.entries()) {
    if (!record(snapshot) || snapshot.kind !== 'delivery' || snapshot.turn !== index + 1 || snapshot.isolationRequired !== true
      || !isRootlessProof(snapshot.isolation) || !matchesFrozenBoundary(expected, snapshot.isolation)
      || containers.has(snapshot.isolation.containerId)) return DELIVERY_ISOLATION_BLOCKER;
    containers.add(snapshot.isolation.containerId);
    const deliverySource = snapshot.isolation.mounts.find(({ destination }) => destination === '/run/model-bench-delivery.sock')?.source;
    const workspaceSource = snapshot.isolation.mounts.find(({ destination }) => destination === '/work')?.source;
    if (index > 0 && (delivery !== deliverySource || workspace !== workspaceSource)) return DELIVERY_ISOLATION_BLOCKER;
    delivery = deliverySource;
    workspace = workspaceSource;
  }
  return null;
}
