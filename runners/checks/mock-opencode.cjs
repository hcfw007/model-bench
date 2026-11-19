const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { join } = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--version') {
  console.log('0.0.0-offline-fixture');
  process.exit(0);
}

assert.deepEqual(args.slice(0, 3), ['run', '--auto', '--standalone']);
assert.equal(args.length, 8);
assert.equal(args[3], '--title');
assert.equal(args[5], '-m');
assert.equal(process.cwd(), process.env.PWD);
const [title, modelRef, prompt] = [args[4], args[6], args[7]];
assert.match(title, /l0-02/);
assert.match(modelRef, /^fixture\/(correct|interrupted)#high$/);
const echo = /^reply with exactly: ([\da-f-]+)$/.exec(prompt);
assert.ok(echo);

const rootId = `ses_${randomUUID()}`;
const interrupted = modelRef === 'fixture/interrupted#high';
const db = new DatabaseSync(join(__dirname, 'trace.db'));
const now = Date.now();
db.exec('pragma busy_timeout = 2000; begin immediate');
db.prepare('insert into session_v2 values (?, ?, null, ?, ?, 2, 1)')
  .run(rootId, title, now, now);
db.prepare('insert into fixture_invocation values (?, ?, ?, ?)')
  .run(modelRef, rootId, process.cwd(), process.pid);
const insert = db.prepare('insert into session_message values (?, ?, ?, ?, ?, ?)');
insert.run(rootId, 1, 'user', JSON.stringify({ content: [{ type: 'text', text: prompt }] }), now, now);
const completed = now + 2;
const answer = JSON.stringify({
  time: { created: now + 1, ...(interrupted ? {} : { completed }) },
  ...(interrupted ? {} : { finish: 'stop' }),
  content: [{ type: 'text', text: echo[1] }],
});
insert.run(rootId, 2, 'assistant', answer, now + 1, completed);
db.exec('commit');

if (interrupted) {
  db.close();
  setTimeout(() => process.exit(77), 8000);
} else {
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  const peer = db.prepare("select pid from fixture_invocation where model_ref = 'fixture/interrupted#high'");
  const deadline = Date.now() + 3000;
  while (!peer.get() && Date.now() < deadline) Atomics.wait(waitBuffer, 0, 0, 20);
  const activePeer = peer.get();
  assert.ok(activePeer, 'the other worker did not arrive');
  process.kill(activePeer.pid, 0);
  db.close();
  console.log('This stdout is not the recorded assistant answer.');
}
