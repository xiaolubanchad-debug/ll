import { parseFunctionalEvidence } from '@apk/contracts';
import { readFile, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { digest } from './security.js';
import { fault } from './errors.js';

export const artifactRoot = () => resolve(process.env.ARTIFACT_DIR ?? 'data/artifacts');
export function validateFunctionalBytes(bytes: Buffer) {
  const evidence =
    bytes.length <= 65536 ? parseFunctionalEvidence(bytes.toString('utf8')) : undefined;
  if (!evidence)
    fault('CONTENT_ISOLATION_REQUIRED', '仅接受受限的功能证据，不接收原始画面或正文', 422);
  return evidence;
}
export async function readFunctionalArtifact(artifact: {
  id: string;
  kind: string;
  storageKey: string;
  bytes: number;
  sha256: string;
}) {
  if (artifact.kind !== 'functional-evidence')
    fault('CONTENT_ISOLATION_REQUIRED', '历史画面已隔离，不提供原图', 410);
  if (
    artifact.storageKey !== artifact.id + '.json' ||
    !/^[a-f0-9-]{36}\.json$/.test(artifact.storageKey)
  )
    fault('ARTIFACT_INVALID', '功能证据记录无效', 422);
  const path = join(artifactRoot(), artifact.storageKey),
    info = await lstat(path).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || info.size !== artifact.bytes || info.size > 65536)
    fault('ARTIFACT_INVALID', '功能证据不可用', 410);
  const bytes = await readFile(path);
  if (digest(bytes) !== artifact.sha256) fault('ARTIFACT_INVALID', '功能证据已损坏', 410);
  return { bytes, evidence: validateFunctionalBytes(bytes) };
}
