import { rankScores, type ModelScore } from './score.ts';

export function rankingTable(scores: ModelScore[], count: number, date: string, chinese: boolean): string {
  const rows = rankScores(scores).map(({ rank, score }) => `| ${rank} | \`${score.modelId}\` | **${score.total.toFixed(1)}** |`);
  return [chinese ? '| # | 模型 | 总分 |' : '| # | Model | Score |', '|---|---|---|', ...rows,
    '', chinese ? `${count} 个用例 · ${date}` : `${count} cases · ${date}`].join('\n');
}

export function replaceRanking(source: string, body: string, quoted: boolean): string {
  const start = quoted ? '> <!-- RANKING:START -->' : '<!-- RANKING:START -->';
  const end = quoted ? '> <!-- RANKING:END -->' : '<!-- RANKING:END -->';
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(newline);
  const first = lines.indexOf(start);
  const last = lines.indexOf(end);
  const activeArchives = new Set<string>();
  for (const line of lines.slice(0, Math.max(0, first))) {
    const marker = line.match(/<!-- ARCHIVED:([^:]+):(START|END) -->/);
    if (marker?.[2] === 'START') activeArchives.add(marker[1]);
    else if (marker?.[2] === 'END') activeArchives.delete(marker[1]);
  }
  if (first < 0 || last <= first || lines.lastIndexOf(start) !== first || lines.lastIndexOf(end) !== last
    || activeArchives.size > 0 || lines.slice(first + 1, last).some((line) => line.includes('<!-- ARCHIVED:'))) {
    throw new Error('标准 RANKING 锚点缺失、重复或与归档块交叉');
  }
  const bodyLines = body.split('\n').map((line) => quoted ? (line ? `> ${line}` : '>') : line);
  return [...lines.slice(0, first + 1), ...bodyLines, ...lines.slice(last)].join(newline);
}
