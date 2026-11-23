import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { AssertResult } from './assert-artifacts.ts';

interface ReportRow {
  readonly verdict: string;
  readonly method: string;
  readonly evidence: string;
}

const REPORT_PATH = '.tasks/bulk-send-v1/test-report.md';
const CASE_IDS = ['01', '02', '03', '12', '16', '18', '19', '20', '22', '26', '28', '30', '31', '33'] as const;
const VERDICTS = new Set(['PASS', 'FAIL', 'N-A']);
const METHODS = new Set(['执行', '仅代码审查', '未执行', '口径判定']);
const SOURCE_REFERENCE = /\b[\w./-]+\.(?:go|tsx?)\b(?!\.(?:txt|md)\b)/;

function reportText(cell: string): string {
  return cell.trim().replace(/^(?:\*\*|__|`)(.*?)(?:\*\*|__|`)$/, '$1');
}

function parseRow(line: string): [string, ReportRow] | null {
  if (!line.trimStart().startsWith('|')) return null;
  const cells = line.trim().slice(1).replace(/\|$/, '').split(/(?<!\\)\|/).map(reportText);
  const id = cells[0]?.match(/^#(\d{2})$/)?.[1];
  if (!id || cells.length !== 4) return null;
  const [, verdict, method, evidence] = cells;
  return [id, { verdict: verdict === 'N/A' ? 'N-A' : verdict, method, evidence }];
}

export function gradeTestReport(text: string): string | null {
  const rows = new Map<string, ReportRow>();
  for (const line of text.split(/\r?\n/)) {
    const row = parseRow(line);
    if (!row || !CASE_IDS.some((id) => id === row[0])) continue;
    const [id, { verdict, method, evidence }] = row;
    if (rows.has(id)) return `duplicate report row #${id}`;
    if (!VERDICTS.has(verdict) || !METHODS.has(method) || !evidence) return `incomplete report row #${id}`;
    if (verdict === 'PASS' && (method !== '执行' || /^(?:全项)?(?:未执行|未运行|仅代码审查|仅静态检查)/.test(evidence))) {
      return `#${id}: PASS requires runtime evidence`;
    }
    if (verdict === 'FAIL' && (!['执行', '仅代码审查'].includes(method) || !SOURCE_REFERENCE.test(evidence))) {
      return `#${id}: FAIL requires a source reference and an observed failure mode`;
    }
    rows.set(id, row[1]);
  }
  const missing = CASE_IDS.filter((id) => !rows.has(id));
  if (missing.length > 0) return `missing report rows: ${missing.map((id) => `#${id}`).join(', ')}`;
  if (rows.get('18')?.verdict !== 'FAIL') return '#18: expected confirmed auto-tag failure';
  const receiver = rows.get('31');
  if (receiver?.verdict !== 'N-A' || !/(?:未|尚待|等待|不能|不作|不).{0,6}(?:定性|下结论|判定)|待(?:产品|人工|进一步|身份).{0,12}(?:确认|核实|验证|定性)/.test(receiver.evidence)) {
    return '#31: expected N-A and explicitly unresolved classification';
  }
  const card = rows.get('33');
  if (card?.verdict !== 'N-A' || !/非缺陷|不是缺陷|不(?:算|属于|视为|构成)缺陷|(?:不等于|≠)(?:向客户)?发送/.test(card.evidence)) {
    return '#33: expected N-A and the established non-defect classification';
  }
  return null;
}

export function assertTestReport(worktree: string): AssertResult {
  const type = 'testReport';
  try {
    const failure = gradeTestReport(readFileSync(resolve(worktree, REPORT_PATH), 'utf8'));
    return { type, pass: failure === null, detail: failure ?? 'all 14 report rows and required conclusions verified' };
  } catch (error: unknown) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    return { type, pass: false, detail: `missing report ${REPORT_PATH}` };
  }
}
