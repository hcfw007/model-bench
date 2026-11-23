import type { AssertResult } from './assert-artifacts.ts';
import { observedGoVerification } from './assert-l3-leader.ts';
import { hasActiveOverlap, type ChildInvocation } from './trace-events.ts';
import type { ToolCall, Trace } from './trace.ts';
import { toolSucceeded } from './assert-tool-order.ts';

const SPAWN_TOOLS = new Set(['subagent', 'task', 'Task']);

export function assertFanout(
  trace: Trace, taskPatterns: readonly string[], options: { preferDescriptions?: boolean; verifyGoAfterFanout?: boolean } = {},
): AssertResult & { missingEvidence?: true } {
  const type = 'subagents';
  const taskMatchers = taskPatterns.map((pattern: string): RegExp => new RegExp(pattern, 'i'));
  const groups = taskMatchers.map((): ChildInvocation[] => []);
  const unresolved = taskMatchers.map((): boolean => false);
  const direct = (trace.invocations ?? []).filter((invocation: ChildInvocation): boolean =>
    invocation.parentId === trace.sessionId);
  for (const call of trace.toolCalls) {
    if (call.sessionId !== trace.sessionId || !SPAWN_TOOLS.has(call.name) || !toolSucceeded(call)) continue;
    const description = String(call.input.description ?? '');
    const descriptionMatches = taskMatchers.map((matcher: RegExp): boolean => matcher.test(description));
    const matching = options.preferDescriptions && descriptionMatches.filter(Boolean).length === 1
      ? descriptionMatches
      : taskMatchers.map((matcher: RegExp): boolean => matcher.test(`${description}\n${call.input.prompt ?? ''}`));
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
  const parallel = matchingOverlap(groups, []);
  const pass = parallel && (!options.verifyGoAfterFanout || matchingOverlap(groups, [], (workers) =>
    observedGoVerification(trace, trace.sessionId, Math.max(...workers.map(({ end }) => end)))));
  const missing = !parallel && (trace.invocations === undefined || trace.incompleteSessions?.includes(trace.sessionId)
    || (unresolved.some(Boolean) && groups.every((group: ChildInvocation[], index: number): boolean =>
      group.length > 0 || unresolved[index])));
  return {
    type, pass, detail: parallel && !pass ? 'root did not successfully run build and test after fanout'
      : `active direct parallel tasks=${groups.map((group: ChildInvocation[]): number => group.length).join('/')}`,
    ...(missing ? { missingEvidence: true as const } : {}),
  };
}

function matchingOverlap(
  groups: readonly ChildInvocation[][], chosen: readonly ChildInvocation[],
  accept?: (workers: readonly ChildInvocation[]) => boolean,
): boolean {
  if (chosen.length === groups.length) return hasActiveOverlap(chosen) && (accept?.(chosen) ?? true);
  return groups[chosen.length].some((candidate: ChildInvocation): boolean => {
    if (chosen.some((invocation: ChildInvocation): boolean => invocation.sessionId === candidate.sessionId)) return false;
    const next = [...chosen, candidate];
    return (next.length < 2 || hasActiveOverlap(next)) && matchingOverlap(groups, next, accept);
  });
}
