import { DatabaseSync } from 'node:sqlite';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentMessage } from '@apk/contracts';
export type Delivery = Extract<AgentMessage, { kind: 'delivery' }>;
export interface LocalDelivery {
  id: string;
  payload: Delivery;
  status: string;
  browser: { profile: string; pid: number } | null;
  clean: boolean;
}
export class AgentStore {
  readonly db: DatabaseSync;
  constructor(readonly root: string) {
    this.db = new DatabaseSync(join(root, 'agent.sqlite'));
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY,payload TEXT NOT NULL,status TEXT NOT NULL,browser TEXT,clean INTEGER NOT NULL DEFAULT 1); CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY,delivery TEXT NOT NULL,seq INTEGER NOT NULL,body TEXT NOT NULL,sent INTEGER NOT NULL DEFAULT 0,UNIQUE(delivery,seq));',
    );
  }
  deliveries(): LocalDelivery[] {
    return this.db
      .prepare('SELECT * FROM deliveries')
      .all()
      .map((r) => ({
        id: String(r.id),
        payload: JSON.parse(String(r.payload)) as Delivery,
        status: String(r.status),
        browser: r.browser ? JSON.parse(String(r.browser)) : null,
        clean: !!r.clean,
      }));
  }
  add(d: Delivery) {
    this.db
      .prepare(
        'INSERT INTO deliveries (id,payload,status) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING',
      )
      .run(d.deliveryId, JSON.stringify(d), 'RECEIVED');
  }
  status(id: string, status: string, clean?: boolean) {
    this.db
      .prepare('UPDATE deliveries SET status=?,clean=COALESCE(?,clean) WHERE id=?')
      .run(status, clean === undefined ? null : clean ? 1 : 0, id);
  }
  browser(id: string, value: LocalDelivery['browser']) {
    this.db
      .prepare('UPDATE deliveries SET browser=?,clean=? WHERE id=?')
      .run(value ? JSON.stringify(value) : null, value ? 0 : 1, id);
  }
  append(d: Delivery, event: { type: string; taskId?: string; payload: Record<string, unknown> }) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const seq = Number(
        this.db
          .prepare('SELECT COALESCE(MAX(seq),0)+1 AS n FROM outbox WHERE delivery=?')
          .get(d.deliveryId)!.n,
      );
      const body = {
        eventId: randomUUID(),
        runId: d.runId,
        sequence: seq,
        occurredAt: new Date().toISOString(),
        ...event,
      };
      this.db
        .prepare('INSERT INTO outbox(id,delivery,seq,body) VALUES (?,?,?,?)')
        .run(body.eventId, d.deliveryId, seq, JSON.stringify(body));
      this.db.exec('COMMIT');
      return body;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  pending(id: string) {
    const rows = this.db
      .prepare('SELECT body FROM outbox WHERE delivery=? AND sent=0 ORDER BY seq LIMIT 50')
      .all(id);
    let bytes = 0;
    return rows
      .filter((row) => {
        bytes += Buffer.byteLength(String(row.body));
        return bytes < 180000;
      })
      .map((r) => JSON.parse(String(r.body)) as Record<string, unknown>);
  }
  acknowledge(ids: string[]) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of ids) this.db.prepare('UPDATE outbox SET sent=1 WHERE id=?').run(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
export async function openAgentStore(root: string) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  return new AgentStore(resolve(root));
}
async function stamp(pid: number) {
  if (process.platform !== 'linux') return String(pid);
  const text = await readFile('/proc/' + pid + '/stat', 'utf8');
  return text.slice(text.lastIndexOf(')') + 2).split(' ')[19];
}
export async function lockAgent(root: string) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, 'agent.lock'),
    value = { pid: process.pid, stamp: await stamp(process.pid), nonce: randomUUID() };
  for (let i = 0; i < 2; i++) {
    try {
      const file = await open(path, 'wx', 0o600);
      await file.writeFile(JSON.stringify(value));
      await file.close();
      return async () => {
        const current = JSON.parse(await readFile(path, 'utf8'));
        if (current.nonce === value.nonce) await unlink(path);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const old = JSON.parse(await readFile(path, 'utf8')) as typeof value;
      let alive: boolean;
      try {
        process.kill(old.pid, 0);
        alive = (await stamp(old.pid)) === old.stamp;
      } catch (e) {
        if (
          (e as NodeJS.ErrnoException).code === 'ESRCH' ||
          (e as NodeJS.ErrnoException).code === 'ENOENT'
        )
          alive = false;
        else throw e;
      }
      if (alive) throw Error('AGENT_ALREADY_RUNNING', { cause: error });
      await unlink(path);
    }
  }
  throw Error('AGENT_ALREADY_RUNNING');
}
