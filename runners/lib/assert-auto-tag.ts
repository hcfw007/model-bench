import type { AssertResult } from './assert-artifacts.ts';
import { matchedSearch, readsTarget, searchesSubject, shellNegativeSearch, toolSucceeded } from './assert-tool-order.ts';
import type { ToolCall, Trace } from './trace.ts';

const POLL = /\bpoll\.go\b/i;
const CLOSE_JOB = /\bSyncJob\b|FINISHED|收尾|推进.{0,6}完成/i;
const UPDATE_JOB = /\bUpdate\b|更新(?:任务|状态)|只.{0,5}(?:推进|修改|设置).{0,6}状态/i;
const NO_UPDATE = /(?:没有|并未|未曾|未|不曾|不会|不)\s*(?:实际|再|会|去)?\s*(?:调用|执行|做)?\s*(?:repo\.)?(?:Update\b|更新(?:任务|状态))/i;
const MARK_TAG = /\bMarkTag\b/i;
const NO_CALL = /零.{0,4}调用|0\s*(?:个|处)?\s*调用|(?:缺少|缺失|没有|未见|无|未|从未|没人|不曾)[^。；;，,]{0,30}(?:调用|接入)|调用(?:方|点|路径|次数)?\s*(?:为\s*)?(?:零|0\b|缺失|为空|不存在)/;
const DENIES_OTHER_CALLERS = /(?:\bSentExternalIDs(?:\(\))?|\bHasMarkTag(?:\(\))?)[^。；;\n]{0,65}(?:同样|也|均|都)?(?:无|没有|不存在)(?:任何)?调用(?:方|点)?/;
const OPPOSITE = /(?:群发)?任务完成后\s*(?:(?:确实|已经|会|能)\s*)+(?:自动(?:给.{1,12})?打标|调用(?:\w+\.)?MarkTag)/g;
const POSITIVE_PATH_CALL = /(?:SyncJob|(?:任务)?完成路径|收尾(?:阶段)?)\s*(?:(?:中|里)\s*)?(?:(?:确实|已经|会|仍|直接|只)\s*)*调用(?:了)?\s*(?:\w+\.)*MarkTag\b/gi;
const TAG_SOURCES = [
  'go-projects/some-service/internal/biz/bulk_send_v1/repo.go',
  'go-projects/some-service/internal/data/crm_repo.go',
];
const FINISH_SOURCE = 'go-projects/some-service/internal/biz/bulk_send_v1/poll.go';
const COMPLETION_ROOT = 'go-projects/some-service';
const CALL_QUERY = /(?:^|\|)(?:\(\?i\))?\\\.MarkTag(?:\\b|(?:\\s[+*?]?)?\\\()\s*(?:$|\|)/i;
const LIST_PREFIX = /^(?:(?:[-*+]|\d{1,2}[.)、]|[①-⑳])\s*)/;

function field(answer: string, label: string): string[] {
  const line = new RegExp(`^${label}\\s*[：:]\\s*(.*)$`);
  return answer.replace(/\*\*|`/g, '').split(/\r?\n/).flatMap((value: string): string[] => {
    const found = line.exec(value.trim().replace(LIST_PREFIX, ''));
    return found ? [found[1].trim()] : [];
  });
}

function checkedCompletionSource(call: ToolCall, worktree: string): boolean {
  return toolSucceeded(call) && call.outputCaptured !== false && readsTarget(call, worktree, FINISH_SOURCE)
    && /\bfunc\s+\([^)]*\)\s+SyncJob\(/.test(call.output ?? '')
    && /\bjob\.Status\s*=\s*JobStatusFinished\b/.test(call.output ?? '')
    && /\breturn\s+\w+\.repo\.Update\(/.test(call.output ?? '');
}

function searchedCalls(call: ToolCall, worktree: string): boolean {
  const scopes = ['.', 'go-projects', COMPLETION_ROOT];
  const shell = shellNegativeSearch(call, worktree);
  if (shell) return call.status === 'completed' && call.exitCode === 1
    && CALL_QUERY.test(shell.query) && scopes.includes(shell.scope);
  if (call.name !== 'grep' || !toolSucceeded(call) || !CALL_QUERY.test(String(call.input.pattern ?? ''))) return false;
  const path = String(call.input.path ?? '.').replace(/^\/private\/var\//, '/var/');
  const root = worktree.replace(/^\/private\/var\//, '/var/').replace(/\/+$/, '');
  const scope = (path === root ? '.' : path.replace(`${root}/`, '')).replace(/^\.\//, '').replace(/\/+$/, '') || '.';
  const include = call.input.include;
  return scopes.includes(scope)
    && (include === undefined || ['*.go', '**/*.go'].includes(String(include)));
}

function negativeCallSearch(call: ToolCall, worktree: string): boolean {
  if (!searchedCalls(call, worktree) || call.outputCaptured === false || call.output === undefined) return false;
  return call.name === 'grep' ? /^No matches found\.?$/i.test(call.output.trim())
    : /^(?:\(no output\))?$/.test(call.output.trim());
}

function contradictory(answer: string): boolean {
  return answer.split(/[。；\n]/).some((clause: string): boolean => {
    for (const match of [...clause.matchAll(OPPOSITE), ...clause.matchAll(POSITIVE_PATH_CALL)]) {
      const prefix = clause.slice(0, match.index).trimEnd();
      if (!/(?:不能|无法|不代表|不等于|并非)(?:据此)?(?:说|认为|推断|表明|证明|断定)?\s*[「“]?$/.test(prefix)) return true;
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
    || call.length !== 1 || !MARK_TAG.test(call[0]) || !NO_CALL.test(call[0]) || DENIES_OTHER_CALLERS.test(call[0])) {
    return { type, pass: false, detail: 'missing or repeated task-completion / MarkTag gap evidence' };
  }
  const positive = trace.toolCalls.some((toolCall: ToolCall): boolean =>
    matchedSearch(toolCall, worktree, TAG_SOURCES, MARK_TAG));
  const negative = trace.toolCalls.some((toolCall: ToolCall): boolean => negativeCallSearch(toolCall, worktree))
    && trace.toolCalls.some((toolCall: ToolCall): boolean => checkedCompletionSource(toolCall, worktree));
  const evidence = positive || negative;
  const unavailable = trace.incompleteSessions?.length || trace.toolCalls.some((toolCall: ToolCall): boolean =>
    (toolCall.output === undefined || toolCall.outputCaptured === false)
    && (searchesSubject(toolCall, worktree, TAG_SOURCES, MARK_TAG) || searchedCalls(toolCall, worktree)));
  return {
    type, pass: evidence, detail: positive ? 'negative outcome and MarkTag source match'
      : negative ? 'negative call search and verified completion source' : 'no verifiable MarkTag source or call search',
    ...(!evidence && unavailable ? { missingEvidence: true as const } : {}),
  };
}
