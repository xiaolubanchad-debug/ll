import { DatabaseSync } from 'node:sqlite';
import { mkdir, open, readFile, unlink, writeFile, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  randomUUID,
  randomBytes,
  randomInt,
  createCipheriv,
  createDecipheriv,
  createHash,
} from 'node:crypto';
import type { AgentMessage, LearnedRegistrationTemplate } from '@apk/contracts';
import { parseFunctionalEvidence } from '@apk/contracts';
import { RegistrationError, validLearnedTemplate } from '@apk/automation';
import type { Account, AndroidRecord } from '@apk/automation';
import { pinyinUsername } from './accounts.js';
export type Delivery = Extract<AgentMessage, { kind: 'delivery' }>;
export interface LocalDelivery {
  id: string;
  payload: Delivery;
  status: string;
  browser: { profile: string; pid: number } | null;
  android: AndroidRecord | null;
  androidSlots: { slot: string; record: AndroidRecord }[];
  clean: boolean;
}
export class AgentStore {
  readonly db: DatabaseSync;
  constructor(
    readonly root: string,
    private readonly key: Buffer,
  ) {
    this.db = new DatabaseSync(join(root, 'agent.sqlite'));
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY,payload TEXT NOT NULL,status TEXT NOT NULL,browser TEXT,clean INTEGER NOT NULL DEFAULT 1); CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY,delivery TEXT NOT NULL,seq INTEGER NOT NULL,body TEXT NOT NULL,sent INTEGER NOT NULL DEFAULT 0,UNIQUE(delivery,seq));',
    );
    if (
      !this.db
        .prepare('PRAGMA table_info(deliveries)')
        .all()
        .some((r) => r.name === 'android')
    )
      this.db.exec('ALTER TABLE deliveries ADD COLUMN android TEXT');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS accounts(task TEXT PRIMARY KEY,delivery TEXT NOT NULL,ref TEXT NOT NULL UNIQUE,sealed BLOB NOT NULL,sent INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS submissions(task TEXT PRIMARY KEY,delivery TEXT NOT NULL,id TEXT NOT NULL UNIQUE,ref TEXT NOT NULL,outcome TEXT); CREATE TABLE IF NOT EXISTS evidence(id TEXT PRIMARY KEY,delivery TEXT NOT NULL,task TEXT NOT NULL,sha TEXT NOT NULL,data TEXT NOT NULL,sent INTEGER NOT NULL DEFAULT 0);',
    );
    if (
      !this.db
        .prepare('PRAGMA table_info(accounts)')
        .all()
        .some((r) => r.name === 'username_hash')
    )
      this.db.exec('ALTER TABLE accounts ADD COLUMN username_hash TEXT');
    this.db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS accounts_username_hash ON accounts(username_hash)',
    );
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS registration_templates (key TEXT PRIMARY KEY,sealed BLOB NOT NULL,used_at INTEGER NOT NULL)',
    );
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS android_slots (delivery TEXT NOT NULL,slot TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(delivery,slot))',
    );
  }
  loadRegistrationTemplate(key: string): LearnedRegistrationTemplate | undefined {
    if (!/^[a-f0-9]{64}$/.test(key)) throw Error('TEMPLATE_KEY_INVALID');
    const row = this.db.prepare('SELECT sealed FROM registration_templates WHERE key=?').get(key);
    if (!row) return undefined;
    try {
      const bytes = Buffer.from(row.sealed as Uint8Array),
        decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from('template:' + key));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const template = JSON.parse(
        Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(),
      );
      if (!validLearnedTemplate(template)) throw Error();
      this.db
        .prepare('UPDATE registration_templates SET used_at=? WHERE key=?')
        .run(Date.now(), key);
      return template;
    } catch {
      this.dropRegistrationTemplate(key);
      return undefined;
    }
  }
  dropRegistrationTemplate(key: string) {
    this.db.prepare('DELETE FROM registration_templates WHERE key=?').run(key);
  }
  saveRegistrationTemplate(key: string, template: LearnedRegistrationTemplate) {
    if (!/^[a-f0-9]{64}$/.test(key) || !validLearnedTemplate(template))
      throw Error('TEMPLATE_INVALID');
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from('template:' + key));
    const bytes = Buffer.concat([cipher.update(JSON.stringify(template)), cipher.final()]),
      sealed = Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          'INSERT INTO registration_templates(key,sealed,used_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET sealed=excluded.sealed,used_at=excluded.used_at',
        )
        .run(key, sealed, Date.now());
      this.db
        .prepare(
          'DELETE FROM registration_templates WHERE key IN (SELECT key FROM registration_templates ORDER BY used_at DESC,key LIMIT -1 OFFSET 2000)',
        )
        .run();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
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
        android: r.android ? JSON.parse(String(r.android)) : null,
        androidSlots: this.androidSlots(String(r.id)),
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
    if (clean) {
      const row = this.db.prepare('SELECT browser,android FROM deliveries WHERE id=?').get(id);
      clean = !!row && !row.browser && !row.android && this.androidSlots(id).length === 0;
    }
    this.db
      .prepare('UPDATE deliveries SET status=?,clean=COALESCE(?,clean) WHERE id=?')
      .run(status, clean === undefined ? null : clean ? 1 : 0, id);
  }
  browser(id: string, value: LocalDelivery['browser']) {
    this.db
      .prepare(
        'UPDATE deliveries SET browser=?,clean=CASE WHEN ? IS NULL AND android IS NULL AND NOT EXISTS(SELECT 1 FROM android_slots WHERE delivery=deliveries.id) THEN 1 ELSE 0 END WHERE id=?',
      )
      .run(value ? JSON.stringify(value) : null, value ? 1 : null, id);
  }
  android(id: string, value: AndroidRecord | null) {
    this.db
      .prepare(
        'UPDATE deliveries SET android=?,clean=CASE WHEN ? IS NULL AND browser IS NULL AND NOT EXISTS(SELECT 1 FROM android_slots WHERE delivery=deliveries.id) THEN 1 ELSE 0 END WHERE id=?',
      )
      .run(value ? JSON.stringify(value) : null, value ? 1 : null, id);
  }
  androidSlots(id: string): { slot: string; record: AndroidRecord }[] {
    return this.db
      .prepare('SELECT slot,record FROM android_slots WHERE delivery=? ORDER BY slot')
      .all(id)
      .map((r) => ({
        slot: String(r.slot),
        record: JSON.parse(String(r.record)) as AndroidRecord,
      }));
  }
  androidSlot(id: string, slot: string, value: AndroidRecord | null) {
    if (!/^[a-f0-9-]{36}$/.test(slot)) throw Error('ANDROID_SLOT_INVALID');
    if (value)
      this.db
        .prepare(
          'INSERT INTO android_slots(delivery,slot,record) VALUES(?,?,?) ON CONFLICT(delivery,slot) DO UPDATE SET record=excluded.record',
        )
        .run(id, slot, JSON.stringify(value));
    else this.db.prepare('DELETE FROM android_slots WHERE delivery=? AND slot=?').run(id, slot);
    this.db
      .prepare(
        'UPDATE deliveries SET clean=CASE WHEN browser IS NULL AND android IS NULL AND NOT EXISTS(SELECT 1 FROM android_slots WHERE delivery=deliveries.id) THEN 1 ELSE 0 END WHERE id=?',
      )
      .run(id);
  }
  private appendRow(
    d: Delivery,
    event: { type: string; taskId?: string; payload: Record<string, unknown> },
  ) {
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
    return body;
  }
  account(delivery: Delivery, task: string): Account {
    let row = this.db.prepare('SELECT * FROM accounts WHERE task=?').get(task);
    if (!row) {
      const letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
        chars = letters + '0123456789';
      const generate = (alphabet: string, n: number) =>
        Array.from({ length: n }, () => alphabet[randomInt(alphabet.length)]).join('');
      let password: string;
      do {
        password = generate(chars, randomInt(8, 13));
      } while (!/[0-9]/.test(password) || !/[a-zA-Z]/.test(password));
      let username: string, usernameHash: string;
      let candidates = 0;
      do {
        if (++candidates > 1000) throw new RegistrationError('ACCOUNT_NAME_POOL_EXHAUSTED');
        username = pinyinUsername();
        usernameHash = createHash('sha256').update(username).digest('hex');
      } while (this.db.prepare('SELECT 1 FROM accounts WHERE username_hash=?').get(usernameHash));
      const account: Account = {
        accountRef: randomUUID(),
        username,
        password,
      };
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', this.key, iv);
      cipher.setAAD(Buffer.from(task));
      const bytes = Buffer.concat([cipher.update(JSON.stringify(account)), cipher.final()]);
      this.db
        .prepare('INSERT INTO accounts(task,delivery,ref,sealed,username_hash) VALUES(?,?,?,?,?)')
        .run(
          task,
          delivery.deliveryId,
          account.accountRef,
          Buffer.concat([iv, cipher.getAuthTag(), bytes]),
          usernameHash,
        );
      row = this.db.prepare('SELECT * FROM accounts WHERE task=?').get(task)!;
    }
    if (row.delivery !== delivery.deliveryId) throw Error('ACCOUNT_CONFLICT');
    const bytes = Buffer.from(row.sealed as Uint8Array),
      cipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(task));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString(),
    ) as Account;
  }
  pendingAccounts(d: Delivery) {
    return this.db
      .prepare('SELECT task FROM accounts WHERE delivery=? AND sent=0')
      .all(d.deliveryId)
      .map((r) => ({ taskId: String(r.task), ...this.account(d, String(r.task)) }));
  }
  accountAck(ref: string) {
    this.db.prepare('UPDATE accounts SET sent=1 WHERE ref=?').run(ref);
  }
  intent(d: Delivery, taskId: string, accountRef: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const account = this.db
        .prepare('SELECT * FROM accounts WHERE task=? AND delivery=? AND ref=? AND sent=1')
        .get(taskId, d.deliveryId, accountRef);
      if (!account) throw Error('ACCOUNT_SYNC_FAILED');
      const submissionId = randomUUID();
      this.db
        .prepare('INSERT INTO submissions(task,delivery,id,ref) VALUES(?,?,?,?)')
        .run(taskId, d.deliveryId, submissionId, accountRef);
      this.appendRow(d, {
        type: 'SUBMISSION_INTENT',
        taskId,
        payload: { submissionId, accountRef },
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  submissions(id: string) {
    return this.db
      .prepare('SELECT task,id,ref FROM submissions WHERE delivery=?')
      .all(id)
      .map((r) => ({
        taskId: String(r.task),
        submissionId: String(r.id),
        accountRef: String(r.ref),
      }));
  }
  evidence(d: Delivery, task: string, bytes: Buffer) {
    if (bytes.length > 65536 || !parseFunctionalEvidence(bytes.toString('utf8')))
      throw new RegistrationError('CONTENT_ISOLATION_REQUIRED');
    const id = randomUUID(),
      sha = createHash('sha256').update(bytes).digest('hex');
    this.db
      .prepare('INSERT INTO evidence(id,delivery,task,sha,data) VALUES(?,?,?,?,?)')
      .run(id, d.deliveryId, task, sha, bytes.toString('base64'));
    return id;
  }
  pendingEvidence(id: string) {
    return this.db
      .prepare('SELECT id,task,sha,data FROM evidence WHERE delivery=? AND sent=0')
      .all(id);
  }
  evidenceAck(id: string) {
    this.db.prepare('UPDATE evidence SET sent=1 WHERE id=?').run(id);
  }
  append(d: Delivery, event: { type: string; taskId?: string; payload: Record<string, unknown> }) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const body = this.appendRow(d, event);
      if (event.type === 'TASK_FINISHED' && event.taskId && event.payload.status !== 'UNKNOWN')
        this.db
          .prepare('UPDATE submissions SET outcome=? WHERE task=? AND delivery=?')
          .run(String(event.payload.status), event.taskId, d.deliveryId);
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
  const keyPath = join(root, 'account.key');
  let key: Buffer;
  try {
    key = await readFile(keyPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    key = randomBytes(32);
    await writeFile(keyPath, key, { flag: 'wx', mode: 0o600 });
  }
  if (key.length !== 32) throw Error('ACCOUNT_KEY_INVALID');
  const store = new AgentStore(resolve(root), key);
  await chmod(join(root, 'agent.sqlite'), 0o600);
  return store;
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
