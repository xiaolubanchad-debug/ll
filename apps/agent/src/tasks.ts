import { join, dirname } from 'node:path';
import { agentIssues, configurationIssues } from '@apk/contracts';
import type { TestConfiguration } from '@apk/contracts';
import { canonical, sha, runDownload, cleanupBrowser, removeOwned } from '@apk/automation';
import type { DownloadOptions } from '@apk/automation';
import { openAgentStore, lockAgent } from './store.js';
import type { AgentStore, Delivery } from './store.js';
export type Hub = (path: string, body: unknown) => Promise<Record<string, unknown>>;
export class TaskEngine {
  current: Delivery | null = null;
  private abort: AbortController | null = null;
  private running: Promise<void> | null = null;
  private lease = 0;
  private control = 'CONTINUE';
  private busy = false;
  private closed = false;
  private constructor(
    readonly store: AgentStore,
    private readonly unlock: () => Promise<void>,
    private readonly nodeId: string,
    private readonly bootId: string,
    private readonly toolsRoot: string,
    private readonly hub: Hub,
    private readonly options: DownloadOptions,
  ) {}
  static async open(
    root: string,
    nodeId: string,
    bootId: string,
    toolsRoot: string,
    hub: Hub,
    options: DownloadOptions = {},
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
  private async recover() {
    const previous = this.store.deliveries();
    const deliveries = [];
    let clean = true;
    for (const row of previous) {
      let cleared = row.clean;
      if (row.browser) {
        cleared = await cleanupBrowser(join(this.store.root, 'downloads'), row.browser.profile);
        if (cleared)
          try {
            await removeOwned(
              join(this.store.root, 'downloads/jobs'),
              dirname(row.browser.profile),
            );
          } catch {
            cleared = false;
          }
      }
      if (!cleared) clean = false;
      if (cleared) this.store.browser(row.id, null);
      if (row.status !== 'DONE') this.store.status(row.id, 'REVIEW', cleared);
      await this.flush(row.payload).catch(() => {});
      deliveries.push({ deliveryId: row.id, fence: row.payload.fence, cleanupComplete: cleared });
    }
    await this.hub('reconcile', {
      protocolVersion: '1.0',
      nodeId: this.nodeId,
      bootId: this.bootId,
      deliveries: deliveries.slice(-100),
      cleanupComplete: clean,
    });
  }
  async flush(delivery: Delivery) {
    for (let i = 0; i < 100; i++) {
      const events = this.store.pending(delivery.deliveryId);
      if (!events.length) return;
      const response = await this.hub('events', {
        kind: 'events',
        protocolVersion: '1.0',
        nodeId: this.nodeId,
        deliveryId: delivery.deliveryId,
        fence: delivery.fence,
        events,
      });
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
  async tick() {
    if (this.closed) return;
    if (this.current && Date.now() >= this.lease) {
      this.control = 'REVIEW';
      this.abort?.abort();
    }
    if (this.busy || this.running) return;
    this.busy = true;
    try {
      for (const row of this.store
        .deliveries()
        .filter((r) => r.status === 'DONE' || r.status === 'COMPLETED')) {
        await this.flush(row.payload);
        if (row.status === 'COMPLETED') this.store.status(row.id, 'DONE', true);
      }
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
        .catch(async () => {
          this.store.status(delivery.deliveryId, 'REVIEW');
          const row = this.store.deliveries().find((r) => r.id === delivery.deliveryId)!;
          await this.hub('reconcile', {
            protocolVersion: '1.0',
            nodeId: this.nodeId,
            bootId: this.bootId,
            deliveries: [
              {
                deliveryId: delivery.deliveryId,
                fence: delivery.fence,
                cleanupComplete: row.clean,
              },
            ],
            cleanupComplete: row.clean,
          }).catch(() => {});
        })
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
      this.store.append(d, { type: 'STOP_ACK', payload: { cleanupComplete: true } });
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
      sha(canonical(snapshot.config)) !== d.configHash ||
      (snapshot.config as TestConfiguration).execution.mode !== 'DOWNLOAD_ONLY'
    )
      throw Error('CONFIG_HASH_MISMATCH');
    this.store.status(d.deliveryId, 'RUNNING');
    this.store.append(d, {
      type: 'RUN_STARTED',
      payload: { configHash: d.configHash, releaseId: d.releaseId },
    });
    const emit = async (event: {
      type: string;
      taskId?: string;
      payload: Record<string, unknown>;
    }) => {
      this.store.append(d, event);
      await this.flush(d).catch(() => {});
    };
    try {
      await runDownload(
        snapshot.config as TestConfiguration,
        this.nodeId,
        join(this.store.root, 'downloads'),
        this.toolsRoot,
        signal,
        emit,
        {
          ...this.options,
          beforeAction: () => {
            if (Date.now() >= this.lease || this.control !== 'CONTINUE') {
              if (this.control !== 'STOP') this.control = 'REVIEW';
              this.abort?.abort();
              throw Error('EXECUTION_STOPPED');
            }
            this.options.beforeAction?.();
          },
          onBrowser: async (record) => {
            this.store.browser(d.deliveryId, record);
            await this.options.onBrowser?.(record);
          },
          onClosed: async () => {
            this.store.browser(d.deliveryId, null);
            await this.options.onClosed?.();
          },
        },
      );
      this.store.status(d.deliveryId, 'COMPLETED', true);
      await this.flush(d);
      this.store.status(d.deliveryId, 'DONE', true);
    } catch (error) {
      const row = this.store.deliveries().find((r) => r.id === d.deliveryId)!;
      if (signal.aborted && this.control === 'STOP') {
        this.store.append(d, { type: 'STOP_ACK', payload: { cleanupComplete: row.clean } });
        await this.flush(d);
        this.store.status(d.deliveryId, row.clean ? 'DONE' : 'REVIEW', row.clean);
      } else {
        this.store.status(d.deliveryId, 'REVIEW', row.clean);
        await this.hub('reconcile', {
          protocolVersion: '1.0',
          nodeId: this.nodeId,
          bootId: this.bootId,
          deliveries: [{ deliveryId: d.deliveryId, fence: d.fence, cleanupComplete: row.clean }],
          cleanupComplete: row.clean,
        }).catch(() => {});
        throw error;
      }
    }
  }
  async close() {
    this.closed = true;
    this.control = 'REVIEW';
    this.abort?.abort();
    await this.running;
    this.store.close();
    await this.unlock();
  }
}
