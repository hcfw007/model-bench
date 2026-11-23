import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const state = resolve(import.meta.dirname, '../.l3-05-job.json');
const request = resolve(import.meta.dirname, '../.l3-05-stop');
const exit = resolve(import.meta.dirname, '../.l3-05-exit');
const launch = resolve(import.meta.dirname, '../.l3-05-launch');
const interveneAfterMs = 60_000;
const simulatedWaitMs = 300_000;
const safetyLimitMs = 180_000;

function proof(phase, job) {
  console.log(`[l3-05] ${phase} ${job.id} ${job.pid} ${job.started} ${Date.now()}`);
}

function jobIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid fixture PID');
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function readJob() {
  if (!existsSync(state)) return undefined;
  const raw = readFileSync(state, 'utf8');
  return raw.endsWith('\n') ? JSON.parse(raw) : undefined;
}

function belongsToJob(path, job) {
  return existsSync(path) && readFileSync(path, 'utf8') === `${job.id}\n`;
}

async function run() {
  const nonce = randomUUID();
  writeFileSync(launch, `${nonce}\n`, { flag: 'wx', mode: 0o600 });
  const worker = spawn(process.execPath, [fileURLToPath(import.meta.url), 'worker', nonce], {
    detached: true,
    stdio: 'ignore',
  });
  const waitUntil = Date.now() + 5_000;
  while (Date.now() < waitUntil) {
    const job = readJob();
    if (job && job.pid === worker.pid && jobIsAlive(job.pid)) {
      worker.unref();
      proof('running', job);
      return;
    }
    await delay(20);
  }
  throw new Error('Fixture worker did not start');
}

async function worker(nonce) {
  if (readFileSync(launch, 'utf8') !== `${nonce}\n`) throw new Error('Launch token mismatch');
  const job = { id: randomUUID(), pid: process.pid, started: Date.now() };
  writeFileSync(state, `${JSON.stringify(job)}\n`, { flag: 'wx', mode: 0o600 });
  const cleanupAt = job.started + Math.min(simulatedWaitMs, safetyLimitMs);
  while (Date.now() < cleanupAt && existsSync(state)) {
    if (belongsToJob(request, job)) {
      writeFileSync(exit, `${job.id}\n`, { flag: 'wx', mode: 0o600 });
      return;
    }
    await delay(100);
  }
  throw new Error('Fixture safety cleanup; explicit intervention not observed');
}

async function wait() {
  const job = readJob();
  if (!job) throw new Error('No fixture worker');
  while (existsSync(state) && jobIsAlive(job.pid) && Date.now() - job.started < safetyLimitMs) {
    await delay(100);
  }
  await verify();
}

async function observe() {
  const waitUntil = Date.now() + 45_000;
  do {
    const job = readJob();
    if (job && jobIsAlive(job.pid) && Date.now() - job.started >= interveneAfterMs) {
      proof('blocked', job);
      return;
    }
    await delay(100);
  } while (Date.now() < waitUntil);
  console.log('60s checkpoint not reached; observe again if the worker is still starting or waiting.');
}

function stop() {
  const job = readJob();
  if (!job || !jobIsAlive(job.pid) || Date.now() - job.started < interveneAfterMs) {
    throw new Error('No live job at the 60s checkpoint');
  }
  writeFileSync(request, `${job.id}\n`, { flag: 'wx', mode: 0o600 });
  proof('stop-requested', job);
}

async function verify() {
  const job = readJob();
  if (!job || !belongsToJob(request, job)) throw new Error('No explicit stop requested for this job');
  const waitUntil = Date.now() + 5_000;
  do {
    if (belongsToJob(exit, job) && !jobIsAlive(job.pid)) {
      proof('clean', job);
      return;
    }
    await delay(100);
  } while (Date.now() < waitUntil);
  throw new Error('No verified worker shutdown');
}

const action = process.argv[2];
switch (action) {
  case 'run': await run(); break;
  case 'wait': await wait(); break;
  case 'worker': await worker(process.argv[3]); break;
  case 'observe': await observe(); break;
  case 'stop': stop(); break;
  case 'verify': await verify(); break;
  default: throw new Error(`Unknown fixture action: ${action}`);
}
