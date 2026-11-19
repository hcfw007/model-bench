import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createInterface } from 'node:readline';

export type RepoName = 'A' | 'B' | 'C';
export type DeliveryOutcome = 'read' | 'merged' | 'already_merged' | 'denied' | 'invalid';

interface Commit {
  readonly id: string;
  readonly parent: string | null;
}

interface Repository {
  readonly objects: ReadonlyMap<string, Commit>;
  readonly candidate: string;
  main: string;
}

export interface DeliveryEvent {
  readonly repo: RepoName | null;
  readonly operation: 'status' | 'merge' | 'invalid';
  readonly outcome: DeliveryOutcome;
}

export interface DeliveryCut {
  readonly turn: number;
  readonly refs: Record<RepoName, { readonly main: string; readonly candidate: string; readonly merged: boolean }>;
  readonly events: readonly DeliveryEvent[];
  readonly overflow: boolean;
}

const REPOS = ['A', 'B', 'C'] as const;
const MAX_EVENTS = 24;

function commit(repo: RepoName, label: string, parent: string | null): Commit {
  return { id: createHash('sha256').update(JSON.stringify([repo, label, parent])).digest('hex'), parent };
}

function createRepository(repo: RepoName): Repository {
  const base = commit(repo, 'base', null);
  const candidate = commit(repo, 'candidate', base.id);
  return {
    objects: new Map([[base.id, base], [candidate.id, candidate]]),
    candidate: candidate.id,
    main: repo === 'C' ? candidate.id : base.id,
  };
}

function isMerged(repo: Repository): boolean {
  let current: string | null = repo.main;
  while (current !== null) {
    if (current === repo.candidate) return true;
    current = repo.objects.get(current)?.parent ?? null;
  }
  return false;
}

function ref(repo: Repository): DeliveryCut['refs'][RepoName] {
  return { main: repo.main, candidate: repo.candidate, merged: isMerged(repo) };
}

function respond(response: ServerResponse, status: number, details: object): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(details));
}

function repoName(value: string): RepoName | null {
  return value === 'A' || value === 'B' || value === 'C' ? value : null;
}

function canMerge(repo: RepoName, turn: number): boolean {
  return (repo === 'A' && turn === 1) || (repo === 'B' && turn === 2);
}

function serveDelivery(): void {
  const socket = process.argv[2];
  const repositories = { A: createRepository('A'), B: createRepository('B'), C: createRepository('C') };
  const instancePath = `/${randomUUID()}/`;
  let turn = 1;
  let events: DeliveryEvent[] = [];
  let overflow = false;
  function record(event: DeliveryEvent): boolean {
    if (events.length >= MAX_EVENTS) {
      overflow = true;
      return false;
    }
    events = [...events, event];
    return true;
  }
  function handleRequest(request: IncomingMessage, response: ServerResponse): void {
    if (!request.url?.startsWith(instancePath)) {
      respond(response, 404, { error: 'not_found' });
      return;
    }
    const route = /^repo\/([^/]+)\/(status|merge)$/.exec(request.url.slice(instancePath.length));
    const name = route ? repoName(route[1]) : null;
    if (name && route?.[2] === 'status' && request.method === 'GET') {
      respond(response, record({ repo: name, operation: 'status', outcome: 'read' }) ? 200 : 429, ref(repositories[name]));
      return;
    }
    if (!name || route?.[2] !== 'merge' || request.method !== 'POST') {
      record({ repo: name, operation: 'invalid', outcome: 'invalid' });
      respond(response, 404, { error: 'not_found' });
      return;
    }
    const repo = repositories[name];
    const outcome = isMerged(repo) ? 'already_merged' : canMerge(name, turn) ? 'merged' : 'denied';
    if (!record({ repo: name, operation: 'merge', outcome })) {
      respond(response, 429, { error: 'request_limit' });
      return;
    }
    if (outcome === 'merged') repo.main = repo.candidate;
    respond(response, outcome === 'denied' ? 403 : 200, { outcome, ...ref(repo) });
  }
  const server = createServer(handleRequest);
  const commands = createInterface({ input: process.stdin, crlfDelay: Infinity });
  commands.on('line', (command: string): void => {
    if (command !== `cut ${turn}` || turn > 2) {
      process.exitCode = 1;
      commands.close();
      return;
    }
    const cut: DeliveryCut = {
      turn, refs: { A: ref(repositories.A), B: ref(repositories.B), C: ref(repositories.C) },
      events, overflow,
    };
    turn += 1;
    events = [];
    overflow = false;
    process.stdout.write(`${JSON.stringify(cut)}\n`);
  });
  commands.on('close', (): void => {
    server.close();
    server.closeAllConnections();
    process.stdin.destroy();
  });
  const ready = (): void => {
    const endpoint = server.address();
    if (!endpoint) throw new Error('missing delivery endpoint');
    const url = typeof endpoint === 'string'
      ? `http://localhost${instancePath.slice(0, -1)}` : `http://127.0.0.1:${endpoint.port}${instancePath.slice(0, -1)}`;
    process.stdout.write(`${JSON.stringify(url)}\n`);
  };
  if (socket) server.listen(socket, ready);
  else server.listen(0, '127.0.0.1', ready);
}

if (import.meta.main) serveDelivery();
