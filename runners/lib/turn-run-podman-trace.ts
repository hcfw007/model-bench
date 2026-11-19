import { DatabaseSync } from 'node:sqlite';

import { collectTrace, type Trace } from './trace.ts';

// Evaluated using the image's Node; the host never opens the model-writable SQLite file.
export const READ_CONTAINER_TRACE = `
import { DatabaseSync } from 'node:sqlite';
const [sessionId, title] = process.argv.slice(1);
const db = new DatabaseSync('/model-home/.local/share/opencode/opencode.db', { readOnly: true });
try {
  db.exec('pragma trusted_schema = off; pragma busy_timeout = 1000; begin');
  const root = sessionId || db.prepare(
    'select id from session_v2 where title = ? and parent_id is null order by time_created desc limit 1'
  ).get(title)?.id;
  const sessions = root ? db.prepare(\`
    with recursive subtree(id) as (
      select id from session_v2 where id = ?
      union select sess.id from session_v2 sess join subtree on sess.parent_id = subtree.id
    )
    select id, title, parent_id, time_created, time_updated, tokens_input, tokens_output from session_v2
    where id in (select id from subtree) limit 257
  \`).all(root) : [];
  if (sessions.length > 256) throw new Error('trace session limit exceeded');
  const messages = db.prepare(
    'select session_id, seq, type, data, time_created, time_updated from session_message where session_id = ? order by seq limit 10001'
  );
  const rows = [];
  let size = Buffer.byteLength(JSON.stringify(sessions));
  for (const { id } of sessions) {
    for (const row of messages.iterate(id)) {
      size += Buffer.byteLength(JSON.stringify(row)) + 1;
      if (rows.length >= 10000 || size > 900_000) throw new Error('trace message limit exceeded');
      rows.push(row);
    }
  }
  process.stdout.write(JSON.stringify({ root: root ?? null, sessions, rows }));
} finally {
  db.close();
}
`;

interface TraceRows {
  readonly root: string | null;
  readonly sessions: Array<{
    id: string; title: string; parent_id: string | null; time_created: number;
    time_updated: number; tokens_input: number; tokens_output: number;
  }>;
  readonly rows: Array<{
    session_id: string; seq: number; type: string; data: string; time_created: number; time_updated: number;
  }>;
}

export function readContainerTrace(payload: string): Trace | null {
  const { root, sessions, rows } = JSON.parse(payload) as TraceRows;
  if (!root) return null;
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      create table session_v2 (id text primary key, title text, parent_id text, time_created integer,
        time_updated integer, tokens_input integer, tokens_output integer);
      create table session_message (session_id text, seq integer, type text, data text, time_created integer, time_updated integer);
    `);
    const session = db.prepare('insert into session_v2 values (?, ?, ?, ?, ?, ?, ?)');
    const message = db.prepare('insert into session_message values (?, ?, ?, ?, ?, ?)');
    for (const row of sessions) {
      session.run(row.id, row.title, row.parent_id, row.time_created, row.time_updated, row.tokens_input, row.tokens_output);
    }
    for (const row of rows) {
      message.run(row.session_id, row.seq, row.type, row.data, row.time_created, row.time_updated);
    }
    return collectTrace(db, root);
  } finally {
    db.close();
  }
}
