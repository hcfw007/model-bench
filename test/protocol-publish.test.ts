/** protocol-publish.ts：榜单表格渲染与 README RANKING 锚点替换。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { rankingTable, replaceRanking } from '../runners/lib/protocol-publish.ts';
import type { ModelScore } from '../runners/lib/score.ts';

function modelScore(over: Partial<ModelScore>): ModelScore {
  return {
    modelId: 'bench/x', total: 0, layers: [], cases: 0, passed: 0,
    violations: 0, turns: 0, tokens: 0, durationSec: 0, ...over,
  };
}

const SCORES = [
  modelScore({ modelId: 'bench/b', total: 86.84, exactTotal: '2171/25' }),
  modelScore({ modelId: 'bench/a', total: 92.5, exactTotal: '185/2' }),
];

test('rankingTable：中英文表头与名次行', () => {
  assert.equal(rankingTable(SCORES, 33, '2026-11-25', true), [
    '| # | 模型 | 总分 |',
    '|---|---|---|',
    '| 1 | `bench/a` | **92.5** |',
    '| 2 | `bench/b` | **86.8** |',
    '',
    '33 个用例 · 2026-11-25',
  ].join('\n'));
  const en = rankingTable(SCORES, 33, '2026-11-25', false);
  assert.ok(en.includes('| # | Model | Score |'));
  assert.ok(en.includes('33 cases · 2026-11-25'));
});

const PLAIN = [
  '# 标题',
  '<!-- RANKING:START -->',
  '旧内容',
  '<!-- RANKING:END -->',
  '尾部不动',
].join('\n');

test('replaceRanking：非引用锚点整段替换，段外保留', () => {
  assert.equal(replaceRanking(PLAIN, '新榜单', false), [
    '# 标题',
    '<!-- RANKING:START -->',
    '新榜单',
    '<!-- RANKING:END -->',
    '尾部不动',
  ].join('\n'));
});

test('replaceRanking：引用锚点给正文加 > 前缀，空行变 >', () => {
  const source = ['> <!-- RANKING:START -->', '> 旧', '> <!-- RANKING:END -->'].join('\n');
  assert.equal(replaceRanking(source, '第一行\n\n第二行', true), [
    '> <!-- RANKING:START -->',
    '> 第一行',
    '>',
    '> 第二行',
    '> <!-- RANKING:END -->',
  ].join('\n'));
});

test('replaceRanking：CRLF 文档保持换行风格', () => {
  const source = ['a', '<!-- RANKING:START -->', '旧', '<!-- RANKING:END -->'].join('\r\n');
  assert.equal(replaceRanking(source, '新', false), ['a', '<!-- RANKING:START -->', '新', '<!-- RANKING:END -->'].join('\r\n'));
});

test('replaceRanking：锚点缺失、倒置或重复都拒绝', () => {
  const bad = /标准 RANKING 锚点缺失、重复或与归档块交叉/;
  assert.throws(() => replaceRanking('无锚点', '新', false), bad);
  assert.throws(() => replaceRanking(['<!-- RANKING:END -->', '<!-- RANKING:START -->'].join('\n'), '新', false), bad);
  assert.throws(
    () => replaceRanking([
      '<!-- RANKING:START -->', '旧', '<!-- RANKING:END -->',
      '<!-- RANKING:START -->', '旧', '<!-- RANKING:END -->',
    ].join('\n'), '新', false),
    bad,
  );
});

test('replaceRanking：与归档块交叉拒绝，归档块在锚点外不受影响', () => {
  const bad = /标准 RANKING 锚点缺失、重复或与归档块交叉/;
  const unclosed = [
    '<!-- ARCHIVED:v1.0:START -->', '档案',
    '<!-- RANKING:START -->', '旧', '<!-- RANKING:END -->',
  ].join('\n');
  assert.throws(() => replaceRanking(unclosed, '新', false), bad);
  const inside = [
    '<!-- RANKING:START -->', '<!-- ARCHIVED:v1.0:START -->', '旧', '<!-- RANKING:END -->',
  ].join('\n');
  assert.throws(() => replaceRanking(inside, '新', false), bad);

  const archived = [
    '<!-- RANKING:START -->', '旧', '<!-- RANKING:END -->',
    '<!-- ARCHIVED:v1.0:START -->', 'v1.0 档案', '<!-- ARCHIVED:v1.0:END -->',
  ].join('\n');
  assert.equal(replaceRanking(archived, '新', false), [
    '<!-- RANKING:START -->', '新', '<!-- RANKING:END -->',
    '<!-- ARCHIVED:v1.0:START -->', 'v1.0 档案', '<!-- ARCHIVED:v1.0:END -->',
  ].join('\n'));
});
