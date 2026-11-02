import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, copyFile, cp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve, sep } from 'node:path';
import type { Node } from '@prisma/client';
import { schemaIssues } from '@apk/contracts';
import type {
  ReleaseInput,
  DeploymentOutcome,
  ManualApkImportInput,
  ManualApkImportReceipt,
} from '@apk/contracts';
import { PlatformError, artifactPath, playbookDigest, hostKeyLine } from '@apk/platform';
import ssh2 from 'ssh2';
export interface InstallContext {
  node: Node;
  manifest: ReleaseInput;
  deploymentId: string;
  apiUrl: string;
  ssh: { privateKey?: string; passphrase?: string; password?: string };
  sudoPassword?: string;
  requestedMode?: 'AUTO' | 'FULL';
}
export interface Runner {
  install(context: InstallContext, signal: AbortSignal): Promise<void | DeploymentOutcome>;
  activate(context: InstallContext, bootstrapToken: string, signal: AbortSignal): Promise<void>;
  importApk?(
    context: InstallContext,
    input: ManualApkImportInput,
    file: string,
    signal: AbortSignal,
  ): Promise<ManualApkImportReceipt>;
}
const root = fileURLToPath(new URL('../../../', import.meta.url));
export function renderInventory(target: Record<string, string | number | boolean>) {
  return (
    'all:\n  hosts:\n    target:\n' +
    Object.entries(target)
      .map(([key, value]) => {
        if (!/^[a-z][a-z0-9_]*$/.test(key)) throw new Error('INVENTORY_KEY_INVALID');
        return (
          '      ' +
          key +
          ': ' +
          (typeof value === 'string' ? '!unsafe ' : '') +
          JSON.stringify(value)
        );
      })
      .join('\n') +
    '\n'
  );
}
export class AnsibleRunner implements Runner {
  constructor(
    private readonly playbooks = join(root, 'deploy/ansible'),
    private readonly executable = process.env.ANSIBLE_RUNNER_BIN ?? 'ansible-runner',
  ) {}
  private async run(
    context: InstallContext,
    playbook: string,
    bootstrapToken: string | undefined,
    signal: AbortSignal,
    upload?: { input: ManualApkImportInput; file: string },
  ) {
    if ((await playbookDigest(this.playbooks)) !== context.manifest.playbookSha256)
      throw new PlatformError(409, 'TOOLCHAIN_MISMATCH', '部署脚本与签名版本不一致');
    const base = resolve(process.env.DEPLOY_TEMP_DIR ?? join(tmpdir(), 'apk-platform-jobs'));
    await mkdir(base, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32' && !/^\/[A-Za-z0-9_./-]+$/.test(base))
      throw new PlatformError(503, 'ANSIBLE_FAILED', '临时工作目录路径无效');
    const dir = await mkdtemp(join(base, 'job-'));
    try {
      await mkdir(join(dir, 'inventory'), { mode: 0o700 });
      await mkdir(join(dir, 'env'), { mode: 0o700 });
      await cp(this.playbooks, join(dir, 'project'), { recursive: true });
      if ((await playbookDigest(join(dir, 'project'))) !== context.manifest.playbookSha256)
        throw new PlatformError(409, 'TOOLCHAIN_MISMATCH', '部署脚本复制校验失败');
      await copyFile(
        artifactPath(context.manifest.artifactName),
        join(dir, 'project', 'agent.tgz'),
      );
      const known = join(dir, 'known_hosts');
      await writeFile(
        known,
        `[${context.node.host}]:${context.node.port} ${context.node.hostKey}\n${context.node.host} ${context.node.hostKey}\n`,
        { mode: 0o600 },
      );
      const target: Record<string, string | number | boolean> = {
        ansible_host: context.node.host,
        ansible_port: context.node.port,
        ansible_user: context.node.username,
        ansible_connection: 'ssh',
        ansible_ssh_args: '-C -o ControlMaster=no -o ControlPersist=no -o ControlPath=none',
        ansible_python_interpreter: '/usr/bin/python3',
        ansible_become: true,
        ansible_ssh_common_args: `-o StrictHostKeyChecking=yes -o UserKnownHostsFile=${known} -o IdentitiesOnly=yes -o ConnectTimeout=10`,
      };
      if (context.ssh.privateKey) {
        const key = ssh2.utils.parseKey(context.ssh.privateKey, context.ssh.passphrase);
        if (key instanceof Error || Array.isArray(key) || !key.isPrivateKey())
          throw new PlatformError(422, 'SSH_KEY_INVALID', '私钥或口令无效');
        // Runner consumes its ssh_key input after ssh-add. Keep a separate identity
        // until OpenSSH finishes so IdentitiesOnly selects this job's key, including
        // encrypted PEM keys whose public part cannot be read without a passphrase.
        const identity = join(dir, 'identity_key');
        await writeFile(identity, context.ssh.privateKey, { mode: 0o600 });
        await writeFile(identity + '.pub', hostKeyLine(key.getPublicSSH()) + '\n', { mode: 0o600 });
        target.ansible_ssh_private_key_file = identity;
        await writeFile(join(dir, 'env', 'ssh_key'), context.ssh.privateKey, {
          mode: 0o600,
        });
        if (context.ssh.passphrase)
          await writeFile(join(dir, 'identity_passphrase'), context.ssh.passphrase, {
            mode: 0o600,
          });
      } else if (context.ssh.password) target.ansible_password = context.ssh.password;
      if (context.sudoPassword) target.ansible_become_password = context.sudoPassword;
      await writeFile(join(dir, 'inventory', 'hosts.yml'), renderInventory(target), {
        mode: 0o600,
      });
      const toolchainHash = (await import('@apk/platform')).digest(
        (await import('@apk/platform')).canonical(context.manifest.toolchain),
      );
      const variables = {
        ...(upload ? { apk_source: upload.file } : {}),
        release_id: context.manifest.id,
        artifact_sha256: context.manifest.sha256,
        toolchain: context.manifest.toolchain,
        toolchain_hash: toolchainHash,
        deployment_id: context.deploymentId,
        requested_mode: context.requestedMode ?? 'AUTO',
        ...(context.manifest.environment
          ? {
              environment_input: {
                nodeId: context.node.id,
                releaseId: context.manifest.id,
                environmentFingerprint: context.manifest.environment.fingerprint,
                sdkRoot: `/opt/apk-platform/toolchains/${toolchainHash}/android`,
                toolsRoot: `/opt/apk-platform/toolchains/${toolchainHash}/tools`,
              },
            }
          : {}),
        identity_enabled: context.manifest.features?.includes('DEVICE_VARIANTS_V1') ?? false,
        device_sessions_enabled: context.manifest.features?.includes('DEVICE_SESSIONS_V1') ?? false,
        download_enabled: context.manifest.features?.includes('DOWNLOAD_V1') ?? false,
        agent_config: {
          nodeId: context.node.id,
          releaseId: context.manifest.id,
          agentVersion: context.manifest.agentVersion,
          apiUrl: context.apiUrl,
          sdkRoot: `/opt/apk-platform/toolchains/${toolchainHash}/android`,
          toolsRoot: `/opt/apk-platform/toolchains/${toolchainHash}/tools`,
          ...(context.manifest.environment
            ? { environmentFingerprint: context.manifest.environment.fingerprint }
            : {}),
          ...(bootstrapToken ? { bootstrapToken } : {}),
        },
      };
      if (upload)
        await writeFile(join(dir, 'project', 'import-input.json'), JSON.stringify(upload.input), {
          mode: 0o600,
        });
      await writeFile(join(dir, 'env', 'extravars'), JSON.stringify(variables), { mode: 0o600 });
      await writeFile(
        join(dir, 'env', 'settings'),
        JSON.stringify({
          job_timeout: 7200,
          idle_timeout: 3600,
          suppress_ansible_output: true,
        }),
        { mode: 0o600 },
      );
      const code = await new Promise<number>((ok, no) => {
        const child = spawn(this.executable, ['run', dir, '-p', playbook, '--quiet'], {
          detached: process.platform !== 'win32',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            LANG: 'C.UTF-8',
            TERM: 'dumb',
            ANSIBLE_HOST_KEY_CHECKING: 'True',
            ANSIBLE_RETRY_FILES_ENABLED: 'False',
            ANSIBLE_NOCOLOR: '1',
            ANSIBLE_SSH_PASSWORD_MECHANISM: 'sshpass',
            ...(context.ssh.passphrase
              ? {
                  SSH_ASKPASS: join(root, 'scripts/ssh-askpass.mjs'),
                  SSH_ASKPASS_REQUIRE: 'force',
                  DISPLAY: 'apk-platform:0',
                  APK_SSH_PASSPHRASE_FILE: join(dir, 'identity_passphrase'),
                }
              : {}),
          },
        });
        let resolved = false;
        const finish = (n: number) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timeout);
          clearTimeout(killTimer);
          signal.removeEventListener('abort', abort);
          ok(n);
        };
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        function kill(sig: NodeJS.Signals) {
          try {
            if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig);
            else child.kill(sig);
          } catch {
            /* already stopped */
          }
        }
        const abort = () => {
          kill('SIGTERM');
          killTimer = setTimeout(() => kill('SIGKILL'), 5000);
        };
        const timeout = setTimeout(abort, 7200000);
        child.stdout.on('data', () => {});
        child.stderr.on('data', () => {});
        child.once('error', () => {
          clearTimeout(timeout);
          signal.removeEventListener('abort', abort);
          no(new PlatformError(503, 'ANSIBLE_FAILED', '部署工具无法启动'));
        });
        child.once('exit', (c) => finish(c ?? 1));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      if (code !== 0) {
        let failure = 'ANSIBLE_FAILED';
        const events = join(dir, 'artifacts');
        for (const artifact of await readdir(events).catch(() => []))
          for (const file of await readdir(join(events, artifact, 'job_events')).catch(() => [])) {
            const event = JSON.parse(
              await readFile(join(events, artifact, 'job_events', file), 'utf8'),
            ) as { event?: string; event_data?: { res?: { msg?: string } } };
            const msg = event.event_data?.res?.msg;
            if (event.event === 'runner_on_unreachable') {
              failure =
                typeof msg === 'string' &&
                /host key verification failed|remote host identification has changed/i.test(msg)
                  ? 'HOST_KEY_MISMATCH'
                  : typeof msg === 'string' &&
                      /permission denied|authentication failed|no supported authentication/i.test(
                        msg,
                      )
                    ? 'SSH_AUTH_FAILED'
                    : 'SSH_UNREACHABLE';
            } else if (event.event === 'runner_on_failed' && typeof msg === 'string') {
              if (msg.includes('UNSUPPORTED_OS')) failure = 'UNSUPPORTED_OS';
              else if (msg.includes('UNSUPPORTED_ARCH')) failure = 'UNSUPPORTED_ARCH';
              else if (msg.includes('NO_KVM')) failure = 'NO_KVM';
              else if (msg.includes('ANDROID_NOT_READY')) failure = 'ANDROID_NOT_READY';
              else if (msg.toLowerCase().includes('sudo')) failure = 'SUDO_REQUIRED';
            }
          }
        throw new PlatformError(
          409,
          signal.aborted ? 'JOB_CANCELLED' : failure,
          '部署步骤未完成，请查看步骤状态',
        );
      }
      if (playbook === 'update.yml' || playbook === 'import-apk.yml') {
        const receipts: unknown[] = [];
        const events = join(dir, 'artifacts');
        for (const artifact of await readdir(events))
          for (const file of await readdir(join(events, artifact, 'job_events'))) {
            const event = JSON.parse(
              await readFile(join(events, artifact, 'job_events', file), 'utf8'),
            );
            if (
              event.event === 'runner_on_ok' &&
              event.event_data?.task ===
                (upload ? 'Report APK import receipt' : 'Report deployment strategy')
            )
              receipts.push(event.event_data?.res?.msg);
          }
        if (
          receipts.length !== 1 ||
          schemaIssues(upload ? 'ManualApkImportReceipt' : 'DeploymentOutcome', receipts[0]).length
        )
          throw new PlatformError(409, 'ANSIBLE_FAILED', '缺少有效的节点部署回执');
        return receipts[0] as DeploymentOutcome | ManualApkImportReceipt;
      }
    } finally {
      const target = resolve(dir);
      if (target.startsWith(base + sep)) await rm(target, { recursive: true, force: true });
    }
  }
  async install(context: InstallContext, signal: AbortSignal) {
    return (await this.run(
      context,
      context.manifest.features?.includes('INCREMENTAL_DEPLOY_V1') ? 'update.yml' : 'install.yml',
      undefined,
      signal,
    )) as DeploymentOutcome | undefined;
  }
  async importApk(
    context: InstallContext,
    input: ManualApkImportInput,
    file: string,
    signal: AbortSignal,
  ) {
    return (await this.run(context, 'import-apk.yml', undefined, signal, {
      input,
      file,
    })) as ManualApkImportReceipt;
  }
  async activate(context: InstallContext, token: string, signal: AbortSignal) {
    await this.run(context, 'activate.yml', token, signal);
  }
}
