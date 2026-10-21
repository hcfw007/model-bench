/**
 * 拆解一次会话的耗时：模型生成 vs 工具执行 vs 未解释间隔。
 * 用于判断超时是「请求慢」还是「想太久」。
 *
 * 用法：node runners/latency.ts <caseId> <modelId>
 */
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from './lib/config.ts';

const [, , caseId, modelId] = process.argv;
if (!caseId || !modelId) {
  console.error('usage: node runners/latency.ts <caseId> <modelId>');
  process.exit(1);
}

const root = resolve(import.meta.dirname, '..');
const cfg = loadConfig(resolve(root, 'bench.config.jsonc'));
const db = new DatabaseSync(cfg.bench.dbPath, { readOnly: true });

const row = db
  .prepare('select id, time_created, time_updated from session_v2 where title like ? order by time_created desc limit 1')
  .get(`bench ${caseId} ${modelId}%`) as { id: string; time_created: number; time_updated: number } | undefined;
if (!row) {
  console.error('session not found');
  process.exit(1);
}

interface Msg { seq: number; type: string; data: string }
const msgs = db
  .prepare('select seq, type, data from session_message where session_id = ? order by seq')
  .all(row.id) as Msg[];

function parse(s: string): Record<string, unknown> {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
}

let modelMs = 0;
let toolMs = 0;
let reasoningChars = 0;
const events: Array<{ kind: string; name: string; ms: number; think: number }> = [];

let prevEnd = 0;
let gapMs = 0;

for (const m of msgs) {
  if (m.type !== 'assistant') continue;
  const d = parse(m.data);
  const t = (d.time as Record<string, number> | undefined) ?? {};
  const created = Number(t.created ?? 0);
  const streamed = Number(t.streamed ?? t.completed ?? created);

  if (prevEnd > 0 && created > prevEnd) gapMs += created - prevEnd;

  const contents = (d.content as Array<Record<string, unknown>> | undefined) ?? [];
  let think = 0;
  const toolNames: string[] = [];
  for (const c of contents) {
    if (c.type === 'reasoning') think += String(c.text ?? '').length;
    if (c.type === 'tool') toolNames.push(String(c.name ?? '?'));
  }

  const gen = streamed - created;
  modelMs += gen;
  reasoningChars += think;

  // tool 执行耗时
  let toolDur = 0;
  for (const c of contents) {
    if (c.type !== 'tool') continue;
    const st = (c.state as Record<string, unknown> | undefined) ?? {};
    const tt = (st.time as Record<string, number> | undefined) ?? {};
    if (tt.created && tt.completed) toolDur += Number(tt.completed) - Number(tt.created);
  }
  toolMs += toolDur;

  events.push({
    kind: toolNames.length > 0 ? `tool:${toolNames.join('+')}` : 'answer',
    name: toolNames.join(','),
    ms: gen,
    think,
  });
  prevEnd = Number(t.completed ?? streamed);
}

const total = row.time_updated - row.time_created;
const pct = (n: number) => `${((n / total) * 100).toFixed(0)}%`;

console.log(`\n${caseId} / ${modelId}`);
console.log(`会话总时长      ${(total / 1000).toFixed(0)}s`);
console.log(`模型生成        ${(modelMs / 1000).toFixed(0)}s  (${pct(modelMs)})`);
console.log(`工具执行        ${(toolMs / 1000).toFixed(0)}s  (${pct(toolMs)})`);
console.log(`未解释间隔      ${(gapMs / 1000).toFixed(0)}s  (${total > 0 ? ((gapMs / total) * 100).toFixed(0) : 0}%)`);
console.log(`reasoning 字符  ${reasoningChars.toLocaleString()}`);
console.log(`消息数          ${events.length}`);

const slow = [...events].sort((a, b) => b.ms - a.ms).slice(0, 6);
console.log('\n最慢的 6 次生成：');
for (const e of slow) {
  console.log(`  ${(e.ms / 1000).toFixed(1)}s  ${e.kind}  (思考 ${e.think} 字)`);
}

const avg = modelMs / Math.max(1, events.length);
console.log(`\n平均每次生成 ${(avg / 1000).toFixed(1)}s；平均思考 ${Math.round(reasoningChars / Math.max(1, events.length))} 字`);

db.close();
