import { deepStrictEqual, rejects, strictEqual } from 'node:assert/strict';

import { pool } from '../lib/model-pool.ts';

export async function runModelPoolTests(): Promise<void> {
  const specs = [
    'kiro/one', 'kiro/two', 'openai/one', 'openai/two',
    'mimo/one', 'volc-a/one', 'volc-c/one', 'kiro/three', 'mimo/two',
  ].map((model, index) => ({ id: `alias-${index}`, model }));
  const starts: number[] = [];
  const active = new Map<number, () => void>();
  const running = pool(specs, 5, (spec, index): Promise<void> => {
    strictEqual(spec, specs[index]);
    starts.push(index);
    return new Promise<void>((resolve) => active.set(index, resolve));
  });

  async function finish(index: number): Promise<void> {
    const release = active.get(index);
    if (!release) throw new Error(`worker ${index} is not active`);
    active.delete(index);
    release();
    await Promise.resolve();
  }

  deepStrictEqual(starts, [0, 2, 4, 5, 6]);
  await finish(6);
  deepStrictEqual(starts, [0, 2, 4, 5, 6, 1]);
  await finish(5);
  deepStrictEqual(starts, [0, 2, 4, 5, 6, 1, 3]);
  await finish(0);
  deepStrictEqual(starts, [0, 2, 4, 5, 6, 1, 3, 7]);
  await finish(4);
  deepStrictEqual(starts, [0, 2, 4, 5, 6, 1, 3, 7, 8]);
  strictEqual(active.size, 5);
  for (const index of [...active.keys()]) await finish(index);
  await running;

  const serialStarts: number[] = [];
  await pool(specs, 1, async (_spec, index): Promise<void> => { serialStarts.push(index); });
  deepStrictEqual(serialStarts, specs.map((_spec, index) => index));

  const unexpectedTask = async (): Promise<void> => { throw new Error('unexpected task'); };
  await pool([], 5, unexpectedTask);
  for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await rejects(pool(specs, invalid, unexpectedTask), RangeError);
  }
  const sameProvider = [specs[0], specs[1], specs[7]];
  const recoveredStarts: number[] = [];
  const failed = pool(sameProvider, 2, async (_spec, index): Promise<void> => {
    recoveredStarts.push(index);
    if (index === 0) await unexpectedTask();
  });
  deepStrictEqual(recoveredStarts, [0, 1]);
  await rejects(failed, /unexpected task/);
  deepStrictEqual(recoveredStarts, [0, 1, 2]);
}
