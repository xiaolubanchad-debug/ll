import { randomUUID, randomInt, createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { readFile, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Prisma, PrismaClient, TestRecord } from '@prisma/client';
import type {
  TestBootstrapInput,
  TestBootstrap,
  TestEnrollInput,
  TestEnrollResult,
  TestDataPage,
  TestDataQuery,
  TestDataCredentials,
  TestClientInfo,
  TestConfiguration,
} from '@apk/contracts';
import { checked } from './secrets.js';
import { digest, canonical, masterKey, encrypt, decrypt } from './security.js';
import { boundDelivery, ACTIVE_RUNS } from './runs.js';
import { lockNode } from './nodes.js';
import { fault } from './errors.js';

export const TEST_CLIENT_PACKAGE = 'com.apkplatform.testclient';
const tokenFor = (taskId: string, deliveryId: string, fence: number) =>
  createHmac('sha256', masterKey())
    .update('test-client-v1\0' + taskId + '\0' + deliveryId + '\0' + fence)
    .digest('base64url');
const apiOrigin = () => {
  const u = new URL(process.env.APP_ORIGIN ?? '');
  if (
    u.protocol !== 'https:' &&
    !(u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname))
  )
    fault('TEST_CLIENT_UNAVAILABLE', '测试客户端地址尚未配置', 503);
  return u.origin;
};
function credentials(row: TestRecord) {
  return decrypt(row.encrypted, 'test-data:' + row.id) as TestDataCredentials;
}
function result(row: TestRecord): TestEnrollResult {
  const account = credentials(row);
  return checked<TestEnrollResult>('TestEnrollResult', {
    id: row.id,
    username: row.username,
    password: account.password,
    sourceIp: row.sourceIp,
    createdAt: row.createdAt.toISOString(),
  });
}
export async function testClientArtifact(sha?: string) {
  const root = resolve(process.env.TEST_CLIENT_ROOT ?? '/var/lib/apk-hub/test-client');
  const current = JSON.parse(await readFile(join(root, 'current.json'), 'utf8')) as {
    sha256?: string;
    version?: string;
  };
  const key = sha ?? current.sha256;
  if (!key || !/^[a-f0-9]{64}$/.test(key))
    fault('TEST_CLIENT_UNAVAILABLE', '测试 APK 尚未发布', 503);
  const file = join(root, key + '.apk'),
    info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 10485760)
    fault('TEST_CLIENT_UNAVAILABLE', '测试 APK 未通过校验', 503);
  const bytes = await readFile(file);
  if (digest(bytes) !== key) fault('TEST_CLIENT_UNAVAILABLE', '测试 APK 未通过校验', 503);
  return { bytes, sha256: key, version: current.version ?? '1.0.0' };
}
export async function testClientInfo(): Promise<TestClientInfo> {
  const origin = apiOrigin(),
    base = {
      packageName: TEST_CLIENT_PACKAGE,
      downloadUrl: origin + '/api/v1/test-client/apk',
      sourcePageUrl: origin + '/api/v1/test-client',
    };
  try {
    const a = await testClientArtifact();
    return checked('TestClientInfo', {
      ...base,
      ready: true,
      downloadUrl: base.downloadUrl + '?sha256=' + a.sha256,
      sourcePageUrl: base.sourcePageUrl + '?sha256=' + a.sha256,
      sha256: a.sha256,
      version: a.version,
    });
  } catch {
    return checked('TestClientInfo', { ...base, ready: false, sha256: null, version: null });
  }
}
export async function issueTestBootstrap(
  db: PrismaClient,
  token: string,
  taskId: string,
  body: unknown,
): Promise<TestBootstrap> {
  const input = checked<TestBootstrapInput>('TestBootstrapInput', body);
  return db.$transaction(async (tx) => {
    const d = await boundDelivery(tx, token, input.nodeId, input.deliveryId, input.fence);
    const task = await tx.task.findUnique({ where: { id: taskId } });
    const config = d.run.configVersionId
      ? await tx.configVersion.findUnique({ where: { id: d.run.configVersionId } })
      : null;
    const c = config?.body as unknown as TestConfiguration | undefined;
    if (
      !task ||
      task.runId !== d.runId ||
      !d.acceptedAt ||
      d.leaseExpiresAt.getTime() <= Date.now() ||
      !ACTIVE_RUNS.includes(d.run.status as (typeof ACTIVE_RUNS)[number]) ||
      d.run.stopRequested ||
      !['INSTALLING', 'LAUNCHING'].includes(task.status) ||
      !c?.execution.appOpen?.ownedTestClient
    )
      fault('TEST_CLIENT_SCOPE', '本轮不允许初始化测试客户端', 409);
    const apk = task.apk as { packageName?: string; apkSha256?: string } | null;
    if (apk?.packageName !== TEST_CLIENT_PACKAGE || !apk.apkSha256)
      fault('TEST_CLIENT_SCOPE', '只允许已发布的自有测试 APK', 422);
    await testClientArtifact(apk.apkSha256);
    const observation = task.observation as {
      model?: string;
      profileId?: string;
      variantId?: string;
    } | null;
    if (!observation?.model || !/^[A-Za-z0-9 _.-]{1,100}$/.test(observation.model))
      fault('TEST_CLIENT_SCOPE', '缺少可核对的设备型号', 409);
    const derived = tokenFor(taskId, d.id, d.fence),
      expectedUa = 'ApkPlatformTest/1.0 (Android; ' + observation.model + '; ' + taskId + ')';
    const enrollment = await tx.testEnrollment.upsert({
      where: { taskId },
      create: {
        taskId,
        nodeId: input.nodeId,
        deliveryId: d.id,
        fence: d.fence,
        tokenHash: digest(derived),
        expectedUa,
        model: observation.model,
        profileId: observation.variantId ?? observation.profileId ?? 'unknown',
        expiresAt: new Date(Date.now() + 15 * 60000),
      },
      update: {},
    });
    if (enrollment.tokenHash !== digest(derived) || enrollment.expiresAt.getTime() <= Date.now())
      fault('TEST_TOKEN_EXPIRED', '本轮测试凭据已失效', 410);
    return checked<TestBootstrap>('TestBootstrap', {
      apiUrl: apiOrigin() + '/api/v1/test-data/enroll',
      token: derived,
      profileId: enrollment.profileId,
      expectedModel: enrollment.model,
      userAgent: enrollment.expectedUa,
      expiresAt: enrollment.expiresAt.toISOString(),
    });
  });
}
export async function enrollTestClient(
  db: PrismaClient,
  token: string,
  body: unknown,
  observedIp: string,
  userAgent: string,
): Promise<TestEnrollResult> {
  const input = checked<TestEnrollInput>('TestEnrollInput', body);
  const ip = observedIp.startsWith('::ffff:') ? observedIp.slice(7) : observedIp;
  if (
    !/^[-_A-Za-z0-9]{43}$/.test(token) ||
    !isIP(ip) ||
    /^0+$/.test(input.androidId) ||
    !/^[ -~]{1,512}$/.test(userAgent)
  )
    fault('TEST_REQUEST_INVALID', '测试请求无效', 422);
  const auth = await db.testEnrollment.findUnique({ where: { tokenHash: digest(token) } });
  if (!auth) fault('TEST_TOKEN_INVALID', '测试凭据无效', 401);
  return db.$transaction(async (tx) => {
    await lockNode(tx, auth.nodeId);
    await tx.$queryRawUnsafe(
      'SELECT "id" FROM "TestEnrollment" WHERE "id"=$1::uuid FOR UPDATE',
      auth.id,
    );
    const e = await tx.testEnrollment.findUniqueOrThrow({
      where: { id: auth.id },
      include: { record: true, task: { include: { run: true } } },
    });
    if (e.expiresAt.getTime() <= Date.now()) fault('TEST_TOKEN_EXPIRED', '测试凭据已过期', 410);
    const contentHash = digest(canonical({ ...input, observedUserAgent: userAgent }));
    if (e.record) {
      if (
        e.record.installationId !== input.installationId ||
        e.record.requestKey !== input.requestKey ||
        e.record.requestHash !== contentHash
      )
        fault('TEST_IDEMPOTENCY_CONFLICT', '测试凭据已绑定其他安装或内容', 409);
      return result(e.record);
    }
    const delivery = await tx.delivery.findUnique({ where: { id: e.deliveryId } });
    const slot = await tx.nodeSlot.findUnique({ where: { nodeId: e.nodeId } });
    if (
      !slot ||
      slot.quarantined ||
      slot.runId !== e.task.runId ||
      slot.fence !== e.fence ||
      !delivery ||
      delivery.fence !== e.fence ||
      delivery.leaseExpiresAt.getTime() <= Date.now() ||
      !ACTIVE_RUNS.includes(e.task.run.status as (typeof ACTIVE_RUNS)[number]) ||
      e.task.run.stopRequested ||
      !['LAUNCHING', 'HOLDING'].includes(e.task.status)
    )
      fault('TEST_RUN_STOPPED', '本轮已停止或执行权已失效', 409);
    const id = randomUUID(),
      seed = createHmac('sha256', masterKey())
        .update('test-username-v1\0' + ip + '\0' + input.androidId + '\0' + input.installationId)
        .digest();
    const username =
      'ce' + Array.from(seed.subarray(0, 8), (b) => String.fromCharCode(97 + (b % 26))).join('');
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const chars = ['abcdefghijklmnopqrstuvwxyz'[randomInt(26)], '0123456789'[randomInt(10)]];
    while (chars.length < 10) chars.push(alphabet[randomInt(alphabet.length)]);
    for (let i = chars.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    const account = { username, password: chars.join(''), androidId: input.androidId };
    const row = await tx.testRecord.create({
      data: {
        id,
        enrollmentId: e.id,
        installationId: input.installationId,
        requestKey: input.requestKey,
        requestHash: contentHash,
        username,
        sourceIp: ip,
        androidIdHash: digest(input.androidId),
        model: input.model,
        manufacturer: input.manufacturer,
        apiLevel: input.apiLevel,
        userAgent,
        defaultWebViewUa: input.defaultWebViewUa,
        uaMatched: userAgent === input.declaredUserAgent && userAgent === e.expectedUa,
        modelMatched: input.model === e.model,
        encrypted: encrypt(account, 'test-data:' + id) as unknown as Prisma.InputJsonValue,
      },
    });
    return result(row);
  });
}
export async function testDataPage(db: PrismaClient, query: unknown): Promise<TestDataPage> {
  const q = checked<TestDataQuery>('TestDataQuery', query),
    limit = Number(q.limit ?? 20);
  const scope = {
    ...(q.nodeId ? { nodeId: q.nodeId } : {}),
    ...(q.runId ? { task: { runId: q.runId } } : {}),
  };
  const cursor = q.cursor
    ? await db.testRecord.findFirst({ where: { id: q.cursor, enrollment: scope } })
    : null;
  if (q.cursor && !cursor) fault('STALE_CURSOR', '分页已失效，请刷新', 409);
  const rows = await db.testRecord.findMany({
    where: {
      enrollment: scope,
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    },
    include: {
      enrollment: { include: { task: { include: { run: { include: { node: true } } } } } },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });
  return checked<TestDataPage>('TestDataPage', {
    items: rows.slice(0, limit).map((r) => ({
      id: r.id,
      nodeId: r.enrollment.nodeId,
      nodeName: r.enrollment.task.run.node.name,
      runId: r.enrollment.task.runId,
      taskId: r.enrollment.taskId,
      position: r.enrollment.task.position + 1,
      username: r.username,
      sourceIp: r.sourceIp,
      androidIdHash: r.androidIdHash,
      model: r.model,
      manufacturer: r.manufacturer,
      apiLevel: r.apiLevel,
      userAgent: r.userAgent,
      defaultWebViewUa: r.defaultWebViewUa,
      profileId: r.enrollment.profileId,
      uaMatched: r.uaMatched,
      modelMatched: r.modelMatched,
      createdAt: r.createdAt.toISOString(),
    })),
    nextCursor: rows.length > limit ? rows[limit - 1].id : null,
  });
}
export async function viewTestCredentials(
  db: PrismaClient,
  id: string,
  body: unknown,
  adminId: string,
  requestId: string,
): Promise<TestDataCredentials> {
  const input = checked<{ reason: string }>('AccountViewInput', body);
  return db.$transaction(async (tx) => {
    const row = await tx.testRecord.findUnique({ where: { id } });
    if (!row) fault('NOT_FOUND', '测试记录不存在', 404);
    await tx.auditEvent.create({
      data: {
        adminId,
        requestId,
        action: 'TEST_CREDENTIALS_VIEWED',
        details: { testRecordId: id, reason: input.reason },
      },
    });
    return checked<TestDataCredentials>('TestDataCredentials', credentials(row));
  });
}
