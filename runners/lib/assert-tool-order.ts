import { basename, isAbsolute, relative, resolve } from 'node:path';

import type { AssertCtx, AssertResult } from './assert-artifacts.ts';
import type { ToolCall } from './trace.ts';

type EvidenceResult = AssertResult & { missingEvidence?: true };

const EDIT_TOOLS = new Set(['edit', 'patch', 'apply_patch', 'write', 'multiedit', 'multi_edit']);
const SHELL_TOOLS = new Set(['shell', 'bash']);
const SEARCH_COMMAND = /^(?:git\s+grep|grep|rg|find)(?:\s|$)/;
const READ_COMMAND = /^(?:cat|sed|head|tail|nl|bat)(?:\s|$)/;
const SHELL_EDIT = /(?:^|[;&|\n]\s*)(?:apply_patch|tee|touch|mkdir|mv|cp|rm|truncate|perl\s+-\S*i|sed\s+-\S*i)\b|(?:^|[^<>=])>>?\s*['"]?[\w./-]+\.(?:go|ts|tsx|js|json|md)\b|\b(?:write_text|write_bytes|writeFile(?:Sync)?|appendFile(?:Sync)?)\s*\(/;

export function toolSucceeded(call: ToolCall): boolean {
  return call.status === 'completed' && (call.exitCode === undefined || call.exitCode === 0);
}

function unquote(value: string): string {
  return value.replace(/^(['"])(.*)\1$/, '$2');
}

function shellContext(call: ToolCall, worktree: string): { command: string; cwd: string } {
  const command = String(call.input.command ?? '').trim();
  const cwd = resolve(worktree, String(call.input.workdir ?? call.input.cwd ?? '.'));
  const prefixed = /^cd\s+("[^"]+"|'[^']+'|[^;&\s]+)\s*&&\s*/.exec(command);
  return prefixed
    ? { command: command.slice(prefixed[0].length), cwd: resolve(cwd, unquote(prefixed[1])) }
    : { command, cwd };
}

function standalone(command: string): boolean {
  const bare = command.replace(/'[^']*'|"[^"]*"/g, '');
  return command.length > 0 && !/[;|&<>\n`]|\$\(/.test(bare) && !/`|\$\(/.test(command);
}

function repoPath(path: string, cwd: string, worktree: string): string {
  const canonical = (absolute: string): string => absolute.replace(/^\/private\/var\//, '/var/');
  const rel = relative(canonical(resolve(worktree)), canonical(resolve(cwd, unquote(path))));
  return rel.startsWith('../') || rel === '..' || isAbsolute(rel) ? '' : rel;
}

function pathAndMatch(line: string): { path: string; text: string } {
  const colon = /^([^:]+):(?:\d+:(?:\d+:)?)?\s*(.*)$/.exec(line);
  return colon ? { path: colon[1], text: colon[2] } : { path: line, text: '' };
}

export function matchedSearch(
  call: ToolCall, worktree: string, targets: readonly string[], subject?: RegExp,
  allowPathLookup = false,
): boolean {
  if (!searchesSubject(call, worktree, targets, subject, allowPathLookup) || !call.output) return false;
  const shell = SHELL_TOOLS.has(call.name);
  const { command, cwd } = shell ? shellContext(call, worktree) : { command: '', cwd: worktree };
  const pathLookup = call.name === 'glob' || /^find\s/.test(command);
  let currentPath = '';
  for (const raw of call.output.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    if (/^Line \d+:/.test(line)) {
      if (subject?.test(line) && targets.includes(currentPath)) return true;
      continue;
    }
    const { path, text } = pathAndMatch(line);
    currentPath = repoPath(path.trim(), cwd, worktree);
    if (!targets.includes(currentPath)) continue;
    if (!subject || pathLookup || subject.test(text)) return true;
  }
  return false;
}

export function searchesSubject(
  call: ToolCall, worktree: string, targets: readonly string[], subject?: RegExp, allowPathLookup = false,
): boolean {
  if (!toolSucceeded(call)) return false;
  const shell = SHELL_TOOLS.has(call.name);
  const { command } = shell ? shellContext(call, worktree) : { command: '' };
  if (shell ? !(SEARCH_COMMAND.test(command) && standalone(command)) : !['grep', 'glob'].includes(call.name)) {
    return false;
  }
  const pathLookup = call.name === 'glob' || /^find\s/.test(command);
  const query = shell ? command : String(call.input.pattern ?? '');
  if (pathLookup) return allowPathLookup && targets.some((target: string): boolean => query.includes(basename(target)));
  return subject === undefined || subject.test(query);
}

export function readsTarget(call: ToolCall, worktree: string, target: string): boolean {
  if (call.name === 'read') {
    const path = call.input.path ?? call.input.filePath;
    return typeof path === 'string' && repoPath(path, worktree, worktree) === target;
  }
  if (!SHELL_TOOLS.has(call.name)) return false;
  const { command, cwd } = shellContext(call, worktree);
  if (!READ_COMMAND.test(command) || SHELL_EDIT.test(command)) return false;
  const first = command.match(/^(?:"[^"]*"|'[^']*'|[^"';&|\n])+/)?.[0] ?? '';
  const words = first.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];
  const file = words.at(-1);
  if (!file || words.length < 2 || repoPath(file, cwd, worktree) !== target) return false;
  const options = words.slice(1, -1).map(unquote).join(' ');
  if (words[0] === 'sed') return /^-nE? \d+(?:,\d+)?p$/.test(options);
  return /^(?:-\w+(?: \d+)? ?)*$/.test(options);
}

function isEdit(call: ToolCall, worktree: string): boolean {
  return EDIT_TOOLS.has(call.name)
    || (SHELL_TOOLS.has(call.name) && SHELL_EDIT.test(shellContext(call, worktree).command));
}

function startsBefore(first: ToolCall, next: ToolCall): boolean {
  if (first.startedAt !== undefined && next.startedAt !== undefined && first.startedAt !== next.startedAt) {
    return first.startedAt < next.startedAt;
  }
  if (!first.sessionId || first.sessionId !== next.sessionId || first.seq === undefined || next.seq === undefined) return false;
  if (first.seq !== next.seq) return first.seq < next.seq;
  return first.partIndex !== undefined && next.partIndex !== undefined && first.partIndex < next.partIndex;
}

function hasReadContent(call: ToolCall, worktree: string): boolean {
  if (!call.output?.trim() || call.output.trim() === '(no output)') return false;
  if (call.name === 'read') return !/^Read directory\b|<type>\s*directory\s*<\/type>/.test(call.output);
  return standalone(shellContext(call, worktree).command);
}

export function assertToolOrder(assertion: Record<string, unknown>, ctx: AssertCtx): EvidenceResult {
  const { trace, worktree } = ctx;
  const type = String(assertion.type);
  const targets = assertion.searchTargets as string[];
  const subject = assertion.searchSubject === undefined ? undefined : new RegExp(String(assertion.searchSubject), 'i');
  const allowPathLookup = assertion.before === 'read';
  if (!trace) return { type, pass: false, detail: 'no trace', missingEvidence: true };
  const operations = trace.toolCalls.filter((call: ToolCall): boolean => assertion.before === 'edit'
    ? isEdit(call, worktree)
    : readsTarget(call, worktree, String(assertion.readTarget)));
  const candidates = operations.filter((call: ToolCall): boolean =>
    !operations.some((other: ToolCall): boolean => startsBefore(other, call)));
  if (!operations.length) return {
    type, pass: false, detail: `no target ${assertion.before} observed`,
    ...(trace.incompleteSessions?.length ? { missingEvidence: true as const } : {}),
  };
  if (candidates.length !== 1) return { type, pass: false, detail: 'cannot identify first operation', missingEvidence: true };
  const [first] = candidates;
  if (!toolSucceeded(first)) return { type, pass: false, detail: `first target ${assertion.before} failed` };
  const { sessionId, seq, startedAt } = first;
  if (sessionId === undefined || seq === undefined || startedAt === undefined) {
    return { type, pass: false, detail: 'first action lacks executor or timing', missingEvidence: true };
  }
  if (assertion.before === 'read' && !hasReadContent(first, worktree)) {
    const missing = first.outputCaptured === false || first.output === undefined;
    return {
      type, pass: false, detail: 'first target read returned no verifiable source content',
      ...(missing ? { missingEvidence: true as const } : {}),
    };
  }
  const searches = trace.toolCalls.filter((call: ToolCall): boolean =>
    call.sessionId === sessionId && startsBefore(call, first)
    && searchesSubject(call, worktree, targets, subject, allowPathLookup));
  if (searches.some((call: ToolCall): boolean =>
    call.endedAt !== undefined && call.endedAt <= startedAt
    && matchedSearch(call, worktree, targets, subject, allowPathLookup))) {
    return { type, pass: true, detail: `target located before first ${assertion.before}` };
  }
  const missing = trace.incompleteSessions?.includes(sessionId) || searches.some((call: ToolCall): boolean =>
    call.output === undefined || call.outputCaptured === false
    || (call.endedAt === undefined && matchedSearch(call, worktree, targets, subject, allowPathLookup)));
  return {
    type, pass: false, detail: `no verified same-executor match before first ${assertion.before}`,
    ...(missing ? { missingEvidence: true as const } : {}),
  };
}
