import type { DatabaseSync } from 'node:sqlite';

import {
  contentPart, hasActiveOverlap, initialInvocation, numberValue, parseRecord, record, textParts,
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

interface StoredMessage {
  readonly session_id: string;
  readonly seq: number;
  readonly type: string;
  readonly data: unknown;
  readonly time_created: number;
  readonly time_updated: number;
  readonly part_ordinal: number | null;
  readonly part_type: string | null;
  readonly part_data: unknown;
}

const SESSION_TREE = `with recursive tree(id, parent_id, depth) as (
  select id, null, 0 from session_v2 where id = $rootId
  union all
  select child.id, child.parent_id, tree.depth + 1
  from tree join session_v2 child on child.parent_id = tree.id where child.id <> $rootId
)`;

function collectDescendants(db: DatabaseSync, rootId: string): SessionNode[] {
  return db.prepare(`${SESSION_TREE}
    select id, parent_id as parentId, depth from tree where depth > 0 order by depth, id`)
    .all({ $rootId: rootId }) as unknown as SessionNode[];
}

function readContent(
  rows: readonly StoredMessage[], data: Record<string, unknown>, hasPartTable: boolean,
): MessageRow['content'] {
  const content = rows[0].part_ordinal !== null
    ? rows.map((row: StoredMessage, index: number): ReturnType<typeof contentPart> => {
      const part = contentPart(parseRecord(row.part_data));
      return row.part_ordinal === index && part?.type === row.part_type ? part : undefined;
    })
    // In the split schema, [] without part rows does not prove that the reply was empty.
    : Array.isArray(data.content) && (!hasPartTable || data.content.length > 0)
      ? data.content.map(contentPart) : undefined;
  if (!content) return undefined;
  return content.every((part): part is Record<string, unknown> => part !== undefined) ? content : undefined;
}

function readMessages(db: DatabaseSync, rootId: string): Map<string, MessageRow[]> {
  const hasPartTable = db.prepare("select 1 from sqlite_schema where type = 'table' and name = 'session_part'").get() !== undefined;
  const [ordinal, type, data] = hasPartTable ? ['p.ordinal', 'p.type', 'p.data'] : ['null', 'null', 'null'];
  const join = hasPartTable
    ? "left join session_part p on p.session_id = m.session_id and p.message_id = m.id and m.type = 'assistant'"
    : '';
  const rows = db.prepare(`${SESSION_TREE}
    select m.session_id, m.seq, m.type, m.data, m.time_created, m.time_updated,
      ${ordinal} as part_ordinal, ${type} as part_type, ${data} as part_data
    from tree join session_message m on m.session_id = tree.id ${join}
    order by m.session_id, m.seq, part_ordinal`).all({ $rootId: rootId }) as unknown as StoredMessage[];

  const messages = new Map<string, MessageRow[]>();
  let index = 0;
  while (index < rows.length) {
    const row = rows[index];
    let next = index + 1;
    while (rows[next]?.session_id === row.session_id && rows[next].seq === row.seq) next += 1;
    const entries = messages.get(row.session_id) ?? [];
    const data = row.type === 'assistant' ? parseRecord(row.data) : undefined;
    entries.push({ seq: row.seq, type: row.type, time_created: row.time_created, time_updated: row.time_updated,
      data, content: data ? readContent(rows.slice(index, next), data, hasPartTable) : undefined });
    messages.set(row.session_id, entries);
    index = next;
  }
  return messages;
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
  const messages = readMessages(db, rootId);
  const rootMessages = messages.get(rootId) ?? [];
  const rootInputs = rootMessages.filter((message: MessageRow): boolean => message.type === 'user');
  const answersByTurn = rootInputs.map((): string => '');
  const finalObservedByTurn = rootInputs.map((): boolean => false);
  const observedAt = Date.now();
  let compactionCount = 0;
  let modelSwitches = 0;

  for (const { id: sid, parentId } of [{ id: rootId, parentId: null }, ...descendants]) {
    const msgs = messages.get(sid) ?? [];
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
      const { data, content } = m;
      if (!data || !content) {
        incompleteSessions.add(sid);
        if (sid === rootId && turnCursor > 0) {
          finalObservedByTurn[turnCursor - 1] = false;
          answersByTurn[turnCursor - 1] = '';
        }
        continue;
      }
      content.forEach((part: Record<string, unknown>, partIndex: number): void => {
        if (part.type !== 'tool') return;
        const at = numberValue(record(part.time)?.ran) ?? m.time_created;
        const turn = sid === rootId ? turnCursor : messageTurn(rootInputs, at);
        const call = readTool(part, m, turn, sid, parentId, partIndex);
        toolCalls.push(call);
        if (call.status !== 'completed') toolErrors[call.name] = (toolErrors[call.name] ?? 0) + 1;
      });
      if (sid !== rootId || turnCursor === 0) continue;
      const hasTools = content.some((part: Record<string, unknown>): boolean => part.type === 'tool');
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
