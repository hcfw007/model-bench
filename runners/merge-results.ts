/** 用同一冻结协议的补槽记录更新主运行，保留每一条被替换的原结果。 */
import { resolve } from 'node:path';

import { mergeRepair } from './lib/protocol-results.ts';
import { readRunResults, writeFinalReports } from './lib/report.ts';

const [, , baseArg, overlayArg] = process.argv;
if (!baseArg || !overlayArg) throw new Error('usage: node runners/merge-results.ts <baseDir> <repairDir>');

const root = resolve(import.meta.dirname, '..');
const baseDir = resolve(root, baseArg);
const overlayDir = resolve(root, overlayArg);
if (baseDir === overlayDir) throw new Error('主运行与补槽运行不能相同');

const base = readRunResults(baseDir);
const overlay = readRunResults(overlayDir);
const merged = mergeRepair(base, overlay);
const { excluded } = writeFinalReports(baseDir, merged);
console.log(`已记录 ${overlay.results.length} 个补槽结果；未入排行模型 ${excluded.length} 个。`);
