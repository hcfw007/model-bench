import type { SpawnSyncReturns } from 'node:child_process';
import { readdirSync } from 'node:fs';

import type { ProtocolLock } from './protocol.ts';
import { startDelivery } from './scenario-delivery.ts';
import type { IsolationConfig } from './scenario-isolation-config.ts';
import { isolatedWorkspace, runIsolatedModel, runIsolatedNode, type IsolationProof } from './scenario-isolation.ts';
import { scenarioPublicationBlocker } from './scenarios.ts';
import type { Trace } from './trace.ts';
import type { DeliveryAdapter, DeliveryExecution, DeliveryTurn } from './turn-run-adapter.ts';
import { READ_CONTAINER_TRACE, readContainerTrace } from './turn-run-podman-trace.ts';
import { errorMessage } from './turn-run-process.ts';
import type { TurnProcess } from './turn-run-types.ts';

function processResult(child: SpawnSyncReturns<string>, durationMs: number): TurnProcess {
  const status = child.error?.code === 'ETIMEDOUT' ? 'timeout'
    : child.error || child.status !== 0 ? 'error' : 'exited';
  return {
    status, durationMs, exitCode: child.status, signal: child.signal,
    error: status === 'exited' ? undefined
      : [child.error?.message ?? `Isolated CLI exited (${child.status ?? child.signal})`, child.stderr?.trim().slice(0, 500)]
        .filter(Boolean).join(': '),
  };
}

function openDelivery(config: IsolationConfig, expected: IsolationProof): DeliveryExecution {
  const workspace = isolatedWorkspace(config);
  let service: ReturnType<typeof startDelivery> | undefined;
  function close(): void {
    try {
      service?.close();
    } finally {
      workspace.close();
    }
  }

  try {
    const delivery = startDelivery(workspace.cwd, true);
    service = delivery;
    const socket = delivery.publicSocket;
    if (!socket || readdirSync(workspace.cwd).length > 0) throw new Error('Isolated delivery workspace is not ready');
    const snapshots: unknown[] = [];
    return {
      promptSuffix: delivery.promptSuffix,
      runTurn({ turn, modelRef, title, sessionId, prompt, timeoutSec }): DeliveryTurn {
        const startedAt = Date.now();
        const sessionArgs = sessionId ? ['--session', sessionId] : ['--title', title];
        const { child, proof } = runIsolatedModel(config, workspace, socket,
          ['run', '--auto', '--standalone', ...sessionArgs, '-m', modelRef, prompt], { timeoutMs: timeoutSec * 1000 });
        const process = processResult(child, Date.now() - startedAt);
        let files: string[] = [];
        let artifactError: string | undefined;
        try {
          files = readdirSync(workspace.cwd).sort();
        } catch (error: unknown) {
          artifactError = `isolated workspace snapshot: ${errorMessage(error)}`;
        }
        let trace: Trace | null = null;
        let traceError: string | undefined;
        try {
          const capture = runIsolatedNode(config, workspace, socket,
            ['--input-type=module', '-e', READ_CONTAINER_TRACE, sessionId ?? '', title], { timeoutMs: 5000 }).child;
          if (capture.error || capture.status !== 0) throw new Error('Isolated SQLite collection failed');
          trace = readContainerTrace(capture.stdout);
        } catch (error: unknown) {
          traceError = errorMessage(error);
        }
        let scenario: unknown;
        let evidenceError: string | undefined;
        try {
          scenario = delivery.checkpoint(turn, trace, proof);
          snapshots.push(scenario);
          evidenceError = scenarioPublicationBlocker('l2-07', expected, snapshots, turn) ?? undefined;
        } catch (error: unknown) {
          evidenceError = errorMessage(error);
        }
        return { process, trace, scenario, netDiff: { files, lines: 0 },
          evidenceError: evidenceError ?? artifactError, traceError };
      },
      close,
    };
  } catch (error: unknown) {
    close();
    throw error;
  }
}

export function bindPodmanDelivery(lock: ProtocolLock, config: IsolationConfig): DeliveryAdapter {
  const deployment = lock.manifest.isolation;
  const proof = lock.preflight?.find(({ modelId }) => modelId === config.modelId);
  if (deployment?.backend !== 'rootless-podman-v1' || !proof || proof.backend !== deployment.backend
    || !lock.models.some(({ id }) => id === config.modelId)
    || config.isolationId !== deployment.isolationId || proof.isolationId !== deployment.isolationId
    || config.image !== deployment.image || config.imageId !== deployment.imageId || config.program !== deployment.program
    || config.version !== deployment.programVersion || proof.runtimeVersion !== deployment.podmanVersion) {
    throw new Error('Rootless Podman assignment does not match the frozen worker lock');
  }
  return {
    backend: deployment.backend, isolationId: deployment.isolationId, modelId: config.modelId,
    openDelivery: () => openDelivery(config, proof),
  };
}
