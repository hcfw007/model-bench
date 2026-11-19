/** 正式 v1.1 成绩发布；v1.0 档案仅供读取。 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { replaceRanking, rankingTable } from './lib/protocol-publish.ts';
import { verifyReleaseEvidence } from './lib/protocol-evidence.ts';
import { publicationScores } from './lib/protocol-results.ts';
import { readRunResults } from './lib/report.ts';

const [directory, ...options] = process.argv.slice(2);
let evidenceDir: string | undefined;
const seen = new Set<string>();
for (let index = 0; index < options.length; index += 2) {
  const [flag, value] = options.slice(index, index + 2);
  if (!value || value.startsWith('--') || seen.has(flag)) throw new Error(`无效发布参数: ${flag}`);
  seen.add(flag);
  if (flag === '--evidence') evidenceDir = value;
  else if (flag !== '--version' || value !== 'v1.1') throw new Error('旧榜只读，发布版本只接受 v1.1');
}
if (!directory || directory.startsWith('--')) throw new Error('usage: node runners/sync-rankings.ts <formalRunDir> [--version v1.1] [--evidence <evidenceDir>]');

const root = resolve(import.meta.dirname, '..');
const runDir = resolve(root, directory);
const data = readRunResults(runDir);
const scores = publicationScores(data);
verifyReleaseEvidence(data.protocol, evidenceDir ? resolve(root, evidenceDir) : resolve(runDir, 'release-evidence'));
const date = data.meta.finishedAt?.slice(0, 10);
if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('无有效运行完成日期');
const banner = `<!-- PROTOCOL:v1.1 ${data.protocol.digest} -->`;
const count = data.protocol.manifest.cases.length;
const zh = rankingTable(scores, count, date, true);
const en = rankingTable(scores, count, date, false);
const patches = [
  { file: 'README.md', body: `${banner}\n${zh}`, quote: true },
  { file: 'README.en.md', body: `${banner}\n${en}`, quote: true },
  { file: 'rankings/v1.1.md', body: `${banner}\n${zh}\n\n总分按未舍入值排序，真同分并列。`, quote: false },
].map(({ file, body, quote }) => {
  const path = resolve(root, file);
  return { path, file, contents: replaceRanking(readFileSync(path, 'utf8'), body, quote) };
});

for (const { file, path, contents } of patches) {
  writeFileSync(path, contents);
  console.log(`updated: ${file}`);
}
