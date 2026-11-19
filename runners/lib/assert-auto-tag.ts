import type { AssertResult } from './assert-artifacts.ts';
import { matchedSearch, searchesSubject } from './assert-tool-order.ts';
import type { ToolCall, Trace } from './trace.ts';

const POLL = /\bpoll\.go\b/i;
const CLOSE_JOB = /\bSyncJob\b|FINISHED|收尾|推进.{0,6}完成/i;
const UPDATE_JOB = /\bUpdate\b|更新(?:任务|状态)|只.{0,5}(?:推进|修改|设置).{0,6}状态/i;
const NO_UPDATE = /(?:没有|并未|未曾|未|不曾|不会|不)\s*(?:实际|再|会|去)?\s*(?:调用|执行|做)?\s*(?:repo\.)?(?:Update\b|更新(?:任务|状态))/i;
const MARK_TAG = /\bMarkTag\b/;
const NO_CALL = /零.{0,4}调用|0\s*(?:个|处)?\s*调用|(?:缺少|缺失|缺的是|没有|未见|无|未|从未|没人|不曾)[^。；;]{0,30}(?:调用|接入)|调用(?:方|点|路径)?[^。；;]{0,6}(?:缺失|为空|不存在)|只有.{0,12}(?:接口|定义|实现).{0,12}(?:没有|无).{0,5}调用/;
const OPPOSITE = /(?:群发)?任务完成后\s*(?:(?:确实|已经|会|能)\s*)+(?:自动(?:给.{1,12})?打标|调用(?:\w+\.)?MarkTag)/g;
const TAG_SOURCES = [
  'go-projects/some-service/internal/biz/bulk_send_v1/repo.go',
  'go-projects/some-service/internal/data/crm_repo.go',
];

function field(answer: string, label: string): string[] {
  const line = new RegExp(`^\\s*(?:[-*]\\s+)?${label}\\s*[：:]\\s*(.*)$`);
  return answer.replace(/\*\*|`/g, '').split('\n').flatMap((value: string): string[] => {
    const found = line.exec(value);
    return found ? [found[1].trim()] : [];
  });
}

function contradictory(answer: string): boolean {
  return answer.split(/[。；\n]/).some((clause: string): boolean => {
    for (const match of clause.matchAll(OPPOSITE)) {
      const prefix = clause.slice(0, match.index).trimEnd();
      if (!/(?:不能|无法|不代表|不等于|并非)(?:据此)?(?:说|认为|推断|表明)?\s*[「“]?$/.test(prefix)) return true;
    }
    return false;
  });
}

export function assertAutoTagConclusion(
  answer: string, trace: Trace, worktree: string,
): AssertResult & { missingEvidence?: true } {
  const type = 'autoTagConclusion';
  const conclusion = field(answer, '任务完成后自动打标');
  const poll = field(answer, '完成路径证据');
  const call = field(answer, '调用缺口证据');
  if (conclusion.length !== 1 || !/^未实现[。.]?$/.test(conclusion[0])
    || contradictory(answer.replace(/\*\*|`/g, ''))) {
    return { type, pass: false, detail: `expected one negative outcome, got ${JSON.stringify(conclusion)}` };
  }
  if (poll.length !== 1 || !POLL.test(poll[0]) || !CLOSE_JOB.test(poll[0]) || !UPDATE_JOB.test(poll[0]) || NO_UPDATE.test(poll[0])
    || call.length !== 1 || !MARK_TAG.test(call[0]) || !NO_CALL.test(call[0])) {
    return { type, pass: false, detail: 'missing or repeated task-completion / MarkTag gap evidence' };
  }
  const evidence = trace.toolCalls.some((toolCall: ToolCall): boolean =>
    matchedSearch(toolCall, worktree, TAG_SOURCES, MARK_TAG));
  const unavailable = trace.incompleteSessions?.length || trace.toolCalls.some((toolCall: ToolCall): boolean =>
    (toolCall.output === undefined || toolCall.outputCaptured === false)
    && searchesSubject(toolCall, worktree, TAG_SOURCES, MARK_TAG));
  return {
    type, pass: evidence, detail: evidence ? 'negative outcome and source evidence' : 'no successful source search for MarkTag',
    ...(!evidence && unavailable ? { missingEvidence: true as const } : {}),
  };
}
