import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { schemaIssues } from '@apk/contracts';
import type {
  DeploymentOutcome,
  EnvironmentInput,
  EnvironmentReceipt,
  EnvironmentHealth,
} from '@apk/contracts';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function environmentChecked<T>(name: string, value: unknown): T {
  if (schemaIssues(name, value).length) throw Error('ENVIRONMENT_INVALID');
  return value as T;
}
export interface EnvironmentPaths {
  state: string;
  machineId: string;
  osRelease: string;
  roots: string[];
  controls: string[];
  requireRoot: boolean;
}
export function environmentPaths(input: EnvironmentInput): EnvironmentPaths {
  if (input.sdkRoot.slice(0, -7) !== input.toolsRoot.slice(0, -5))
    throw Error('ENVIRONMENT_INVALID');
  return {
    state: '/var/lib/apk-platform',
    machineId: '/etc/machine-id',
    osRelease: '/etc/os-release',
    roots: [
      '/opt/apk-platform/runtime/node',
      input.sdkRoot,
      join(input.toolsRoot, 'node_modules'),
      join(input.toolsRoot, 'browsers'),
      '/usr/lib/jvm/java-17-openjdk-amd64',
    ],
    controls: [
      '/var/lib/dpkg/status',
      join(input.toolsRoot, 'package.json'),
      join(input.toolsRoot, 'package-lock.json'),
      join(input.toolsRoot, 'appium-home/node_modules/.cache/appium/extensions.yaml'),
    ],
    requireRoot: true,
  };
}
async function protectedJson(file: string, requireRoot: boolean) {
  const info = await lstat(file);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > 64 * 1024 ||
    (requireRoot && (info.uid !== 0 || (info.mode & 0o022) !== 0))
  )
    throw Error('ENVIRONMENT_INVALID');
  return JSON.parse(await readFile(file, 'utf8')) as unknown;
}
async function atomicJson(file: string, value: unknown, mode: number) {
  const temp = file + '.pending';
  // Never follow a pre-existing staging symlink or overwrite an unconfirmed write.
  await writeFile(temp, JSON.stringify(value) + '\n', { mode, flag: 'wx' });
  await rename(temp, file);
}
/** Metadata inspection does not read large image bodies. A real full verification is a prerequisite. */
export async function environmentSnapshot(paths: EnvironmentPaths) {
  const records: string[] = [];
  let count = 0;
  for (const [index, root] of paths.roots.entries()) {
    records.push(JSON.stringify([index, root, await realpath(root)]));
    async function walk(file: string) {
      if (++count > 250000) throw Error('ENVIRONMENT_TOO_LARGE');
      const name = relative(root, file).split('\\').join('/');
      // Playwright's installer link registry is mutable and not an executable or browser binary.
      if (index === 3 && (name === '.links' || name.startsWith('.links/'))) return;
      const s = await lstat(file, { bigint: true });
      const base = [index, name, s.mode.toString(), s.uid.toString(), s.gid.toString()];
      if (s.isSymbolicLink()) {
        records.push(
          JSON.stringify([
            ...base,
            'link',
            await realpath(file),
            s.mtimeNs.toString(),
            s.ctimeNs.toString(),
          ]),
        );
      } else if (s.isDirectory()) {
        records.push(JSON.stringify([...base, 'dir']));
        for (const child of (await readdir(file)).sort()) await walk(join(file, child));
      } else if (s.isFile()) {
        records.push(
          JSON.stringify([
            ...base,
            'file',
            s.dev.toString(),
            s.ino.toString(),
            s.size.toString(),
            s.mtimeNs.toString(),
            s.ctimeNs.toString(),
          ]),
        );
      } else throw Error('ENVIRONMENT_INVALID');
    }
    // Follow only explicitly selected canonical roots; all interior links are observed, not traversed.
    await walk(await realpath(root));
  }
  const controls = [];
  for (const file of paths.controls) {
    const info = await lstat(file);
    if (!info.isFile() || info.size > 8 * 1024 * 1024) throw Error('ENVIRONMENT_INVALID');
    controls.push([file, hash(await readFile(file))]);
  }
  return { snapshotHash: hash(records.join('\n')), controlsHash: hash(JSON.stringify(controls)) };
}
async function host(paths: EnvironmentPaths) {
  return {
    hostHash: hash(await readFile(paths.machineId)),
    osHash: hash(await readFile(paths.osRelease)),
  };
}
export async function planEnvironment(
  input: EnvironmentInput,
  mode: 'AUTO' | 'FULL',
  paths = environmentPaths(input),
): Promise<DeploymentOutcome> {
  const result = (
    reason: DeploymentOutcome['reason'],
    kind: 'CODE' | 'FULL' = 'FULL',
  ): DeploymentOutcome => ({
    mode: kind,
    reason,
    environmentFingerprint: input.environmentFingerprint,
  });
  if (mode === 'FULL') return result('FORCED_FULL');
  try {
    await lstat(join(paths.state, 'environment-receipt.json'));
  } catch (error) {
    return result(
      (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'BASELINE_MISSING' : 'BASELINE_INVALID',
    );
  }
  try {
    const receipt = environmentChecked<EnvironmentReceipt>(
      'EnvironmentReceipt',
      await protectedJson(join(paths.state, 'environment-receipt.json'), paths.requireRoot),
    );
    const actual = { ...(await host(paths)), ...(await environmentSnapshot(paths)) };
    if (
      receipt.nodeId !== input.nodeId ||
      receipt.environmentFingerprint !== input.environmentFingerprint ||
      (Object.keys(actual) as (keyof typeof actual)[]).some((key) => actual[key] !== receipt[key])
    )
      return result('ENVIRONMENT_CHANGED');
    return result('BASELINE_VALID', 'CODE');
  } catch {
    return result('BASELINE_INVALID');
  }
}
export async function captureEnvironment(input: EnvironmentInput, paths = environmentPaths(input)) {
  const proof = (await protectedJson(
    join(paths.state, 'health.json'),
    paths.requireRoot,
  )) as Record<string, unknown>;
  if (proof.releaseId !== input.releaseId || proof.bootSucceeded !== true)
    throw Error('ANDROID_NOT_READY');
  const receipt: EnvironmentReceipt = {
    version: 1,
    nodeId: input.nodeId,
    environmentFingerprint: input.environmentFingerprint,
    fullReleaseId: input.releaseId,
    fullVerifiedAt: new Date().toISOString(),
    ...(await host(paths)),
    ...(await environmentSnapshot(paths)),
  };
  environmentChecked('EnvironmentReceipt', receipt);
  await atomicJson(join(paths.state, 'environment-receipt.json'), receipt, 0o600);
  await healthProof(input, receipt, 'FULL', paths);
}
async function healthProof(
  input: EnvironmentInput,
  receipt: EnvironmentReceipt,
  mode: 'CODE' | 'FULL',
  paths: EnvironmentPaths,
) {
  const proof: EnvironmentHealth = {
    version: 2,
    releaseId: input.releaseId,
    mode,
    environmentFingerprint: input.environmentFingerprint,
    fullReleaseId: receipt.fullReleaseId,
    fullVerifiedAt: receipt.fullVerifiedAt,
  };
  environmentChecked('EnvironmentHealth', proof);
  await atomicJson(join(paths.state, 'health.json'), proof, 0o644);
}
export async function reuseEnvironment(input: EnvironmentInput, paths = environmentPaths(input)) {
  if ((await planEnvironment(input, 'AUTO', paths)).mode !== 'CODE')
    throw Error('ENVIRONMENT_CHANGED');
  const receipt = environmentChecked<EnvironmentReceipt>(
    'EnvironmentReceipt',
    await protectedJson(join(paths.state, 'environment-receipt.json'), paths.requireRoot),
  );
  await healthProof(input, receipt, 'CODE', paths);
}
