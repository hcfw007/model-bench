import { spawn } from 'node:child_process';
import { mkdtempSync, readSync, realpathSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import type { DeliveryCut } from './scenario-delivery-service.ts';
import type { IsolationProof } from './scenario-isolation.ts';
import { record } from './scenario-json.ts';
import type { Trace } from './trace.ts';

interface Control {
  read(): unknown;
  send(command: string): void;
  close(): void;
}

export interface DeliverySnapshot {
  readonly kind: 'delivery';
  readonly turn: number;
  readonly answer: string | null;
  readonly cut: DeliveryCut;
  readonly isolationRequired: boolean;
  readonly isolation: 'unverified' | IsolationProof;
}

function pipeDescriptor(stream: unknown): number {
  if (record(stream) && record(stream._handle) && typeof stream._handle.fd === 'number' && stream._handle.fd >= 0) {
    return stream._handle.fd;
  }
  throw new Error('Node did not supply a control pipe descriptor for the synchronous runner');
}

function control(cwd: string, socket?: string): Control {
  const path = fileURLToPath(new URL('./scenario-delivery-service.ts', import.meta.url));
  const child = spawn(process.execPath, socket ? [path, socket] : [path], { cwd, env: {}, stdio: ['pipe', 'pipe', 'inherit'] });
  child.on('error', (error: Error): void => {
    process.stderr.write(`delivery service: ${error.message}\n`);
  });
  const close = (): void => {
    child.stdin.destroy();
    child.stdout.destroy();
    child.kill();
  };
  try {
    const input = pipeDescriptor(child.stdin);
    const output = pipeDescriptor(child.stdout);
    const chunk = Buffer.alloc(4096);
    const wait = new Int32Array(new SharedArrayBuffer(4));
    let queued = '';
    function read(): unknown {
      const deadline = performance.now() + 5000;
      while (performance.now() < deadline) {
        const newline = queued.indexOf('\n');
        if (newline !== -1) {
          const message: unknown = JSON.parse(queued.slice(0, newline));
          queued = queued.slice(newline + 1);
          return message;
        }
        try {
          const bytes = readSync(output, chunk);
          if (bytes === 0) throw new Error('Delivery service closed its control pipe');
          queued += chunk.toString('utf8', 0, bytes);
          if (queued.length > 16384) throw new Error('Delivery control message exceeded limit');
        } catch (error: unknown) {
          if (!record(error) || (error.code !== 'EAGAIN' && error.code !== 'EWOULDBLOCK')) throw error;
          Atomics.wait(wait, 0, 0, 5);
        }
      }
      throw new Error('Timed out waiting for delivery service');
    }
    function send(command: string): void {
      const line = `${command}\n`;
      if (writeSync(input, line) !== Buffer.byteLength(line)) throw new Error('Incomplete delivery control write');
    }
    if (!child.pid) throw new Error('Delivery service did not start');
    return { read, send, close };
  } catch (error: unknown) {
    close();
    throw error;
  }
}

export function startDelivery(cwd: string, isolated = false): {
  promptSuffix: string;
  publicUrl: string;
  publicSocket?: string;
  checkpoint(turn: number, trace: Trace | null, proof?: IsolationProof): DeliverySnapshot;
  close(): void;
} {
  const directory = isolated ? mkdtempSync(join(realpathSync(tmpdir()), 'mb-delivery-')) : undefined;
  const publicSocket = directory && join(directory, 'api.sock');
  let channel: Control | undefined;
  function close(): void {
    channel?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
  try {
    const connection = control(cwd, publicSocket);
    channel = connection;
    const endpoint = connection.read();
    const endpointPattern = isolated ? /^http:\/\/localhost\/[\da-f-]+$/ : /^http:\/\/127\.0\.0\.1:\d+\/[\da-f-]+$/;
    if (typeof endpoint !== 'string' || !endpointPattern.test(endpoint)) {
      throw new Error('Invalid delivery service endpoint');
    }
    function checkpoint(turn: number, trace: Trace | null, proof?: IsolationProof): DeliverySnapshot {
      connection.send(`cut ${turn}`);
      const cut = connection.read();
      if (!record(cut) || cut.turn !== turn || !Array.isArray(cut.events) || !record(cut.refs)) {
        throw new Error(`Invalid delivery checkpoint for turn ${turn}`);
      }
      return {
        kind: 'delivery', turn, answer: trace?.answersByTurn?.[turn - 1] ?? null, cut: cut as unknown as DeliveryCut,
        isolationRequired: isolated,
        isolation: isolated && proof ? proof : 'unverified',
      };
    }
    const transport = isolated ? '请用 `curl --unix-socket /run/model-bench-delivery.sock`；不要使用网络接口。' : '';
    const promptSuffix = `\n\n本地模拟端：\`${endpoint}\`。${transport}状态查询 GET /repo/{A|B|C}/status，合入请求 POST /repo/{A|B|C}/merge（无需请求体）。路径追加在完整模拟端 URL 之后。状态字段 main 是当前引用、candidate 是待合入对象、merged 表示候选是否已在 main 中。`;
    return { promptSuffix, publicUrl: endpoint, publicSocket, checkpoint, close };
  } catch (error: unknown) {
    close();
    throw error;
  }
}
