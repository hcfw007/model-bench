import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { assertTrajectory } from './lib/assert-trajectory.ts';
import { collectTrace } from './lib/trace.ts';

interface HistoricalResult {
  readonly caseId: string;
  readonly modelId: string;
  readonly sessionId?: string;
  readonly answer?: string;
  readonly assertions: readonly { readonly type: string; readonly pass: boolean }[];
}

interface ReplayRow {
  readonly caseId: string;
  readonly modelId: string;
  readonly rule: string;
  readonly old: boolean;
  readonly replay: boolean | null;
  readonly evidence: string;
}

interface TraceRule {
  readonly caseFile: string;
  readonly oldRule: string;
  readonly newRule: string;
  readonly relevantTools: readonly string[];
  readonly promptDigests: readonly string[];
}

const TRACE_RULES: Readonly<Record<string, TraceRule>> = {
  'l1-04': {
    caseFile: 'l1/l1-04-search-before-read.json',
    oldRule: 'toolSequence',
    newRule: 'toolOrder',
    relevantTools: ['grep', 'glob', 'read', 'shell', 'bash'],
    promptDigests: [
      'caf71ff532aa8d42afa2b7b710a41cba943ef24d2bca703e28a8aec057e29370',
      '0444e501423cd4795f2920690d96d63632e5b05d207f2aa675099568a2dfb561',
    ],
  },
  'l1-10': {
    caseFile: 'l1/l1-10-convention-reuse.json',
    oldRule: 'toolSequence',
    newRule: 'toolOrder',
    relevantTools: ['grep', 'glob', 'shell', 'bash', 'edit', 'patch', 'apply_patch', 'write', 'multiedit', 'multi_edit'],
    promptDigests: [
      '19cd00364aa9fc5183db052794b4c70d495766ec62c549828ba76971bfc26a1a',
      '59f302c062a7a77a3dbbd1c8ba85620bd42479cf11af6428d83f7bdef17cbd49',
    ],
  },
  'l3-01': {
    caseFile: 'l3/l3-01-fanout-parallel.json',
    oldRule: 'subagents',
    newRule: 'subagents',
    relevantTools: ['subagent', 'task', 'Task'],
    promptDigests: [
      'bcc4b00bf942af4172d9dcd7916462d0c807a8a80147bb846d673d0fffcd6f87',
      '657e7ebfdca04b47b31884e45899ea366f52d7134c9a12b650948ec2dd0dfa0c',
    ],
  },
};

const AUTO_TAG_PROMPTS = [
  'd593618e5e66e77f67f2c92b32cd669326a062e3a9c845743bbc844eccef63e7',
  '7e73a7dd05a21cdfec613aebea917e1b3bcc545ee452a50179895c070cb3adff',
];

const AUTO_TAG_REVIEWS: Readonly<Record<string, number>> = {
  '1c2f0a67dd76fb893fdc107cca878074a96f8c7dbba8d76d40783fb2141a44da': 142,
  '021148880027c1c7ff13c8b6ccf403fbfba85109c1e27d39666d6f3f1dd8bb8b': 107,
  'e33a48845c26cd7bb3f94dd7330d5314e2338f7722fdcb24472aa6d4cd5026e8': 50,
};

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function assessment(
  result: HistoricalResult, rule: string, old: boolean, replay: boolean | null, evidence: string,
): ReplayRow {
  return { caseId: result.caseId, modelId: result.modelId, rule, old, replay, evidence };
}

function withRecordedRoot(
  db: DatabaseSync, row: HistoricalResult, promptDigests: readonly string[],
): { id: string; directory: string } | undefined {
  if (!row.sessionId) return undefined;
  const root = db.prepare('select directory from session_v2 where id = ? and parent_id is null')
    .get(row.sessionId) as { directory: string } | undefined;
  if (!root) return undefined;
  const messages = db.prepare("select data from session_message where session_id = ? and type = 'user'")
    .all(row.sessionId) as { data: string }[];
  const last = db.prepare('select type from session_message where session_id = ? order by seq desc limit 1')
    .get(row.sessionId);
  if (messages.length !== 1 || last?.type !== 'idle') return undefined;
  const prompt: unknown = JSON.parse(messages[0].data)?.text;
  if (typeof prompt !== 'string' || !promptDigests.includes(digest(prompt))) return undefined;
  return { id: row.sessionId, directory: root.directory };
}

function replayAutoTag(db: DatabaseSync, row: HistoricalResult, old: boolean): ReplayRow {
  const rule = 'textMatch → 历史命题核对';
  const root = withRecordedRoot(db, row, AUTO_TAG_PROMPTS);
  if (!root) return assessment(row, rule, old, null, '缺可关联的完整根会话或题面不一致');
  const trace = collectTrace(db, root.id);
  const answer = trace?.answersByTurn[0];
  if (trace?.incompleteSessions.includes(root.id) || !answer || answer !== row.answer) {
    return assessment(row, rule, old, null, '根会话终答不完整或与旧结果不一致');
  }
  const hash = digest(answer);
  const messageSeq = AUTO_TAG_REVIEWS[hash];
  if (messageSeq === undefined) {
    return assessment(row, rule, old, null, '旧题未要求结构化字段；此答复没有单独命题复核');
  }
  return assessment(row, rule, old, true,
    `人工核对：收尾自动打标未实现，已实现指配置保存；终答 seq=${messageSeq} sha256=${hash}`);
}

function replayTraceRule(
  db: DatabaseSync, row: HistoricalResult, old: boolean, rule: TraceRule,
): ReplayRow {
  const root = withRecordedRoot(db, row, rule.promptDigests);
  if (!root) return assessment(row, rule.oldRule, old, null, '缺可关联的完整根会话或题面不一致');
  const trace = collectTrace(db, root.id);
  if (!trace || trace.incompleteSessions.length) {
    return assessment(row, rule.oldRule, old, null, '原始事件不完整');
  }
  const caseDef = JSON.parse(readFileSync(new URL(`../cases/${rule.caseFile}`, import.meta.url), 'utf8')) as {
    assertions: Record<string, unknown>[];
  };
  const candidates = caseDef.assertions.filter((entry: Record<string, unknown>): boolean =>
    entry.type === rule.newRule && (entry.type !== 'subagents' || Array.isArray(entry.tasks)));
  if (candidates.length !== 1) throw new Error(`Ambiguous replay rule for ${row.caseId}`);
  const result = assertTrajectory(candidates[0], {
    worktree: root.directory, trace, answer: '', startedAt: 0, forbidden: [],
  });
  if (!result) throw new Error(`Unsupported replay rule for ${row.caseId}`);
  const order = trace.toolCalls.filter((call): boolean =>
    call.sessionId === root.id && rule.relevantTools.includes(call.name));
  const sequences = [...new Set(order.map((call): number => call.seq))];
  return assessment(row, `${rule.oldRule} → ${result.type}`, old, result.missingEvidence ? null : result.pass,
    `${result.detail}；根会话相关事件：${sequences.map((seq): string =>
      `${seq}:${order.filter((call): boolean => call.seq === seq).map((call): string => call.name).join('+')}`).join(',') || '无'}`);
}

function replay(db: DatabaseSync | undefined, rows: readonly HistoricalResult[]): ReplayRow[] {
  return rows.flatMap((row: HistoricalResult): ReplayRow[] => {
    const traceRule = TRACE_RULES[row.caseId];
    const output = row.assertions.flatMap(({ type, pass }): ReplayRow[] => {
      if (type === 'diffFiles' || type === 'diffLines') {
        return [assessment(row, type, pass, null, '归档无预置后的基线树和终态树')];
      }
      if (row.caseId === 'l1-05' && type === 'textMatch') {
        return [db ? replayAutoTag(db, row, pass) : assessment(row, type, pass, null, '未提供只读 SQLite 原始轨迹')];
      }
      if (type === traceRule?.oldRule) {
        return [db ? replayTraceRule(db, row, pass, traceRule) : assessment(row, type, pass, null, '未提供只读 SQLite 原始轨迹')];
      }
      return [];
    });
    if (row.caseId === 'l1-10') {
      const legacyPredicate = row.assertions.find(({ type }): boolean => type === 'cmd');
      if (legacyPredicate) output.push(assessment(row, 'cmd[0] → diffAddedText', legacyPredicate.pass,
        null, '旧断言只见当时未暂存差分，缺冻结的基线与终态'));
    }
    return output;
  });
}

function main(args: readonly string[]): void {
  const [source, database] = args;
  if (!source || args.length > 2) {
    throw new Error('Usage: node runners/replay-v1.1.ts <results.json | -> [opencode.db]');
  }
  const data = JSON.parse(readFileSync(source === '-' ? 0 : source, 'utf8')) as { results?: HistoricalResult[] };
  if (!Array.isArray(data.results)) throw new Error('Missing historical results array');
  const db = database ? new DatabaseSync(
    database.startsWith('~/') ? join(homedir(), database.slice(2)) : database, { readOnly: true },
  ) : undefined;
  try {
    process.stdout.write(`${JSON.stringify(replay(db, data.results), null, 2)}\n`);
  } finally {
    db?.close();
  }
}

main(process.argv.slice(2));
