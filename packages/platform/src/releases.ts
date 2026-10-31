import { createPublicKey, verify } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { readdir } from 'node:fs/promises';
import type { PrismaClient, Prisma } from '@prisma/client';
import type { ReleaseInput } from '@apk/contracts';
import { checked } from './secrets.js';
import { canonical, digest } from './security.js';
import { fault } from './errors.js';
import { t as listArchive } from 'tar';
export function releasePayload(manifest: ReleaseInput) {
  const { signature: _, ...rest } = manifest;
  void _;
  return canonical(rest);
}
export function validManifest(body: unknown): ReleaseInput {
  const m = checked<ReleaseInput>('ReleaseInput', body);
  if (
    m.features?.includes('DEVICE_SESSIONS_V1') &&
    (!['0.13.0', '0.13.1'].includes(m.agentVersion) ||
      [
        'DEVICE_VARIANTS_V1',
        'APP_OPEN_V1',
        'APP_OPEN_PARALLEL_V1',
        'REGISTRATION_V1',
        'CONTENT_ISOLATION_V1',
        'APP_READINESS_V1',
      ].some(
        (feature) => !m.features?.includes(feature as NonNullable<typeof m.features>[number]),
      ) ||
      !m.toolchain.extraSystemImages ||
      new Set(m.toolchain.extraSystemImages.map((a) => a.apiLevel)).size !== 5)
  )
    fault('RELEASE_INVALID', '多 APP 发布必须包含固定多版本系统镜像', 422);
  if (
    m.artifactName !== `agent-${m.sha256}.tgz` ||
    new Set(m.toolchain.archives.map((a) => a.role)).size !== 4
  )
    fault('RELEASE_INVALID', '构件清单不一致', 422);
  for (const a of m.toolchain.archives) {
    const u = new URL(a.url);
    if (
      u.hostname !== 'dl.google.com' ||
      u.pathname.includes('..') ||
      u.username ||
      u.password ||
      u.search ||
      u.hash
    )
      fault('RELEASE_INVALID', '工具来源无效', 422);
  }
  return m;
}
export function artifactPath(name: string) {
  if (!/^agent-[a-f0-9]{64}\.tgz$/.test(name)) fault('RELEASE_INVALID', '构件名称无效', 422);
  return join(resolve(process.env.RELEASE_DIR ?? 'data/releases'), name);
}
export async function verifyRelease(body: unknown) {
  const manifest = validManifest(body);
  try {
    const publicKey = createPublicKey(
      await readFile(resolve(process.env.RELEASE_PUBLIC_KEY_FILE ?? ''), 'utf8'),
    );
    if (
      !verify(
        null,
        Buffer.from(releasePayload(manifest)),
        publicKey,
        Buffer.from(manifest.signature, 'base64'),
      )
    )
      throw Error();
    const file = artifactPath(manifest.artifactName);
    const info = await stat(file);
    if (!info.isFile() || info.size > 50 * 1024 * 1024) throw Error();
    if (digest(await readFile(file)) !== manifest.sha256) throw Error();
    const expected = new Set([
      'agent.js',
      'boot-check.js',
      'npm/package.json',
      'npm/package-lock.json',
    ]);
    const seen = new Set<string>();
    if (manifest.features?.includes('DOWNLOAD_V1')) expected.add('egress.js');
    if (manifest.features?.includes('AUTO_REGISTRATION_V1')) expected.add('ocr-worker.js');
    if (manifest.features?.includes('DEVICE_VARIANTS_V1')) expected.add('identity-images.js');
    let invalid = false;
    const lockChunks: Buffer[] = [];
    await listArchive({
      file,
      onentry: (entry) => {
        if (entry.type === 'Directory' && entry.path === 'npm/') return;
        if (
          entry.type !== 'File' ||
          !expected.has(entry.path) ||
          seen.has(entry.path) ||
          entry.size > 8 * 1024 * 1024
        )
          invalid = true;
        seen.add(entry.path);
        if (entry.path === 'npm/package-lock.json' && entry.size < 8 * 1024 * 1024)
          entry.on('data', (b: Buffer) => lockChunks.push(b));
      },
    });
    if (
      invalid ||
      [...expected].some((name) => !seen.has(name)) ||
      digest(Buffer.concat(lockChunks)) !== manifest.toolchain.npmLockSha256
    )
      throw Error();
  } catch {
    fault('RELEASE_INVALID', '发布签名或构件校验失败', 422);
  }
  return manifest;
}
export async function registerRelease(
  db: PrismaClient,
  body: unknown,
  adminId: string,
  requestId: string,
) {
  const m = await verifyRelease(body);
  return db.$transaction(async (tx) => {
    if (
      await tx.release.findFirst({
        where: { OR: [{ id: m.id }, { sha256: m.sha256 }] },
      })
    )
      fault('RELEASE_EXISTS', '该发布已登记');
    const result = await tx.release.create({
      data: {
        id: m.id,
        artifactName: m.artifactName,
        sha256: m.sha256,
        manifest: m as unknown as Prisma.InputJsonValue,
      },
    });
    await tx.auditEvent.create({
      data: { adminId, action: 'RELEASE_REGISTERED', requestId },
    });
    return { id: result.id, createdAt: result.createdAt, manifest: m };
  });
}
export async function playbookDigest(root: string) {
  const files: string[] = [];
  async function walk(dir: string, base = '') {
    for (const item of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name, 'en'),
    )) {
      const name = base + item.name;
      if (item.isDirectory()) await walk(join(dir, item.name), name + '/');
      else if (item.isFile()) files.push(name);
      else fault('TOOLCHAIN_MISMATCH', '部署目录含不支持的文件类型');
    }
  }
  await walk(root);
  return digest(
    (
      await Promise.all(
        files.map(async (file) => file + '\n' + digest(await readFile(join(root, file)))),
      )
    ).join('\n'),
  );
}
