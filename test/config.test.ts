/** config.ts：jsonc 剥离、home 展开、配置加载与模型档位引用。 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { expandHome, loadConfig, resolveModelRef, stripJsonc } from '../runners/lib/config.ts';

test('stripJsonc：去掉整行注释与尾逗号', () => {
  const parsed: unknown = JSON.parse(stripJsonc(`{
    // 顶层注释
    "a": 1,
    "b": [1, 2,],
  }`));
  assert.deepEqual(parsed, { a: 1, b: [1, 2] });
});

test('stripJsonc：行尾注释是已知边界，解析直接失败', () => {
  assert.throws(() => JSON.parse(stripJsonc('{\n  "a": 1 // 尾注释\n}')));
});

test('expandHome：只展开 ~\/ 前缀', () => {
  assert.equal(expandHome('~/db.sqlite'), resolve(homedir(), 'db.sqlite'));
  assert.equal(expandHome('/abs/db.sqlite'), '/abs/db.sqlite');
  assert.equal(expandHome('rel/db.sqlite'), 'rel/db.sqlite');
});

test('loadConfig：dbPath 展开 home，其余路径相对配置文件解析', () => {
  const dir = mkdtempSync(join(tmpdir(), 'model-bench-config-'));
  writeFileSync(join(dir, 'bench.config.jsonc'), JSON.stringify({
    bench: {
      name: 'x', version: '1.1.0', opencodeBin: 'opencode',
      dbPath: '~/.local/share/opencode/opencode.db',
      mockRepo: './mockrepo', worktreeRoot: './wt', reportsDir: './reports',
    },
  }));
  const cfg = loadConfig(join(dir, 'bench.config.jsonc'));
  assert.equal(cfg.bench.dbPath, resolve(homedir(), '.local/share/opencode/opencode.db'));
  assert.equal(cfg.bench.mockRepo, resolve(dir, 'mockrepo'));
  assert.equal(cfg.bench.worktreeRoot, resolve(dir, 'wt'));
  assert.equal(cfg.bench.reportsDir, resolve(dir, 'reports'));
});

test('resolveModelRef：普通引用原样返回，{file:} 引用读档位文件', () => {
  assert.equal(resolveModelRef('openai/gpt-6.2-sol'), 'openai/gpt-6.2-sol');
  const dir = mkdtempSync(join(tmpdir(), 'model-bench-ref-'));
  const tier = join(dir, 'pro');
  writeFileSync(tier, '  mimo/mimo-v2.6-pro\n');
  assert.equal(resolveModelRef(`{file:${tier}}`), 'mimo/mimo-v2.6-pro');
  assert.throws(() => resolveModelRef(`{file:${join(dir, 'missing')}}`));
});
