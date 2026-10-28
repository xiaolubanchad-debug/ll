import { XMLParser } from 'fast-xml-parser';
import { build } from 'esbuild';
import { createHash, randomUUID, createPrivateKey, sign } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { create } from 'tar';
import { canonical, playbookDigest, validManifest, releasePayload } from '@apk/platform';
const root = fileURLToPath(new URL('../', import.meta.url));
const hash = (b) => createHash('sha256').update(b).digest('hex');
async function official(url) {
  const parsed = new URL(url);
  if (!['dl.google.com', 'nodejs.org'].includes(parsed.hostname) || parsed.protocol !== 'https:')
    throw Error('OFFICIAL_SOURCE_REQUIRED');
  const response = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'error' });
  if (!response.ok) throw Error('OFFICIAL_METADATA_UNAVAILABLE');
  const text = await response.text();
  if (text.length > 20 * 1024 * 1024) throw Error('METADATA_TOO_LARGE');
  return text;
}
export function sdkArchive(xml, packagePath, role, base) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    removeNSPrefix: true,
    parseTagValue: false,
  });
  const document = parser.parse(xml);
  const repo =
    document.sdkRepository ??
    document.sdkSysImg ??
    Object.values(document).find((v) => v && typeof v === 'object' && v.remotePackage);
  const packages = Array.isArray(repo.remotePackage) ? repo.remotePackage : [repo.remotePackage];
  const pkg = packages.find(
    (p) => p.path === packagePath && p.obsolete !== true && p.obsolete !== 'true',
  );
  if (!pkg) throw Error('SDK_PACKAGE_MISSING');
  const archives = Array.isArray(pkg.archives.archive)
    ? pkg.archives.archive
    : [pkg.archives.archive];
  const archive = archives.find((a) => !a['host-os'] || a['host-os'] === 'linux');
  if (!archive) throw Error('SDK_ARCHIVE_MISSING');
  const complete = archive.complete;
  const checksum =
    typeof complete.checksum === 'object' ? complete.checksum['#text'] : complete.checksum;
  const digest = String(checksum).toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(digest)) throw Error('SDK_CHECKSUM_UNSUPPORTED');
  const version = pkg.revision;
  const revision = [version.major, version.minor ?? 0, version.micro ?? 0].join('.');
  return { role, url: new URL(complete.url, base).href, checksum: 'sha1:' + digest, revision };
}
export async function publishAgent() {
  if (execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim())
    throw Error('RELEASE_SOURCE_DIRTY');
  const gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const key = createPrivateKey(
    await readFile(resolve(process.env.RELEASE_PRIVATE_KEY_FILE ?? ''), 'utf8'),
  );
  const temp = resolve(root, '.tmp');
  await mkdir(temp, { recursive: true });
  const dir = await mkdtemp(join(temp, 'release-'));
  const npmDir = join(dir, 'npm');
  await mkdir(npmDir);
  const dependencies = {
    playwright: '1.64.1',
    appium: '3.9.0',
    'appium-uiautomator2-driver': '8.7.2',
  };
  await writeFile(
    join(npmDir, 'package.json'),
    JSON.stringify(
      { name: 'apk-node-tools', version: '1.0.0', private: true, dependencies },
      null,
      2,
    ),
  );
  if (!process.env.npm_execpath) throw Error('RUN_WITH_NPM');
  execFileSync(
    process.execPath,
    [
      process.env.npm_execpath,
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--prefix',
      npmDir,
    ],
    { stdio: 'ignore', windowsHide: true },
  );
  const xml = await official('https://dl.google.com/android/repository/repository2-1.xml');
  const imageXml = await official(
    'https://dl.google.com/android/repository/sys-img/google_apis/sys-img2-1.xml',
  );
  const nodeSums = await official('https://nodejs.org/dist/v24.18.0/SHASUMS256.txt');
  const nodeSha256 = nodeSums
    .split('\n')
    .find((line) => line.trim().endsWith('node-v24.18.0-linux-x64.tar.xz'))
    ?.split(/\s+/)[0];
  if (!nodeSha256) throw Error('NODE_CHECKSUM_MISSING');
  const toolchain = {
    nodeVersion: '24.18.0',
    nodeUrl: 'https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-x64.tar.xz',
    nodeSha256,
    playwrightVersion: dependencies.playwright,
    appiumVersion: dependencies.appium,
    uiautomator2Version: dependencies['appium-uiautomator2-driver'],
    npmLockSha256: hash(await readFile(join(npmDir, 'package-lock.json'))),
    systemImage: 'system-images;android-35;google_apis;x86_64',
    archives: [
      sdkArchive(
        xml,
        'cmdline-tools;19.0',
        'cmdlineTools',
        'https://dl.google.com/android/repository/',
      ),
      sdkArchive(xml, 'emulator', 'emulator', 'https://dl.google.com/android/repository/'),
      sdkArchive(
        xml,
        'platform-tools',
        'platformTools',
        'https://dl.google.com/android/repository/',
      ),
      sdkArchive(
        imageXml,
        'system-images;android-35;google_apis;x86_64',
        'systemImage',
        'https://dl.google.com/android/repository/sys-img/google_apis/',
      ),
    ],
  };
  for (const [entry, out] of [
    ['entry', 'agent'],
    ['boot-entry', 'boot-check'],
    ['egress-entry', 'egress'],
  ])
    await build({
      entryPoints: [join(root, 'apps/agent/src', entry + '.ts')],
      bundle: true,
      alias: {
        '@apk/automation': join(root, 'packages/automation/src/index.ts'),
        '@apk/contracts': join(root, 'packages/contracts/src/index.ts'),
      },
      platform: 'node',
      format: 'esm',
      target: 'node24',
      banner: {
        js: "import { createRequire as __apkCreateRequire } from 'node:module'; const require = __apkCreateRequire(import.meta.url);",
      },
      outfile: join(dir, out + '.js'),
    });
  const releaseDir = resolve(process.env.RELEASE_DIR ?? 'data/releases');
  await mkdir(releaseDir, { recursive: true, mode: 0o700 });
  const staged = join(dir, 'agent.tgz');
  await create({ gzip: true, portable: true, cwd: dir, file: staged }, [
    'agent.js',
    'boot-check.js',
    'egress.js',
    'npm/package.json',
    'npm/package-lock.json',
  ]);
  const bytes = await readFile(staged),
    sha256 = hash(bytes),
    artifactName = 'agent-' + sha256 + '.tgz';
  await writeFile(join(releaseDir, artifactName), bytes, { flag: 'wx', mode: 0o600 });
  const body = {
    id: randomUUID(),
    gitCommit,
    agentVersion: '0.3.1',
    protocolVersion: '1.0',
    features: ['DOWNLOAD_V1'],
    artifactName,
    sha256,
    playbookSha256: await playbookDigest(join(root, 'deploy/ansible')),
    toolchain,
  };
  const signature = sign(null, Buffer.from(canonical(body)), key).toString('base64');
  const manifest = validManifest({ ...body, signature });
  if (releasePayload(manifest) !== canonical(body)) throw Error('MANIFEST_MISMATCH');
  await writeFile(
    join(releaseDir, manifest.id + '.manifest.json'),
    JSON.stringify(manifest, null, 2),
    { flag: 'wx', mode: 0o600 },
  );
  console.log('已生成签名发布清单：' + join(releaseDir, manifest.id + '.manifest.json'));
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  publishAgent().catch(() => {
    console.error('发布失败：请确认源码已提交、部署密钥、官方元数据及工具依赖可用');
    process.exitCode = 1;
  });
