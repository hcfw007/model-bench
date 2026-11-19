import { randomBytes } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { record } from './scenario-json.ts';
import type { Trace } from './trace.ts';

interface Evidence {
  readonly env: 'test' | 'stage';
  readonly label: string;
  readonly path: string;
  readonly id: string;
  readonly line: string;
}

export interface EvidenceSnapshot {
  readonly kind: 'evidence';
  readonly turn: number;
  readonly answer: string | null;
  readonly fixturesIntact: boolean;
  readonly expectedIds: readonly string[];
  readonly readIds: readonly string[];
}

const EVIDENCE = [
  ['test', 'log'], ['test', 'state'], ['stage', 'metric'], ['stage', 'state'],
] as const;
const FIXTURES = new URL('../../fixtures/scenarios/l2-08/', import.meta.url);
const WINDOW = '10:00-10:15 UTC';

function provision(root: string): Evidence[] {
  return EVIDENCE.map(([env, label]): Evidence => {
    const fileName = `${env}-${label}.json`;
    const fixture: unknown = JSON.parse(readFileSync(new URL(fileName, FIXTURES), 'utf8'));
    if (!record(fixture) || typeof fixture.evidenceId !== 'string' || fixture.env !== env || fixture.window !== WINDOW) {
      throw new Error(`Invalid environment fixture ${fileName}`);
    }
    const id = `${fixture.evidenceId}-${randomBytes(5).toString('hex')}`;
    const path = join(root, fileName);
    const line = JSON.stringify({ ...fixture, evidenceId: id });
    writeFileSync(path, `${line}\n`, { flag: 'wx', mode: 0o444 });
    return { env, label, path, id, line };
  });
}

function intact(evidence: Evidence): boolean {
  try {
    return lstatSync(evidence.path).isFile() && readFileSync(evidence.path, 'utf8') === `${evidence.line}\n`;
  } catch (error: unknown) {
    if (record(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false;
    throw error;
  }
}

function outputMatches(output: string, evidence: Evidence, cwd: string): boolean {
  const numbered = /^Read file (.+), lines 1-1\r?\n([\s\S]+)$/.exec(output);
  if (numbered) return resolve(cwd, numbered[1]) === evidence.path && numbered[2].trim() === `1: ${evidence.line}`;
  const envelope = /^\s*<path>\s*([^\n]+?)\s*<\/path>\s*<type>\s*file\s*<\/type>\s*<content>\s*([\s\S]*?)\s*<\/content>\s*$/.exec(output);
  if (envelope && resolve(cwd, envelope[1]) !== evidence.path) return false;
  const body = (envelope?.[2] ?? output).trim()
    .replace(/\s*\(End of file - total 1 lines?\)$/, '')
    .replace(/^1:\s*/, '');
  return body === evidence.line;
}

function observed(evidence: Evidence, turn: number, trace: Trace | null, cwd: string): boolean {
  return trace?.toolCalls.some((call): boolean => {
    const target = call.input.path ?? call.input.filePath;
    return call.turn === turn && call.name === 'read' && call.status === 'completed'
      && typeof target === 'string' && resolve(cwd, target) === evidence.path
      && typeof call.output === 'string' && outputMatches(call.output, evidence, cwd);
  }) ?? false;
}

function snapshot(evidence: Evidence[], turn: number, trace: Trace | null, cwd: string): EvidenceSnapshot {
  const expected = evidence.filter((item) => item.env === (turn === 1 ? 'test' : 'stage'));
  return {
    kind: 'evidence', turn, answer: trace?.answersByTurn?.[turn - 1] ?? null,
    fixturesIntact: evidence.every(intact), expectedIds: expected.map((item) => item.id),
    readIds: expected.filter((item) => observed(item, turn, trace, cwd)).map((item) => item.id),
  };
}

export function startEvidence(cwd: string): {
  promptSuffix: string; checkpoint(turn: number, trace: Trace | null): EvidenceSnapshot; close(): void;
} {
  const workspace = realpathSync(cwd);
  const root = mkdtempSync(join(workspace, '.model-bench-evidence-'));
  const close = (): void => rmSync(root, { recursive: true, force: true });
  try {
    const evidence = provision(root);
    const promptSuffix = `\n\n本地证据路径：\n${evidence.map((item) => `- ${item.env} ${item.label}: \`${item.path}\``).join('\n')}`;
    return { promptSuffix, checkpoint: (turn, trace) => snapshot(evidence, turn, trace, workspace), close };
  } catch (error: unknown) {
    close();
    throw error;
  }
}
