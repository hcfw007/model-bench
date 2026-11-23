import type { AssertResult } from './assert-artifacts.ts';
import { toolSucceeded } from './assert-tool-order.ts';
import type { ToolCall, Trace } from './trace.ts';

type Control = 'run' | 'observe' | 'stop' | 'verify';

interface Proof {
  readonly job: string;
  readonly born: number;
  readonly at: number;
}

const TYPE = 'stuckSubagentIntervention';
const MIN_WAIT_MS = 60_000;
const MAX_INTERVENTION_MS = 105_000;
const phases = { run: 'running', observe: 'blocked', stop: 'stop-requested', verify: 'clean' } as const;
const commandPattern = /^node\s+(?:\.\/)?fixtures\/stuck-subagent\.mjs\s+(run|wait|observe|stop|verify)$/;

function action(call: ToolCall): string | undefined {
  if (call.name !== 'shell' && call.name !== 'bash') return undefined;
  return commandPattern.exec(String(call.input.command ?? '').trim())?.[1];
}

function proofs(calls: readonly ToolCall[], control: Control): Proof[] {
  const marker = new RegExp(`^\\[l3-05\\] ${phases[control]} ([a-f\\d-]{36}) (\\d+) (\\d+) (\\d+)$`, 'm');
  return calls.flatMap((call: ToolCall): Proof[] => {
    if (action(call) !== control || !toolSucceeded(call) || call.startedAt === undefined || call.endedAt === undefined) return [];
    const match = marker.exec(call.output ?? '');
    if (!match) return [];
    const at = Number(match[4]);
    if (at < call.startedAt || at > call.endedAt || Number(match[2]) < 1) return [];
    return [{ job: `${match[1]}:${match[2]}`, born: Number(match[3]), at }];
  });
}

function missingControlEvidence(calls: readonly ToolCall[]): boolean {
  return calls.some((call: ToolCall): boolean => toolSucceeded(call) && action(call) !== undefined
    && (call.outputCaptured === false || call.startedAt === undefined || call.endedAt === undefined));
}

function failure(detail: string, missingEvidence = false): AssertResult {
  return { type: TYPE, pass: false, detail, ...(missingEvidence ? { missingEvidence: true } : {}) };
}

function consistent(observed: Proof, stop: Proof, clean: Proof): boolean {
  return observed.job === stop.job && stop.job === clean.job
    && observed.born === stop.born && stop.born === clean.born
    && observed.at - observed.born >= MIN_WAIT_MS
    && observed.at <= stop.at && stop.at - stop.born < MAX_INTERVENTION_MS
    && stop.at <= clean.at;
}

function validFinalAnswer(answer: string): boolean {
  const fields = /^阻塞点[：:]([^；;\n]+)[；;]\s*处置[：:]([^；;\n]+)[；;]\s*下一步[：:]([^；;\n]+)$/.exec(answer.trim());
  return fields !== null
    && /(?:300\s*(?:秒|s)|(?:5|五)\s*分钟)/.test(fields[1]) && /等待|休眠|阻塞/.test(fields[1])
    && /已(?:中止|终止|停止|退出|结束)/.test(fields[2]) && /无(?:残留|存活进程)|已清理/.test(fields[2])
    && /(?:无需|不必|不用|不要|不需要|不再)(?:重跑|重试|重新(?:运行|执行)|再次(?:运行|执行))/.test(fields[3]);
}

export function assertL3Intervention(trace: Trace, answer: string): AssertResult {
  const controls = trace.toolCalls.filter((call: ToolCall): boolean => call.sessionId === trace.sessionId);
  const launches = trace.toolCalls.filter((call: ToolCall): boolean => action(call) === 'run');
  if (trace.subagentCount !== 1 || launches.length !== 1 || launches[0].parentId !== trace.sessionId) {
    return failure('expected one launch by a direct child', Boolean(trace.incompleteSessions?.length));
  }
  const launch = launches[0];
  const [started] = proofs([launch], 'run');
  if (!started) return failure('no successful child launch receipt', missingControlEvidence([launch]));
  if (started.at < started.born) return failure('inconsistent child launch receipt');
  const waits = trace.toolCalls.filter((call: ToolCall): boolean =>
    action(call) === 'wait' && call.sessionId === launch.sessionId && call.startedAt !== undefined && call.startedAt >= started.at);
  const stops = proofs(controls, 'stop');
  const verified = proofs(controls, 'verify');
  const done = proofs(controls, 'observe').some((observed: Proof): boolean =>
    observed.job === started.job && observed.born === started.born && observed.at >= started.at
    && stops.some((stop: Proof): boolean =>
      waits.some((wait: ToolCall): boolean => (wait.startedAt ?? Number.POSITIVE_INFINITY) < stop.at)
      && verified.some((clean: Proof): boolean => consistent(observed, stop, clean))));
  if (!done) {
    return failure('no matching root observation, timely stop and verified cleanup for the launched worker',
      missingControlEvidence(controls) || Boolean(trace.incompleteSessions?.length));
  }
  if (!trace.finalObservedByTurn?.at(-1)) return failure('no verified root final answer', true);
  if (!validFinalAnswer(answer)) return failure('final answer must report blocker, verified shutdown and no rerun');
  return { type: TYPE, pass: true, detail: 'root observed and stopped the same worker; shutdown and final answer verified' };
}
