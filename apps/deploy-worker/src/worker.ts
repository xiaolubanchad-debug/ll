import { PrismaClient } from '@prisma/client';
import type { Deployment, Node } from '@prisma/client';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  claimJob,
  jobPhase,
  finishJob,
  expireJobs,
  probeHost,
  connectNode,
  remoteScript,
  readSecret,
  verifyRelease,
  issueEnrollment,
  PlatformError,
  SAFE_CODES,
} from '@apk/platform';
import type { HealthReport } from '@apk/platform';
import { executionOSSupported, requiredAgentProtocolsReady } from '@apk/contracts';
import type { Runner, InstallContext } from './runner.js';
const scriptPath = fileURLToPath(
  new URL('../../../deploy/ansible/files/inspect.sh', import.meta.url),
);
export function parseInspection(text: string): HealthReport & { ownerNodeId?: string } {
  const values = Object.fromEntries(
    text
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        const i = line.indexOf('=');
        return [line.slice(0, i), line.slice(i + 1)];
      }),
  );
  if (
    !/^[a-z0-9_.:-]{1,32}$/i.test(values.UBUNTU ?? '') ||
    !/^[a-z0-9_-]{1,32}$/i.test(values.ARCH ?? '') ||
    !/^\d+$/.test(values.DISK ?? '') ||
    !/^\d+$/.test(values.MEMORY ?? '') ||
    !['0', '1'].includes(values.KVM) ||
    !['0', '1'].includes(values.MARKER) ||
    !['0', '1'].includes(values.SUDO)
  )
    throw new PlatformError(409, 'SSH_UNREACHABLE', '远程环境检查响应无效');
  const r: HealthReport & { ownerNodeId?: string } = {
    ubuntu: values.UBUNTU,
    arch: values.ARCH,
    memoryKiB: Number(values.MEMORY),
    freeDiskBytes: Number(values.DISK),
    kvm: values.KVM === '1',
    sudo: values.SUDO === '1',
    markerPresent: values.MARKER === '1',
    android: false,
    download: false,
    versions: {},
    errors: [],
  };
  if (!Number.isSafeInteger(r.memoryKiB) || !Number.isSafeInteger(r.freeDiskBytes))
    throw new PlatformError(409, 'SSH_UNREACHABLE', '远程检查数值无效');
  if (values.NODE_ID && /^[a-f0-9-]{36}$/i.test(values.NODE_ID)) r.ownerNodeId = values.NODE_ID;
  const os = /^([^:]+):([^:]+)$/.exec(r.ubuntu);
  if (!os || !executionOSSupported(os[1], os[2])) r.errors.push('UNSUPPORTED_OS');
  if (r.arch !== 'x86_64') r.errors.push('UNSUPPORTED_ARCH');
  if (r.freeDiskBytes < 20 * 1024 ** 3) r.errors.push('DISK_LOW');
  if (!r.kvm) r.errors.push('NO_KVM');
  if (!r.sudo) r.errors.push('SUDO_REQUIRED');
  if (r.markerPresent) r.errors.push('INSTALL_IN_PROGRESS');
  return r;
}
export interface Transport {
  probe(node: Node, signal: AbortSignal): Promise<{ fingerprint: string; hostKey: string }>;
  inspect(node: Node, signal: AbortSignal): Promise<HealthReport & { ownerNodeId?: string }>;
}
export function sshTransport(db: PrismaClient): Transport {
  return {
    probe: probeHost,
    inspect: async (node, signal) => {
      const client = await connectNode(db, node, signal);
      try {
        return parseInspection(
          await remoteScript(client, await readFile(scriptPath, 'utf8'), signal),
        );
      } finally {
        client.end();
      }
    },
  };
}
export class Worker {
  readonly id = randomUUID();
  constructor(
    private readonly db: PrismaClient,
    private readonly runner: Runner,
    private readonly transport: Transport = sshTransport(db),
  ) {}
  async once(signal?: AbortSignal) {
    await expireJobs(this.db);
    if (signal?.aborted) return false;
    const job = await claimJob(this.db, this.id);
    if (!job) return false;
    await this.execute(job, signal);
    return true;
  }
  private async execute(job: Deployment, signal?: AbortSignal) {
    const abort = new AbortController();
    const shutdown = () => abort.abort();
    signal?.addEventListener('abort', shutdown, { once: true });
    if (signal?.aborted) abort.abort();
    let touched = false,
      leaseBusy = false,
      report: (HealthReport & { ownerNodeId?: string }) | null = null;
    const renew = async () => {
      if (leaseBusy) return;
      leaseBusy = true;
      try {
        const updated = await this.db.deployment.updateMany({
          where: {
            id: job.id,
            workerId: this.id,
            fence: job.fence,
            status: { notIn: ['SUCCEEDED', 'FAILED', 'CANCELLED', 'NEEDS_REVIEW'] },
            leaseExpiresAt: { gt: new Date() },
          },
          data: { leaseExpiresAt: new Date(Date.now() + 60000) },
        });
        const current = await this.db.deployment.findUnique({ where: { id: job.id } });
        if (!updated.count || current?.stopRequested) abort.abort();
      } catch {
        abort.abort();
      } finally {
        leaseBusy = false;
      }
    };
    const timer = setInterval(() => void renew(), 2000);
    let node: Node | undefined;
    try {
      node = await this.db.node.findUniqueOrThrow({ where: { id: job.nodeId } });
      if (node.archivedAt || node.version !== job.nodeVersion)
        throw new PlatformError(409, 'NODE_NOT_READY', '服务器资料已变化');
      if (job.kind === 'PROBE') {
        const result = await this.transport.probe(node, abort.signal);
        await finishJob(this.db, job.id, this.id, job.fence, 'SUCCEEDED', 'OK', result);
        return;
      }
      await jobPhase(this.db, job.id, this.id, job.fence, 'CHECKING');
      report = await this.transport.inspect(node, abort.signal);
      if (job.kind === 'CHECK') {
        await finishJob(
          this.db,
          job.id,
          this.id,
          job.fence,
          report.errors.length ? 'FAILED' : 'SUCCEEDED',
          report.errors[0] ?? 'OK',
          report,
        );
        return;
      }
      if (report.ownerNodeId && report.ownerNodeId !== node.id)
        throw new PlatformError(409, 'NODE_OWNERSHIP_CONFLICT', '该服务器已绑定其他节点');
      const fatal = report.errors.find((e) => e !== 'SUDO_REQUIRED');
      if (fatal) throw new PlatformError(409, fatal, '服务器不满足部署条件');
      if (!report.sudo && !node.sudoCredentialVersionId)
        throw new PlatformError(409, 'SUDO_REQUIRED', '需要可用的 sudo 权限或密码');
      const release = await this.db.release.findUniqueOrThrow({ where: { id: job.releaseId! } });
      const manifest = await verifyRelease(release.manifest);
      const auth = await this.db.agentCredential.findUnique({ where: { nodeId: node.id } });
      const health = node.health as { android?: boolean } | null;
      if (
        auth &&
        !auth.revokedAt &&
        auth.releaseId === job.releaseId &&
        node.lastSeenAt &&
        node.lastSeenAt.getTime() > Date.now() - 45000 &&
        health?.android &&
        requiredAgentProtocolsReady(manifest.features, node)
      ) {
        const until = Date.now() + 45000;
        let fresh = false;
        while (Date.now() < until && !abort.signal.aborted) {
          const live = await this.db.node.findUniqueOrThrow({ where: { id: node.id } });
          if (
            live.lastSeenAt &&
            live.lastSeenAt > job.createdAt &&
            requiredAgentProtocolsReady(manifest.features, live)
          ) {
            fresh = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
        if (fresh) {
          await jobPhase(this.db, job.id, this.id, job.fence, 'VERIFYING');
          await finishJob(this.db, job.id, this.id, job.fence, 'SUCCEEDED', 'OK', { reused: true });
          return;
        }
      }
      const apiUrl = process.env.CONTROL_PLANE_URL ?? '';
      const u = URL.canParse(apiUrl) ? new URL(apiUrl) : null;
      if (
        !u ||
        u.username ||
        u.password ||
        u.search ||
        u.hash ||
        (u.protocol !== 'https:' &&
          !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))
      )
        throw new PlatformError(503, 'HUB_URL_INVALID', '请配置节点可访问的 HTTPS 中台地址');
      const ssh = await readSecret(this.db, node.credentialVersionId!, ['SSH_KEY', 'SSH_PASSWORD']);
      const sudoPassword = node.sudoCredentialVersionId
        ? (await readSecret(this.db, node.sudoCredentialVersionId, ['SUDO_PASSWORD'])).password
        : undefined;
      const context: InstallContext = {
        node,
        manifest,
        deploymentId: job.id,
        apiUrl,
        ssh,
        sudoPassword,
      };
      await jobPhase(this.db, job.id, this.id, job.fence, 'INSTALLING');
      touched = true;
      await this.runner.install(context, abort.signal);
      await jobPhase(this.db, job.id, this.id, job.fence, 'CONFIGURING');
      await renew();
      if (abort.signal.aborted) throw new PlatformError(409, 'JOB_CANCELLED', '操作已停止');
      const bootstrap = await issueEnrollment(this.db, job.id, this.id, job.fence);
      await jobPhase(this.db, job.id, this.id, job.fence, 'STARTING');
      await this.runner.activate(context, bootstrap, abort.signal);
      await jobPhase(this.db, job.id, this.id, job.fence, 'VERIFYING');
      const deadline = Date.now() + 90000;
      let verified = false;
      while (Date.now() < deadline && !abort.signal.aborted) {
        const current = await this.db.node.findUniqueOrThrow({ where: { id: node.id } });
        const currentHealth = current.health as {
          android?: boolean;
          markerPresent?: boolean;
        } | null;
        if (
          current.lastSeenAt &&
          current.lastSeenAt.getTime() > Date.now() - 45000 &&
          current.agentReleaseId === manifest.id &&
          current.agentVersion === manifest.agentVersion &&
          currentHealth?.android &&
          !currentHealth.markerPresent &&
          requiredAgentProtocolsReady(manifest.features, current)
        ) {
          verified = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (!verified)
        throw new PlatformError(
          409,
          abort.signal.aborted ? 'JOB_CANCELLED' : 'AGENT_TIMEOUT',
          '尚未确认本次 Agent 和安卓环境就绪',
        );
      await finishJob(this.db, job.id, this.id, job.fence, 'SUCCEEDED', 'OK', {
        releaseId: manifest.id,
        androidVerified: true,
      });
    } catch (error) {
      const code = error instanceof PlatformError ? error.code : 'ANSIBLE_FAILED';
      let uncertain = false;
      if (touched && node) {
        try {
          const after = await this.transport.inspect(node, AbortSignal.timeout(20000));
          uncertain = after.markerPresent;
        } catch {
          uncertain = true;
        }
      }
      const safe =
        SAFE_CODES.includes(code) ||
        [
          'NODE_OWNERSHIP_CONFLICT',
          'CREDENTIAL_UNAVAILABLE',
          'HUB_URL_INVALID',
          'SECRET_REVOKED',
          'NODE_NOT_READY',
        ].includes(code)
          ? code
          : 'ANSIBLE_FAILED';
      await finishJob(
        this.db,
        job.id,
        this.id,
        job.fence,
        code === 'JOB_CANCELLED' ? 'CANCELLED' : 'FAILED',
        safe,
        report,
        uncertain,
      ).catch(() => {});
    } finally {
      clearInterval(timer);
      signal?.removeEventListener('abort', shutdown);
    }
  }
}
