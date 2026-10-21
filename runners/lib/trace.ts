import { DatabaseSync } from 'node:sqlite';

export interface ToolCall {
  name: string;
  status: string;
  input: Record<string, unknown>;
  /** 该调用发生在第几轮用户输入之后（仅根会话有效，子会话为 -1） */
  turn: number;
  /** 失败时的原始错误信息，用于判定 depth limit 之类的配置问题 */
  error?: string;
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
}

function parseJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

interface SessionNode {
  id: string;
  t0: number;
  t1: number;
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
        .prepare('select id, time_created, time_updated from session_v2 where parent_id = ?')
        .all(node.id) as Array<{ id: string; time_created: number; time_updated: number }>;
      for (const r of rows) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        const depth = node.depth + 1;
        out.push({ id: r.id, t0: r.time_created, t1: r.time_updated, depth });
        next.push({ id: r.id, depth });
      }
    }
    frontier = next;
  }
  return out;
}

/** 直接按会话 ID 采集轨迹（含所有 subagent 子孙会话）。 */
export function collectTrace(db: DatabaseSync, rootId: string | null): Trace | null {
  if (!rootId) return null;
  const sess = db.prepare('select * from session_v2 where id = ?').get(rootId) as
    | Record<string, unknown>
    | undefined;
  if (!sess) return null;

  const descendants = collectDescendants(db, rootId);
  const toolCalls: ToolCall[] = [];
  const toolErrors: Record<string, number> = {};
  let turns = 0;
  let finalText = '';
  let compactionCount = 0;
  let modelSwitches = 0;

  let turnCursor = 0;
  for (const sid of [rootId, ...descendants.map((d) => d.id)]) {
    const msgs = db
      .prepare('select type, data from session_message where session_id = ? order by seq')
      .all(sid) as Array<{ type: string; data: string }>;
    for (const m of msgs) {
      if (m.type === 'user') {
        if (sid === rootId) {
          turnCursor += 1;
          turns += 1;
        }
      }
      if (m.type === 'compaction') compactionCount += 1;
      if (m.type === 'model-switched') modelSwitches += 1;
      if (m.type !== 'assistant') continue;
      const data = parseJson(m.data);
      const content = (data.content as Array<Record<string, unknown>> | undefined) ?? [];
      const texts: string[] = [];
      for (const c of content) {
        if (c.type === 'tool') {
          const state = (c.state as Record<string, unknown> | undefined) ?? {};
          const name = String(c.name ?? 'unknown');
          const status = String(state.status ?? 'unknown');
          const errObj = (state.error as Record<string, unknown> | undefined) ?? {};
          toolCalls.push({
            name,
            status,
            input: (state.input as Record<string, unknown>) ?? {},
            turn: sid === rootId ? turnCursor : -1,
            error: status === 'completed' ? undefined : String(errObj.message ?? ''),
          });
          if (status !== 'completed') toolErrors[name] = (toolErrors[name] ?? 0) + 1;
        } else if (c.type === 'text') {
          texts.push(String(c.text ?? ''));
        }
      }
      if (sid === rootId && texts.length > 0) finalText = texts.join('\n');
    }
  }

  let parallel = false;
  for (let i = 0; i < descendants.length && !parallel; i++) {
    for (let j = i + 1; j < descendants.length; j++) {
      const a = descendants[i];
      const b = descendants[j];
      if (a.t0 < b.t1 && b.t0 < a.t1) {
        parallel = true;
        break;
      }
    }
  }

  const created = Number(sess.time_created ?? Date.now());
  const updated = Number(sess.time_updated ?? Date.now());

  return {
    sessionId: rootId,
    turns,
    toolCalls,
    toolErrors,
    subagentCount: descendants.length,
    maxAgentDepth: descendants.reduce((acc, d) => Math.max(acc, d.depth), 0),
    subagentsParallel: parallel,
    compactionCount,
    modelSwitches,
    tokensInput: Number(sess.tokens_input ?? 0),
    tokensOutput: Number(sess.tokens_output ?? 0),
    finalText,
    durationSec: Math.max(0, Math.round((updated - created) / 1000)),
  };
}
