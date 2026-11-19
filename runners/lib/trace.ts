import type { DatabaseSync } from 'node:sqlite';

import {
  hasActiveOverlap, initialInvocation, numberValue, parseMessage, record, textParts,
  type ChildInvocation, type MessageRow,
} from './trace-events.ts';

export interface ToolCall {
  name: string;
  status: string;
  input: Record<string, unknown>;
  /** 最近一条根会话用户输入的轮号，从 1 开始。 */
  turn: number;
  /** 失败时的原始错误信息，用于判定 depth limit 之类的配置问题 */
  error?: string;
  output?: string;
  outputCaptured?: boolean;
  sessionId?: string;
  parentId?: string | null;
  seq?: number;
  partIndex?: number;
  startedAt?: number;
  endedAt?: number;
  exitCode?: number;
  childSessionId?: string;
}

export interface RecordedToolCall extends ToolCall {
  output: string;
  outputCaptured: boolean;
  sessionId: string;
  parentId: string | null;
  seq: number;
  partIndex: number;
}

export interface Trace {
  sessionId: string;
  turns: number;
  toolCalls: ToolCall[];
  toolErrors: Record<string, number>;
  subagentCount: number;
  maxAgentDepth: number;
  subagentsParallel: boolean;
  compactionCount: number;
  modelSwitches: number;
  tokensInput: number;
  tokensOutput: number;
  finalText: string;
  durationSec: number;
  answersByTurn?: string[];
  finalObservedByTurn?: boolean[];
  invocations?: ChildInvocation[];
  incompleteSessions?: string[];
}

export interface RecordedTrace extends Trace {
  answersByTurn: string[];
  finalObservedByTurn: boolean[];
  toolCalls: RecordedToolCall[];
  invocations: ChildInvocation[];
  incompleteSessions: string[];
}

interface SessionNode {
  id: string;
  parentId: string;
  depth: number;
}

function collectDescendants(db: DatabaseSync, rootId: string): SessionNode[] {
  const out: SessionNode[] = [];
  let frontier: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }];
  const seen = new Set<string>([rootId]);
  while (frontier.length > 0) {
    const next: Array<{ id: string; depth: number }> = [];
    for (const node of frontier) {
      const rows = db
        .prepare('select id from session_v2 where parent_id = ?')
        .all(node.id) as Array<{ id: string }>;
      for (const r of rows) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        const depth = node.depth + 1;
        out.push({ id: r.id, parentId: node.id, depth });
        next.push({ id: r.id, depth });
      }
    }
    frontier = next;
  }
  return out;
}

function readMessages(db: DatabaseSync, sessionId: string): MessageRow[] {
  return db.prepare('select seq, type, data, time_created, time_updated from session_message where session_id = ? order by seq')
    .all(sessionId) as unknown as MessageRow[];
}

function readTool(
  part: Record<string, unknown>, row: MessageRow, turn: number,
  sessionId: string, parentId: string | null, partIndex: number,
): RecordedToolCall {
  const state = record(part.state);
  const time = record(part.time);
  const metadata = record(state?.metadata);
  const status = String(state?.status ?? 'unknown');
  const exitCode = numberValue(metadata?.exit);
  const toolError = state?.error;
  const successful = status === 'completed' && (exitCode === undefined || exitCode === 0);
  const output = Array.isArray(state?.content) ? textParts(state.content)
    : typeof state?.output === 'string' ? state.output : undefined;
  return {
    name: String(part.name ?? 'unknown'), status, input: record(state?.input) ?? {},
    turn, sessionId, parentId, seq: row.seq, partIndex, exitCode,
    output: successful ? output ?? '' : '',
    outputCaptured: output !== undefined,
    startedAt: numberValue(time?.ran) ?? numberValue(time?.created),
    endedAt: numberValue(time?.completed),
    error: status === 'completed' ? undefined : String(record(toolError)?.message ?? toolError ?? ''),
    childSessionId: typeof metadata?.sessionID === 'string' ? metadata.sessionID : undefined,
  };
}

function messageTurn(rootInputs: readonly MessageRow[], at: number): number {
  const next = rootInputs.findIndex((message: MessageRow): boolean => message.time_created > at);
  return next === -1 ? rootInputs.length : next;
}

/** 直接按会话 ID 采集轨迹（含所有 subagent 子孙会话）。 */
export function collectTrace(db: DatabaseSync, rootId: string | null): RecordedTrace | null {
  if (!rootId) return null;
  const sess = db.prepare('select * from session_v2 where id = ?').get(rootId) as
    | Record<string, unknown>
    | undefined;
  if (!sess) return null;

  const descendants = collectDescendants(db, rootId);
  const toolCalls: RecordedToolCall[] = [];
  const toolErrors: Record<string, number> = {};
  const incompleteSessions = new Set<string>();
  const invocations: ChildInvocation[] = [];
  const rootMessages = readMessages(db, rootId);
  const rootInputs = rootMessages.filter((message: MessageRow): boolean => message.type === 'user');
  const answersByTurn = rootInputs.map((): string => '');
  const finalObservedByTurn = rootInputs.map((): boolean => false);
  const observedAt = Date.now();
  let compactionCount = 0;
  let modelSwitches = 0;

  for (const { id: sid, parentId } of [{ id: rootId, parentId: null }, ...descendants]) {
    const msgs = sid === rootId ? rootMessages : readMessages(db, sid);
    if (parentId) {
      const invocation = initialInvocation(sid, parentId, msgs, observedAt);
      if (invocation) invocations.push(invocation);
    }
    let turnCursor = 0;
    for (const m of msgs) {
      if (m.type === 'user' && sid === rootId) turnCursor += 1;
      if (m.type === 'compaction') compactionCount += 1;
      if (m.type === 'model-switched') modelSwitches += 1;
      if (m.type !== 'assistant') continue;
      const data = parseMessage(m);
      if (!Array.isArray(data?.content)) {
        incompleteSessions.add(sid);
        continue;
      }
      const content: unknown[] = data.content;
      content.forEach((value: unknown, partIndex: number): void => {
        const part = record(value);
        if (part?.type !== 'tool') return;
        const at = numberValue(record(part.time)?.ran) ?? m.time_created;
        const turn = sid === rootId ? turnCursor : messageTurn(rootInputs, at);
        const call = readTool(part, m, turn, sid, parentId, partIndex);
        toolCalls.push(call);
        if (call.status !== 'completed') toolErrors[call.name] = (toolErrors[call.name] ?? 0) + 1;
      });
      if (sid !== rootId || turnCursor === 0) continue;
      const hasTools = content.some((part: unknown): boolean => record(part)?.type === 'tool');
      const completed = numberValue(record(data.time)?.completed);
      const answer = textParts(content);
      const hasFinal = completed !== undefined && !hasTools
        && (data.finish === 'stop' || (data.finish === undefined && answer.trim().length > 0));
      finalObservedByTurn[turnCursor - 1] = hasFinal;
      answersByTurn[turnCursor - 1] = hasFinal ? answer : '';
    }
  }

  const parallel = invocations.some((first: ChildInvocation, index: number): boolean =>
    invocations.slice(index + 1).some((second: ChildInvocation): boolean =>
      first.parentId === second.parentId && hasActiveOverlap([first, second])));

  const created = Number(sess.time_created ?? Date.now());
  const updated = Number(sess.time_updated ?? Date.now());

  return {
    sessionId: rootId,
    turns: rootInputs.length,
    toolCalls,
    toolErrors,
    subagentCount: descendants.length,
    maxAgentDepth: descendants.reduce((acc, d) => Math.max(acc, d.depth), 0),
    subagentsParallel: parallel,
    compactionCount,
    modelSwitches,
    tokensInput: Number(sess.tokens_input ?? 0),
    tokensOutput: Number(sess.tokens_output ?? 0),
    finalText: answersByTurn.at(-1) ?? '',
    answersByTurn,
    finalObservedByTurn,
    invocations,
    incompleteSessions: [...incompleteSessions],
    durationSec: Math.max(0, Math.round((updated - created) / 1000)),
  };
}
