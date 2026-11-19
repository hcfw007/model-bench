import type { AssertResult } from './assert-artifacts.ts';
import { hasActiveOverlap, type ChildInvocation } from './trace-events.ts';
import type { ToolCall, Trace } from './trace.ts';
import { toolSucceeded } from './assert-tool-order.ts';

const SPAWN_TOOLS = new Set(['subagent', 'task', 'Task']);

export function assertFanout(
  trace: Trace, taskPatterns: readonly string[],
): AssertResult & { missingEvidence?: true } {
  const type = 'subagents';
  const taskMatchers = taskPatterns.map((pattern: string): RegExp => new RegExp(pattern, 'i'));
  const groups = taskMatchers.map((): ChildInvocation[] => []);
  const unresolved = taskMatchers.map((): boolean => false);
  const direct = (trace.invocations ?? []).filter((invocation: ChildInvocation): boolean =>
    invocation.parentId === trace.sessionId);
  for (const call of trace.toolCalls) {
    if (call.sessionId !== trace.sessionId || !SPAWN_TOOLS.has(call.name) || !toolSucceeded(call)) continue;
    const taskText = `${call.input.description ?? ''}\n${call.input.prompt ?? ''}`;
    const matching = taskMatchers.map((matcher: RegExp): boolean => matcher.test(taskText));
    if (matching.filter(Boolean).length !== 1) continue;
    const task = matching.indexOf(true);
    if (!call.childSessionId || call.startedAt === undefined) {
      unresolved[task] ||= direct.length >= taskMatchers.length;
      continue;
    }
    const start = call.startedAt;
    const child = direct.find((invocation: ChildInvocation): boolean => invocation.sessionId === call.childSessionId);
    if (child && child.start >= start) groups[task].push(child);
    if (trace.incompleteSessions?.includes(call.childSessionId)) unresolved[task] = true;
  }
  const pass = matchingOverlap(groups, []);
  const missing = !pass && (trace.invocations === undefined || trace.incompleteSessions?.includes(trace.sessionId)
    || (unresolved.some(Boolean) && groups.every((group: ChildInvocation[], index: number): boolean =>
      group.length > 0 || unresolved[index])));
  return {
    type, pass, detail: `active direct parallel tasks=${groups.map((group: ChildInvocation[]): number => group.length).join('/')}`,
    ...(missing ? { missingEvidence: true as const } : {}),
  };
}

function matchingOverlap(
  groups: readonly ChildInvocation[][], chosen: readonly ChildInvocation[],
): boolean {
  if (chosen.length === groups.length) return hasActiveOverlap(chosen);
  return groups[chosen.length].some((candidate: ChildInvocation): boolean => {
    if (chosen.some((invocation: ChildInvocation): boolean => invocation.sessionId === candidate.sessionId)) return false;
    const next = [...chosen, candidate];
    return (next.length < 2 || hasActiveOverlap(next)) && matchingOverlap(groups, next);
  });
}
