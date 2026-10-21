/**
 * 对失败的 case 做根因分析：从 opencode.db 拉完整轨迹，输出可读摘要。
 *
 * 用法：
 *   node runners/analyze.ts reports/<dir>                 # 全部分失败项
 *   node runners/analyze.ts reports/<dir> l1-05           # 只分析某个 case
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from './lib/config.ts';
import type { CaseResult } from './lib/score.ts';

const [, , dirArg, caseFilter] = process.argv;
if (!dirArg) {
  console.error('usage: node runners/analyze.ts reports/<dir> [caseId]');
  process.exit(1);
}

const root = resolve(import.meta.dirname, '..');
const cfg = loadConfig(resolve(root, 'bench.config.jsonc'));
const data = JSON.parse(readFileSync(resolve(root, dirArg, 'results.json'), 'utf8')) as {
  results: CaseResult[];
};

const failed = data.results.filter((r) => !r.pass && (!caseFilter || r.caseId.includes(caseFilter)));
if (failed.length === 0) {
  console.log('没有匹配的失败项');
  process.exit(0);
}

const db = new DatabaseSync(cfg.bench.dbPath, { readOnly: true });

// 历史结果用的是本地别名，按官方 id 反查时也要能命中
const LEGACY: Record<string, string> = {
  'kiro/claude-opus-5-5': 'pro-opus',
  'kiro/claude-sonnet-5-5': 'flash-sonnet',
  'openai/gpt-6.1-sol': 'gpt61',
  'openai/gpt-6-astra': 'gpt6astra',
  'volc/glm-5.3': 'glm53',
  'volc/glm-5.3-flash': 'glm53flash',
  'volc/deepseek-v4.1-flash': 'ds41flash',
};

function findSession(r: CaseResult): string | null {
  if (r.sessionId) return r.sessionId;
  const candidates = [r.modelId, LEGACY[r.modelId]].filter(Boolean) as string[];
  for (const m of candidates) {
    const row = db
      .prepare("select id from session_v2 where title like ? order by time_created desc limit 1")
      .get(`bench ${r.caseId} ${m}%`) as { id: string } | undefined;
    if (row?.id) return row.id;
  }
  return null;
}

interface Msg {
  type: string;
  data: string;
}

function parse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const out: string[] = ['# 失败根因分析\n'];
for (const r of failed) {
  out.push(`## ${r.modelId} / ${r.caseId}\n`);
  out.push('**失败断言**\n');
  for (const a of r.assertions.filter((x) => !x.pass)) {
    out.push(`- \`${a.type}\` — ${a.detail}`);
  }
  out.push('');

  const sid = findSession(r);
  if (!sid) {
    out.push('> 未找到对应会话，无法还原轨迹\n');
    continue;
  }

  const msgs = db
    .prepare('select type, data from session_message where session_id = ? order by seq')
    .all(sid) as Msg[];

  const tools: string[] = [];
  const answers: string[] = [];
  const userMsgs: string[] = [];

  for (const m of msgs) {
    if (m.type === 'user') {
      const t = String(parse(m.data).text ?? '');
      if (t) userMsgs.push(t.slice(0, 120));
      continue;
    }
    if (m.type !== 'assistant') continue;
    const d = parse(m.data);
    for (const c of (d.content as Array<Record<string, unknown>> | undefined) ?? []) {
      if (c.type === 'tool') {
        const st = (c.state as Record<string, unknown> | undefined) ?? {};
        const name = String(c.name ?? '?');
        const input = (st.input as Record<string, unknown> | undefined) ?? {};
        const hint = String(input.filePath ?? input.pattern ?? input.command ?? '').slice(0, 70);
        tools.push(`${name}${hint ? `(${hint})` : ''}${st.status !== 'completed' ? ' ✗' : ''}`);
      } else if (c.type === 'text') {
        answers.push(String(c.text ?? ''));
      }
    }
  }

  out.push(`**用户请求**\n`);
  for (const u of userMsgs) out.push(`- ${u}`);
  out.push('');

  out.push(`**工具调用序列**（${tools.length} 次）\n`);
  out.push('```');
  out.push(tools.slice(0, 40).join('\n'));
  if (tools.length > 40) out.push(`... 另外 ${tools.length - 40} 次`);
  out.push('```\n');

  const final = answers.filter(Boolean).join('\n').slice(-1500);
  out.push(`**模型最终回答（末尾 1500 字）**\n`);
  out.push('```');
  out.push(final || '(无文本输出)');
  out.push('```\n');
}

db.close();
const outPath = resolve(root, dirArg, 'ANALYSIS.md');
writeFileSync(outPath, out.join('\n'));
console.log(outPath);
