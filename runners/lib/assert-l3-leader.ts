import type { AssertResult } from './assert-artifacts.ts';
import { hasActiveOverlap, type ChildInvocation } from './trace-events.ts';
import type { ToolCall, Trace } from './trace.ts';

const TYPE = 'singleLeaderFanout';
const EDIT_TOOLS = new Set(['patch', 'apply_patch', 'edit', 'write', 'multiedit', 'multi_edit']);
const SHELL_TOOLS = new Set(['shell', 'bash']);
const GO_TARGET = /(?:go-projects\/some-service\/internal\/biz\/bulk_send_v1\/[^\s"'`]+\.go|\bconfirm(?:_test)?\.go)\b/;
const TS_TARGET = /\bConfirmListPanel(?:\.test|\.spec)?\.tsx\b/;
const SHELL_MUTATION = /\b(?:apply_patch|tee|sed\s+-\S*i|perl\s+-\S*i|gofmt\s+-w)\b|(?:>>?)\s*['"]?[\w./-]+\.(?:go|tsx)\b|\b(?:write_text|write_bytes|writeFile(?:Sync)?)\s*\(/;

function successfulEdits(trace: Trace): ToolCall[] {
  return trace.toolCalls.filter((call: ToolCall): boolean => call.status === 'completed' && !call.exitCode
    && (EDIT_TOOLS.has(call.name)
      || (SHELL_TOOLS.has(call.name) && SHELL_MUTATION.test(String(call.input.command ?? '')))));
}

function editsTarget(edits: readonly ToolCall[], worker: ChildInvocation, target: RegExp): boolean {
  return edits.some((call: ToolCall): boolean => call.sessionId === worker.sessionId && target.test(
    changedPaths(call),
  ));
}

function changedPaths(call: ToolCall): string {
  const patch = call.input.patchText ?? call.input.patch;
  if (typeof patch === 'string') {
    return [...patch.matchAll(/^\*\*\* (?:Update File|Add File|Delete File|Move to): (.+)$/gm)]
      .map((match: RegExpMatchArray): string => match[1]).join('\n');
  }
  if (call.input.filePath || call.input.path) return String(call.input.filePath ?? call.input.path);
  const command = String(call.input.command ?? '');
  const redirected = [...command.matchAll(/(?:\btee\b|>>?)\s*['"]?([\w./-]+)/g)];
  return redirected.length ? redirected.map((match: RegExpMatchArray): string => match[1]).join('\n') : command;
}

export function observedGoVerification(trace: Trace, executor: string, after: number): boolean {
  const commands = trace.toolCalls.filter((call: ToolCall): boolean =>
    call.sessionId === executor && SHELL_TOOLS.has(call.name) && call.status === 'completed' && call.exitCode === 0
    && (call.startedAt ?? 0) >= after).map((call: ToolCall): string => String(call.input.command ?? ''));
  return ['build', 'test'].every((name: string): boolean => commands.some((command: string): boolean => {
    // Only the last semicolon group contributes to the observed shell exit status.
    const finalChain = command.trim().split(/;(?=\s|$)|\n/).at(-1)?.trim() ?? '';
    if (/\|\||(?<!&)&(?!&)|(?<!\|)\|(?!\|)/.test(finalChain)) return false;
    return new RegExp(`(?:^|&&)\\s*(?:GO\\w+=\\S+\\s+)*go\\s+${name}\\s+(?:[^&;]*\\s)?\\./\\.{3}(?:\\s|$)`).test(finalChain);
  }));
}

function failure(detail: string, missingEvidence = false): AssertResult {
  return { type: TYPE, pass: false, detail, ...(missingEvidence ? { missingEvidence: true } : {}) };
}

export function assertL3Leader(trace: Trace): AssertResult {
  const { invocations } = trace;
  if (!invocations) return failure('child activity not captured', true);
  const leaders = new Set(invocations.filter(({ parentId }) => parentId === trace.sessionId).map(({ sessionId }) => sessionId));
  const requested = trace.toolCalls.filter((call: ToolCall): boolean =>
    call.sessionId === trace.sessionId && /^(?:subagent|task)$/i.test(call.name) && call.childSessionId !== undefined);
  requested.forEach((call: ToolCall): void => { if (call.childSessionId) leaders.add(call.childSessionId); });
  if (leaders.size !== 1 || trace.maxAgentDepth !== 2) {
    return failure(`expected one leader and two levels; leaders=${leaders.size} depth=${trace.maxAgentDepth}`);
  }
  const [leader] = leaders;
  const edits = successfulEdits(trace);
  if (edits.some(({ sessionId }) => sessionId === trace.sessionId || sessionId === leader)) {
    return failure('root or leader performed implementation');
  }
  const workers = invocations.filter(({ parentId }) => parentId === leader);
  const go = workers.filter((worker: ChildInvocation): boolean => editsTarget(edits, worker, GO_TARGET));
  const ts = workers.filter((worker: ChildInvocation): boolean => editsTarget(edits, worker, TS_TARGET));
  if (go.length !== 1 || ts.length !== 1 || go[0].sessionId === ts[0].sessionId || !hasActiveOverlap([go[0], ts[0]])) {
    return failure('expected distinct Go and TS implementers with overlapping activity under the leader',
      Boolean(trace.incompleteSessions?.length));
  }
  const implementers = new Set([go[0].sessionId, ts[0].sessionId]);
  if (edits.some(({ sessionId }) => !implementers.has(sessionId ?? ''))) {
    return failure('only two implementers may edit');
  }
  const implementedAt = Math.max(go[0].end, ts[0].end, ...edits.map((call: ToolCall): number =>
    call.endedAt ?? Number.POSITIVE_INFINITY));
  if (!Number.isFinite(implementedAt)) return failure('worker edit completion time not captured', true);
  if (workers.some(({ sessionId, start }) => !implementers.has(sessionId) && start < implementedAt)) {
    return failure('additional read-only review must start after implementation');
  }
  if (!observedGoVerification(trace, leader, implementedAt)) return failure('leader did not successfully run build and test after implementation');
  return { type: TYPE, pass: true, detail: 'one non-editing leader, two parallel implementers and leader-side verification' };
}
