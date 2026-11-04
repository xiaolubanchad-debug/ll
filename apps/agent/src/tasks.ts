import { join, dirname } from 'node:path';
import {
  agentIssues,
  configurationIssues,
  schemaIssues,
  parseFunctionalEvidence,
} from '@apk/contracts';
import type { TestConfiguration, DailyExecutionPlan, TestBootstrap } from '@apk/contracts';
import {
  canonical,
  sha,
  runDownload,
  runDirectApk,
  cleanupBrowser,
  cleanupAndroid,
  removeOwned,
  registerApk,
  openApk,
  startAndroid,
  RegistrationError,
  runCachedRegistrations,
  runProxyCheck,
} from '@apk/automation';
import type { DownloadOptions, RegistrationHooks, ProxyCredential } from '@apk/automation';
import { openAgentStore, lockAgent } from './store.js';
import type { AgentStore, Delivery, LocalDelivery } from './store.js';
export class HubRequestError extends Error {
  constructor(readonly status: number) {
    super(status === 401 || status === 410 ? 'IDENTITY_REJECTED' : 'HUB_REQUEST_FAILED');
  }
}
export type Hub = (
  path: string,
  body: unknown,
  signal?: AbortSignal,
) => Promise<Record<string, unknown>>;
export interface ExecutionOptions extends DownloadOptions {
  sdkRoot?: string;
  androidFactory?: RegistrationHooks['androidFactory'];
  proxyCheckUrl?: string;
}
export class TaskEngine {
  current: Delivery | null = null;
  private abort: AbortController | null = null;
  private running: Promise<void> | null = null;
  private lease = 0;
  private control = 'CONTINUE';
  private busy = false;
  private closed = false;
  private recoveryBlocked = false;
  private cleanupInProgress: Promise<boolean> | null = null;
  private pendingFlush: Promise<void> = Promise.resolve();
  private readonly retryDelivery = new Map<string, { delay: number; after: number }>();
  private constructor(
    readonly store: AgentStore,
    private readonly unlock: () => Promise<void>,
    private readonly nodeId: string,
    private readonly bootId: string,
    private readonly toolsRoot: string,
    private readonly hub: Hub,
    private readonly options: ExecutionOptions,
  ) {}
  static async open(
    root: string,
    nodeId: string,
    bootId: string,
    toolsRoot: string,
    hub: Hub,
    options: ExecutionOptions = {},
  ) {
    const unlock = await lockAgent(root);
    try {
      const store = await openAgentStore(root);
      const engine = new TaskEngine(store, unlock, nodeId, bootId, toolsRoot, hub, options);
      await engine.recover();
      return engine;
    } catch (error) {
      await unlock();
      throw error;
    }
  }
  private async cleanupDelivery(row: LocalDelivery) {
    const base = join(this.store.root, 'android/jobs');
    if (row.android && (await cleanupAndroid(base, row.android))) this.store.android(row.id, null);
    for (const { slot, record } of row.androidSlots) {
      if (await cleanupAndroid(base, record)) this.store.androidSlot(row.id, slot, null);
    }
    if (
      row.browser &&
      (await cleanupBrowser(join(this.store.root, 'downloads'), row.browser.profile))
    ) {
      try {
        await removeOwned(join(this.store.root, 'downloads/jobs'), dirname(row.browser.profile));
        this.store.browser(row.id, null);
      } catch {
        return false;
      }
    }
    return this.store.deliveries().find((r) => r.id === row.id)?.clean === true;
  }
  private async recover() {
    const previous = this.store.deliveries();
    const deliveries = [];
    let clean = true;
    for (const row of previous) {
      const cleared = await this.cleanupDelivery(row);
      if (!cleared) clean = false;
      if (cleared) this.store.browser(row.id, null);
      if (row.status !== 'DONE') this.store.status(row.id, 'REVIEW', cleared);
      await this.flush(row.payload).catch(() => {});
      deliveries.push({
        deliveryId: row.id,
        fence: row.payload.fence,
        cleanupComplete: cleared,
        submissions: this.store.submissions(row.id),
      });
    }
    this.recoveryBlocked = !clean;
    await this.hub('reconcile', {
      reason: 'STARTUP',
      protocolVersion: '1.0',
      nodeId: this.nodeId,
      bootId: this.bootId,
      deliveries: deliveries.slice(-100),
      cleanupComplete: clean,
    });
    // The new boot identity is now bound; supplement old evidence without executing it.
    for (const row of previous) await this.flush(row.payload).catch(() => {});
  }
  flush(delivery: Delivery, signal?: AbortSignal): Promise<void> {
    const pending = this.pendingFlush
      .catch(() => {})
      .then(() => this.flushEvents(delivery, signal));
    this.pendingFlush = pending;
    return pending;
  }
  private async flushEvents(delivery: Delivery, signal?: AbortSignal) {
    for (const account of this.store.pendingAccounts(delivery)) {
      const response = await this.hub(
        'tasks/' + account.taskId + '/account',
        {
          kind: 'account',
          protocolVersion: '1.0',
          nodeId: this.nodeId,
          deliveryId: delivery.deliveryId,
          fence: delivery.fence,
          ...account,
        },
        signal,
      );
      if (response.accountRef !== account.accountRef) throw Error('HUB_RESPONSE_INVALID');
      this.store.accountAck(account.accountRef);
    }
    for (const artifact of this.store.pendingEvidence(delivery.deliveryId)) {
      if (!parseFunctionalEvidence(Buffer.from(String(artifact.data), 'base64').toString('utf8')))
        throw new RegistrationError('CONTENT_ISOLATION_REQUIRED');
      const response = await this.hub(
        'artifacts',
        {
          protocolVersion: '1.0',
          nodeId: this.nodeId,
          bootId: this.bootId,
          deliveryId: delivery.deliveryId,
          fence: delivery.fence,
          taskId: artifact.task,
          artifactId: artifact.id,
          kind: 'functional-evidence',
          sha256: artifact.sha,
          dataBase64: artifact.data,
          redaction: 'CONTENT_ISOLATED',
        },
        signal,
      );
      if (response.artifactId !== artifact.id) throw Error('HUB_RESPONSE_INVALID');
      this.store.evidenceAck(String(artifact.id));
    }
    for (let i = 0; i < 100; i++) {
      const events = this.store.pending(delivery.deliveryId);
      if (!events.length) return;
      const response = await this.hub(
        'events',
        {
          kind: 'events',
          protocolVersion: '1.0',
          nodeId: this.nodeId,
          deliveryId: delivery.deliveryId,
          fence: delivery.fence,
          events,
        },
        signal,
      );
      this.observe(response, delivery.deliveryId);
      if (
        !Array.isArray(response.ackedEventIds) ||
        response.ackedEventIds.some(
          (id) => typeof id !== 'string' || !events.some((e) => e.eventId === id),
        )
      )
        throw Error('HUB_RESPONSE_INVALID');
      if (!response.ackedEventIds.length) throw Error('HUB_RESPONSE_INVALID');
      this.store.acknowledge(response.ackedEventIds as string[]);
    }
  }
  heartbeat() {
    return this.current
      ? {
          deliveryId: this.current.deliveryId,
          runId: this.current.runId,
          fence: this.current.fence,
        }
      : null;
  }
  observe(
    response: Record<string, unknown>,
    expectedDeliveryId: string | null = this.current?.deliveryId ?? null,
  ) {
    if (!this.current || this.current.deliveryId !== expectedDeliveryId) return;
    if (typeof response.leaseExpiresAt === 'string') {
      const expires = Date.parse(response.leaseExpiresAt);
      this.lease = Number.isFinite(expires) ? Math.min(expires, Date.now() + 120000) : 0;
      if (!this.lease) {
        this.control = 'REVIEW';
        this.abort?.abort();
      }
    }
    if (response.desiredControl === 'STOP') {
      this.control = response.reconcileRequired ? 'REVIEW' : 'STOP';
      this.abort?.abort();
    }
  }
  private async syncDelivery(row: LocalDelivery) {
    try {
      await this.flush(row.payload);
    } catch (error) {
      // A rejected event must not prevent reporting independently verified resource cleanup.
      if (
        row.reconcilePending &&
        error instanceof HubRequestError &&
        [400, 404, 409, 413, 422].includes(error.status)
      )
        await this.reconcile(row);
      throw error;
    }
    if (row.reconcilePending) await this.reconcile(row);
    if (row.status === 'COMPLETED') this.store.status(row.id, 'DONE', true);
  }
  async tick() {
    if (this.closed || this.recoveryBlocked) return;
    if (this.current && Date.now() >= this.lease) {
      this.control = 'REVIEW';
      this.abort?.abort();
    }
    if (this.busy || this.running) return;
    this.busy = true;
    try {
      for (const row of this.store
        .deliveries()
        .filter((r) => ['DONE', 'COMPLETED', 'REVIEW'].includes(r.status))) {
        const retry = this.retryDelivery.get(row.id);
        if (retry && retry.after > Date.now()) continue;
        try {
          if (row.status === 'REVIEW' && !row.clean) {
            this.cleanupInProgress = this.cleanupDelivery(row);
            const cleaned = await this.cleanupInProgress.finally(() => {
              this.cleanupInProgress = null;
            });
            if (this.closed) return;
            if (!cleaned) throw Error('CLEANUP_INCOMPLETE');
            this.store.queueReconcile(row.id);
            await this.syncDelivery({ ...row, clean: true, reconcilePending: true });
          } else await this.syncDelivery(row);
          this.retryDelivery.delete(row.id);
        } catch {
          const delay = Math.min(retry ? retry.delay * 2 : 1000, 30000);
          this.retryDelivery.set(row.id, { delay, after: Date.now() + delay });
        }
      }
      if (this.store.deliveries().some((row) => row.status === 'REVIEW' && !row.clean)) return;
      const response = await this.hub('claims', {
        kind: 'claim',
        protocolVersion: '1.0',
        nodeId: this.nodeId,
        bootId: this.bootId,
      });
      if (response.kind !== 'delivery') return;
      if (agentIssues(response).length) throw Error('HUB_RESPONSE_INVALID');
      const delivery = response as unknown as Delivery;
      if (this.store.deliveries().some((r) => r.id === delivery.deliveryId)) return;
      this.store.add(delivery);
      this.current = delivery;
      this.lease = Date.parse(delivery.leaseExpiresAt);
      this.control = 'CONTINUE';
      this.abort = new AbortController();
      this.running = this.execute(delivery, this.abort.signal)
        .catch(() => this.reportCleanup(delivery))
        .finally(() => {
          this.running = null;
          this.current = null;
          this.abort = null;
        });
    } finally {
      this.busy = false;
    }
  }
  private async execute(d: Delivery, signal: AbortSignal) {
    const accept = await this.hub('deliveries/' + d.deliveryId + '/accept', {
      kind: 'accept',
      protocolVersion: '1.0',
      nodeId: this.nodeId,
      bootId: this.bootId,
      deliveryId: d.deliveryId,
      fence: d.fence,
    });
    this.observe(accept);
    if (signal.aborted) {
      this.store.append(d, {
        type: 'STOP_ACK',
        payload: { cleanupComplete: true },
      });
      await this.flush(d);
      this.store.status(d.deliveryId, 'DONE', true);
      return;
    }
    const snapshot = await this.hub('deliveries/' + d.deliveryId + '/config', {
      protocolVersion: '1.0',
      nodeId: this.nodeId,
      bootId: this.bootId,
      deliveryId: d.deliveryId,
      fence: d.fence,
    });
    if (
      configurationIssues(snapshot.config).length ||
      snapshot.configHash !== d.configHash ||
      sha(canonical(snapshot.config)) !== d.configHash
    )
      throw Error('CONFIG_HASH_MISMATCH');
    const config = snapshot.config as TestConfiguration;
    const plan = snapshot.executionPlan as DailyExecutionPlan | undefined;
    if (
      plan &&
      (schemaIssues('DailyExecutionPlan', plan).length ||
        (plan.purpose === 'REGISTER' &&
          (plan.successTarget < 1 ||
            plan.attemptLimit < plan.successTarget ||
            (!plan.resourceAssets && plan.assets.some((a) => a.apk.cacheDay !== plan.cacheDay)))) ||
        (plan.resourceAssets && plan.purpose !== 'REGISTER') ||
        (plan.resourceAction && (plan.purpose !== 'DOWNLOAD' || !plan.resourceScope)))
    )
      throw Error('EXECUTION_PLAN_INVALID');
    if (
      plan?.openPolicy &&
      (!config.execution.appOpen ||
        plan.openPolicy.concurrency !== (config.execution.appOpen.concurrency ?? 1))
    )
      throw Error('OPEN_POLICY_INVALID');
    if (
      plan?.purpose === 'REGISTER' &&
      config.execution.appOpen?.concurrency !== undefined &&
      !plan.openPolicy
    )
      throw Error('OPEN_POLICY_INVALID');
    const versions = snapshot.secretVersions;
    const direct = !!plan?.resourceAction;
    if (
      (!this.options.sdkRoot &&
        (plan?.purpose === 'REGISTER' || (!plan && config.execution.mode === 'FULL'))) ||
      !Array.isArray(versions) ||
      versions.length !== (direct ? 0 : 1)
    )
      throw Error('PROXY_CONFIG_INVALID');
    const secret = versions[0] as { id?: unknown; type?: unknown; secretValue?: unknown } | null;
    if (
      !direct &&
      (!secret ||
        secret.id !== (plan?.proxySecretVersionId ?? config.execution.proxySecretVersionId) ||
        secret.type !== 'HTTP_PROXY' ||
        schemaIssues('SecretInput', { type: 'HTTP_PROXY', secretValue: secret.secretValue }).length)
    )
      throw Error('PROXY_CONFIG_INVALID');
    const proxy = secret?.secretValue as ProxyCredential;
    this.store.status(d.deliveryId, 'RUNNING');
    this.store.append(d, {
      type: 'RUN_STARTED',
      payload: { configHash: d.configHash, releaseId: d.releaseId },
    });
    let review = false;
    const emit = async (event: {
      type: string;
      taskId?: string;
      payload: Record<string, unknown>;
    }) => {
      if (event.type === 'RUN_FINISHED' && event.payload.status === 'NEEDS_REVIEW') review = true;
      this.store.append(d, event);
      if (event.type === 'TASK_STAGE' && event.payload.stage === 'VERIFYING') return;
      await this.flush(d).catch(() => {});
    };
    const beforeAction = () => {
      if (signal.aborted || Date.now() >= this.lease || this.control !== 'CONTINUE') {
        if (this.control !== 'STOP') this.control = 'REVIEW';
        this.abort?.abort();
        throw new RegistrationError('CANCELLED');
      }
      this.options.beforeAction?.();
    };
    const deviceOwners = new Map<string, string>();
    const deviceSessions = new Map<string, Awaited<ReturnType<typeof startAndroid>>>();
    const failedDeviceCleanups = new Set<string>();
    const closeDeviceSession = async (id: string, retry = false) => {
      const session = deviceSessions.get(id);
      let clean: boolean;
      if (session) clean = await session.close().catch(() => false);
      else {
        const slot = this.store
          .androidSlots(d.deliveryId)
          .find((r) => r.slot === deviceOwners.get(id));
        clean =
          !slot ||
          (retry &&
            (await cleanupAndroid(join(this.store.root, 'android/jobs'), slot.record).catch(
              () => false,
            )));
        if (slot && clean) this.store.androidSlot(d.deliveryId, slot.slot, null);
      }
      if (clean) {
        deviceSessions.delete(id);
        failedDeviceCleanups.delete(id);
      } else failedDeviceCleanups.add(id);
      return clean;
    };
    try {
      const runOptions: DownloadOptions = {
        ...this.options,
        beforeAction,
        ...(plan?.purpose === 'REGISTER' || (!plan && config.execution.mode === 'FULL')
          ? {
              afterDownload: async (
                target,
                apk,
                file,
                index,
                attemptSignal = signal,
                beginAttempt,
              ) => {
                if (config.execution.appOpen) {
                  await this.flush(d);
                  beforeAction();
                }
                return config.execution.appOpen
                  ? openApk(config, target, apk, file, index, attemptSignal, emit, {
                      sdkRoot: this.options.sdkRoot!,
                      toolsRoot: this.toolsRoot,
                      root: join(this.store.root, 'android'),
                      proxy,
                      policy: this.options.policy,
                      proxyCheckUrl: this.options.proxyCheckUrl,
                      beginAttempt: beginAttempt
                        ? async () => {
                            await beginAttempt();
                            await this.flush(d);
                            beforeAction();
                          }
                        : undefined,
                      androidFactory: target.deviceSessionId
                        ? async (profile, s, hooks) => {
                            const id = target.deviceSessionId!;
                            let session = deviceSessions.get(id);
                            if (!session) {
                              deviceOwners.set(id, target.taskId);
                              session = await (this.options.androidFactory ?? startAndroid)(
                                profile,
                                s,
                                hooks,
                              );
                              deviceSessions.set(id, session);
                            }
                            const shared = session;
                            return {
                              ...shared,
                              close: async () => {
                                if (!shared.finishApplication) return false;
                                return shared.finishApplication(apk.packageName).catch(() => false);
                              },
                            };
                          }
                        : this.options.androidFactory,
                      testBootstrap: async () => {
                        await this.flush(d);
                        beforeAction();
                        const value = await this.hub(
                          'tasks/' + target.taskId + '/test-bootstrap',
                          {
                            protocolVersion: '1.0',
                            nodeId: this.nodeId,
                            deliveryId: d.deliveryId,
                            fence: d.fence,
                          },
                          attemptSignal,
                        );
                        if (schemaIssues('TestBootstrap', value).length)
                          throw new RegistrationError('TEST_BOOTSTRAP_FAILED');
                        return value as unknown as TestBootstrap;
                      },
                      testReceipt: async (receiptSignal) => {
                        await this.flush(d);
                        beforeAction();
                        receiptSignal.throwIfAborted();
                        const value = await this.hub(
                          'tasks/' + target.taskId + '/test-receipt',
                          {
                            protocolVersion: '1.0',
                            nodeId: this.nodeId,
                            deliveryId: d.deliveryId,
                            fence: d.fence,
                          },
                          receiptSignal,
                        );
                        if (schemaIssues('TestClientReceipt', value).length)
                          throw new RegistrationError('TEST_RECEIPT_UNCONFIRMED');
                        return value as unknown as import('@apk/contracts').TestClientReceipt;
                      },
                      beforeAction,
                      resources: async (record) => {
                        this.store.androidSlot(d.deliveryId, target.taskId, record);
                      },
                    })
                  : registerApk(config, target, apk, file, index, signal, emit, {
                      sdkRoot: this.options.sdkRoot!,
                      toolsRoot: this.toolsRoot,
                      root: join(this.store.root, 'android'),
                      proxy,
                      policy: this.options.policy,
                      proxyCheckUrl: this.options.proxyCheckUrl,
                      androidFactory: this.options.androidFactory,
                      learning: {
                        load: async (key) => this.store.loadRegistrationTemplate(key),
                        save: async (key, value) => this.store.saveRegistrationTemplate(key, value),
                        drop: async (key) => this.store.dropRegistrationTemplate(key),
                      },
                      beforeAction,
                      resources: async (record) => {
                        this.store.android(d.deliveryId, record);
                      },
                      account: async (taskId) => {
                        await this.flush(d);
                        const account = this.store.account(d, taskId);
                        try {
                          await this.flush(d);
                        } catch {
                          throw new RegistrationError('ACCOUNT_SYNC_FAILED');
                        }
                        return account;
                      },
                      intent: async (taskId, ref, verificationSignal) => {
                        beforeAction();
                        this.store.intent(d, taskId, ref);
                        await this.flush(d, verificationSignal).catch(() => {});
                      },
                      evidence: async (taskId, bytes, verificationSignal) => {
                        const id = this.store.evidence(d, taskId, bytes);
                        await this.flush(d, verificationSignal);
                        return id;
                      },
                    });
              },
            }
          : {}),
        onBrowser: async (record) => {
          this.store.browser(d.deliveryId, record);
          await this.options.onBrowser?.(record);
        },
        onClosed: async () => {
          this.store.browser(d.deliveryId, null);
          await this.options.onClosed?.();
        },
      };
      if (plan?.purpose === 'REGISTER')
        await runCachedRegistrations(
          config,
          plan,
          this.nodeId,
          join(this.store.root, 'downloads'),
          signal,
          emit,
          beforeAction,
          runOptions.afterDownload!,
          closeDeviceSession,
        );
      else if (plan?.purpose === 'PROXY_CHECK') {
        beforeAction();
        await runProxyCheck(proxy, signal, emit, this.options.policy, this.options.proxyCheckUrl);
      } else if (plan?.resourceAction?.kind === 'FETCH')
        await runDirectApk(
          config,
          plan,
          this.nodeId,
          join(this.store.root, 'downloads'),
          signal,
          emit,
          runOptions,
        );
      else
        await runDownload(
          plan
            ? {
                ...config,
                execution: { ...config.execution, mode: 'DOWNLOAD_ONLY' },
              }
            : config,
          this.nodeId,
          join(this.store.root, 'downloads'),
          this.toolsRoot,
          signal,
          emit,
          {
            ...runOptions,
            ...(direct ? { scanOnly: true } : { webProxy: proxy }),
            ...(plan && !direct ? { dailyDownload: true, fixedCacheDay: plan.cacheDay } : {}),
          },
        );
      if (review || this.control === 'REVIEW') {
        this.store.status(d.deliveryId, 'REVIEW');
        await this.flush(d).catch(() => {});
        for (const id of failedDeviceCleanups) await closeDeviceSession(id, true);
        await this.reportCleanup(d);
        return;
      }
      if (signal.aborted && this.control === 'STOP') throw new RegistrationError('CANCELLED');
      this.store.status(d.deliveryId, 'COMPLETED', true);
      await this.flush(d);
      this.store.status(d.deliveryId, 'DONE', true);
    } catch (error) {
      const row = this.store.deliveries().find((r) => r.id === d.deliveryId)!;
      if (signal.aborted && this.control === 'STOP') {
        this.store.append(d, {
          type: 'STOP_ACK',
          payload: { cleanupComplete: row.clean },
        });
        await this.flush(d);
        this.store.status(d.deliveryId, row.clean ? 'DONE' : 'REVIEW', row.clean);
        if (!row.clean) await this.reportCleanup(d);
      } else throw error;
    }
  }
  private async reportCleanup(d: Delivery) {
    this.store.queueReconcile(d.deliveryId);
    const row = this.store.deliveries().find((r) => r.id === d.deliveryId)!;
    await this.syncDelivery(row).catch(() => {});
  }
  private async reconcile(row: LocalDelivery) {
    const result = await this.hub('reconcile', {
      reason: 'EXECUTION_ERROR',
      protocolVersion: '1.0',
      nodeId: this.nodeId,
      bootId: this.bootId,
      deliveries: [
        {
          deliveryId: row.id,
          fence: row.payload.fence,
          cleanupComplete: row.clean,
          submissions: this.store.submissions(row.id),
        },
      ],
      cleanupComplete: row.clean,
    });
    if (result.reconciled !== true) throw Error('HUB_RESPONSE_INVALID');
    this.store.acknowledgeReconcile(row.id);
  }
  async close() {
    this.closed = true;
    this.control = 'REVIEW';
    this.abort?.abort();
    await this.running;
    await this.cleanupInProgress?.catch(() => {});
    await this.pendingFlush.catch(() => {});
    this.store.close();
    await this.unlock();
  }
}
