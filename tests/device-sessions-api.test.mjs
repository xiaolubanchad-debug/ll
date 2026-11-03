import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  agentHeartbeat,
  controlTaskPlan,
  createSecret,
  digest,
  reconcileAgent,
  runEvents,
  runSummary,
  runTimeline,
  tickTaskPlans,
} from '@apk/platform';
import { beijingDay } from '../packages/platform/dist/daily-plan.js';

for (const scenario of [
  'serial',
  'parallel',
  'recover',
  'quarantine',
  'auto-restart',
  'manual-stop',
  'preserve',
  'preparation',
  'auto-restart-queue',
])
  test('database enforces grouped execution and cleanup: ' + scenario, async () => {
    const concurrency = scenario === 'parallel' ? 2 : 1;
    const managed = ['auto-restart', 'manual-stop', 'auto-restart-queue'].includes(scenario);
    const preserve = ['preserve', 'preparation', 'auto-restart-queue'].includes(scenario);
    const agentVersion = preserve ? '0.17.2' : '0.13.0';
    const db = new PrismaClient(),
      nodeId = randomUUID(),
      releaseId = randomUUID(),
      configId = randomUUID(),
      versionId = randomUUID(),
      runId = randomUUID(),
      deliveryId = randomUUID(),
      bootId = randomUUID(),
      managedId = randomUUID(),
      cycleId = randomUUID(),
      downloadId = randomUUID(),
      token = randomBytes(32).toString('base64url');
    const config = JSON.parse(
      await readFile('contracts/fixtures/config.concurrent-open.valid.json', 'utf8'),
    );
    config.execution.appOpen.appsPerDevice = { min: 2, max: 2 };
    config.execution.appOpen.randomDeviceProfile = true;
    const day = beijingDay(new Date()),
      tasks = Array.from({ length: 4 }, () => randomUUID());
    const assets = [0, 1].map((i) => ({
      targetKey: digest('asset' + i),
      label: 'APP ' + i,
      sourceUrl: config.source.url,
      apk: {
        packageName: 'com.example.app' + i,
        versionName: '1',
        versionCode: 1,
        abis: [],
        minSdkVersion: 26,
        size: 10,
        apkSha256: digest('bytes' + i),
        cacheDay: day,
      },
    }));
    const sessions = [
      { id: randomUUID(), variantId: 'phone-01', assetIndexes: [1, 0] },
      { id: randomUUID(), variantId: 'phone-02', assetIndexes: [0, 1] },
    ];
    const plan = {
      purpose: 'REGISTER',
      cacheDay: day,
      successTarget: 4,
      attemptLimit: 4,
      assets,
      openPolicy: {
        concurrency,
        dailyLimit: 800,
        admissionDeadline: new Date(Date.now() + 3600000).toISOString(),
        sessions,
        ...(preserve ? { preserveQueue: true } : {}),
      },
    };
    let seq = 1;
    async function send(index, type, payload) {
      const e = {
        eventId: randomUUID(),
        runId,
        ...(index === null ? {} : { taskId: tasks[index] }),
        sequence: seq,
        occurredAt: new Date().toISOString(),
        type,
        payload,
      };
      const result = await runEvents(db, token, {
        kind: 'events',
        protocolVersion: '1.0',
        nodeId,
        deliveryId,
        fence: 1,
        events: [e],
      });
      seq++;
      return result;
    }
    const epoch = (value) => (preserve ? { deviceEpoch: value } : {});
    const start = (id, instance = 1) =>
      send(null, 'DEVICE_SESSION', {
        sessionId: id,
        phase: 'STARTED',
        elapsedMs: 0,
        cleanupComplete: false,
        ...epoch(instance),
      });
    const close = (id, skipRemaining = false, instance = 1, replacementReason) =>
      send(null, 'DEVICE_SESSION', {
        sessionId: id,
        phase: 'CLOSED',
        elapsedMs: 100000,
        cleanupComplete: true,
        ...epoch(instance),
        ...(replacementReason ? { replacementReason } : {}),
        ...(skipRemaining ? { skipRemaining: true } : {}),
      });
    async function finish(index, instance = 1, installError) {
      const group = sessions[Math.floor(index / 2)],
        appIndex = index % 2,
        asset = assets[group.assetIndexes[appIndex]];
      const observation = {
        profileId: config.execution.deviceProfiles[0].id,
        avdName: 'p3_' + digest(group.id + ':' + instance).slice(0, 32),
        apiLevel: 31,
        model: group.variantId === 'phone-01' ? '21081111RG' : '2107113SG',
        locale: 'en-US',
        shellAndroidIdHash: digest(group.id),
        androidIdScope: 'SHELL_NOT_APP',
        proxyIpScope: 'NOT_CHECKED',
        appUserAgent: 'UNVERIFIED',
        identitySource: 'EMULATOR_NOT_REAL_DEVICE',
        variantId: group.variantId,
        systemImageSha256: digest('image'),
        deviceSessionId: group.id,
        ...epoch(instance),
        appIndex,
      };
      for (const stage of ['DOWNLOADED', 'PREPARING', 'INSTALLING', 'LAUNCHING', 'HOLDING']) {
        await send(index, 'TASK_STAGE', {
          stage,
          ...(stage === 'DOWNLOADED' ? { apk: asset.apk, cacheHit: true } : {}),
          ...(stage === 'INSTALLING' ? { observation } : {}),
        });
        if (installError && stage === 'INSTALLING') {
          await send(index, 'TASK_FINISHED', {
            status: 'FAILED',
            proof: 'NONE',
            artifactIds: [],
            errorCode: installError,
          });
          return;
        }
      }
      const payload = {
        status: 'SUCCEEDED',
        proof: 'APP_OPEN',
        artifactIds: [],
        openObservation: {
          dwellMs: 10000,
          elapsedMs: 10005,
          samples: 11,
          scope: 'FOREGROUND_POLL_ONLY',
          cleanupComplete: true,
          cleanupScope: 'APP_UNINSTALLED',
          deviceSessionId: group.id,
          ...epoch(instance),
          appIndex,
        },
      };
      const bad = structuredClone(payload);
      delete bad.openObservation.cleanupScope;
      await assert.rejects(send(index, 'TASK_FINISHED', bad));
      await send(index, 'TASK_FINISHED', payload);
    }
    let proxy;
    try {
      const admin = await db.admin.findFirstOrThrow();
      if (scenario === 'auto-restart-queue') {
        proxy = await createSecret(
          db,
          {
            type: 'HTTP_PROXY',
            name: 'Owned queue fixture',
            secretValue: {
              host: 'proxy.example.test',
              port: 10000,
              username: 'fixture',
              password: 'FixturePassword123',
            },
          },
          admin.id,
          'queue-fixture',
        );
        config.execution.proxySecretVersionId = proxy.id;
      }
      await db.release.create({
        data: {
          id: releaseId,
          artifactName: 'agent-' + digest(releaseId) + '.tgz',
          sha256: digest(releaseId),
          manifest: {
            agentVersion,
            toolchain: { systemImage: config.execution.deviceProfiles[0].systemImage },
            features: [
              'DOWNLOAD_V1',
              'REGISTRATION_V1',
              'CONTENT_ISOLATION_V1',
              'APP_OPEN_V1',
              'APP_OPEN_PARALLEL_V1',
              'DEVICE_VARIANTS_V1',
              'DEVICE_SESSIONS_V1',
              'DAILY_V1',
            ],
          },
        },
      });
      await db.node.create({
        data: {
          id: nodeId,
          name: 'Owned session fixture',
          host: '192.0.2.115',
          agentVersion,
          agentReleaseId: releaseId,
          deploymentStatus: 'INSTALLED',
          health: { versions: { identityModels: '30' } },
          slot: { create: { fence: 1 } },
        },
      });
      await db.agentCredential.create({
        data: { nodeId, tokenHash: digest(token), releaseId, bootId },
      });
      await db.configuration.create({
        data: { id: configId, name: 'Grouped APP fixture' },
      });
      await db.configVersion.create({
        data: {
          id: versionId,
          configId,
          version: 1,
          body: config,
          configHash: digest('config'),
          createdBy: randomUUID(),
        },
      });
      if (scenario === 'auto-restart-queue')
        await db.run.create({
          data: {
            id: downloadId,
            nodeId,
            configVersionId: versionId,
            cacheDay: day,
            status: 'SUCCEEDED',
            purpose: 'DOWNLOAD',
          },
        });
      if (managed) {
        await db.managedTask.create({
          data: {
            id: managedId,
            name: 'Managed cleanup test',
            nodeId,
            configId,
            currentVersionId: versionId,
            enabled: true,
            successTarget: 4,
            attemptLimit: 4,
            createdBy: admin.id,
          },
        });
        await db.managedCycle.create({
          data: {
            id: cycleId,
            taskId: managedId,
            nodeId,
            configVersionId: versionId,
            releaseId,
            day,
            status: 'REGISTERING',
            ...(scenario === 'auto-restart-queue' ? { downloadRunId: downloadId } : {}),
            successTarget: 4,
            attemptLimit: 4,
          },
        });
      }
      await db.run.create({
        data: {
          id: runId,
          nodeId,
          releaseId,
          configVersionId: versionId,
          configHash: digest('config'),
          cacheDay: day,
          status: 'RUNNING',
          discovered: true,
          purpose: 'REGISTER',
          successTarget: 4,
          attemptLimit: 4,
          executionPlan: plan,
          ...(scenario === 'auto-restart-queue' ? { sourceDownloadId: downloadId } : {}),
          ...(managed ? { taskCycleId: cycleId, createdBy: admin.id } : {}),
        },
      });
      await db.nodeSlot.update({ where: { nodeId }, data: { runId } });
      await db.delivery.create({
        data: {
          id: deliveryId,
          runId,
          bootId,
          fence: 1,
          acceptedAt: new Date(),
          ackDeadline: new Date(Date.now() + 30000),
          leaseExpiresAt: new Date(Date.now() + 120000),
        },
      });
      await db.task.createMany({
        data: tasks.map((id, position) => ({
          id,
          runId,
          position,
          targetKey: digest(id),
          label: 'APP ' + position,
          sourceUrl: config.source.url,
        })),
      });
      await assert.rejects(send(0, 'TASK_STAGE', { stage: 'DOWNLOADING' }));
      await start(sessions[0].id);
      if (concurrency === 2) await start(sessions[1].id);
      else await assert.rejects(start(sessions[1].id));
      await assert.rejects(start(sessions[0].id));
      if (scenario === 'preparation') {
        await close(sessions[0].id, false, 1, 'APPIUM_FAILED');
        await start(sessions[0].id, 2);
        await close(sessions[0].id, false, 2, 'APPIUM_FAILED');
        await assert.rejects(start(sessions[0].id, 3));
        await send(null, 'RUN_FINISHED', {
          status: 'FAILED',
          errorCode: 'DEVICE_PREPARATION_FAILED',
        });
        assert.equal((await db.run.findUniqueOrThrow({ where: { id: runId } })).attemptsStarted, 0);
        assert.equal(
          await db.task.count({ where: { runId, status: 'QUEUED', attemptStarted: false } }),
          4,
        );
        return;
      }
      await send(0, 'TASK_STAGE', { stage: 'DOWNLOADING' });
      await assert.rejects(send(1, 'TASK_STAGE', { stage: 'DOWNLOADING' }));
      if (scenario === 'preserve') {
        await finish(0, 1, 'APP_CLEANUP_UNCONFIRMED');
        await assert.rejects(send(1, 'TASK_STAGE', { stage: 'DOWNLOADING' }));
        await assert.rejects(start(sessions[0].id, 2));
        await assert.rejects(close(sessions[0].id, true));
        await close(sessions[0].id, false, 1, 'APP_CLEANUP_UNCONFIRMED');
        await assert.rejects(start(sessions[1].id));
        await start(sessions[0].id, 2);
        await send(1, 'TASK_STAGE', { stage: 'DOWNLOADING' });
        await finish(1, 2);
        await close(sessions[0].id, false, 2);
        await start(sessions[1].id);
        await send(2, 'TASK_STAGE', { stage: 'DOWNLOADING' });
        await finish(2, 1, 'APK_INSTALL_FAILED');
        await send(3, 'TASK_STAGE', { stage: 'DOWNLOADING' });
        await finish(3);
        await close(sessions[1].id);
        await send(null, 'RUN_FINISHED', { status: 'PARTIAL_FAILED', errorCode: 'ATTEMPT_LIMIT' });
        assert.deepEqual((await runSummary(db, runId)).deviceSessions, {
          started: 3,
          closed: 3,
          failed: 0,
          active: 0,
        });
        return;
      }
      if (scenario === 'recover' || scenario === 'quarantine' || managed) {
        const failed = {
          status: 'FAILED',
          proof: 'NONE',
          artifactIds: [],
          errorCode: 'APP_CLEANUP_UNCONFIRMED',
        };
        const skipped = {
          status: 'SKIPPED',
          proof: 'NONE',
          artifactIds: [],
          errorCode: 'DEVICE_SESSION_SKIPPED',
        };
        await assert.rejects(send(1, 'TASK_FINISHED', skipped));
        await assert.rejects(close(sessions[0].id, true));
        await send(0, 'TASK_FINISHED', failed);
        await assert.rejects(send(1, 'TASK_STAGE', { stage: 'DOWNLOADING' }));
        await assert.rejects(start(sessions[1].id));
        if (scenario !== 'recover') {
          await send(null, 'DEVICE_SESSION', {
            sessionId: sessions[0].id,
            phase: 'FAILED',
            elapsedMs: 100000,
            cleanupComplete: false,
            ...epoch(1),
          });
          await assert.rejects(start(sessions[1].id));
          await send(null, 'RUN_FINISHED', {
            status: 'NEEDS_REVIEW',
            errorCode: 'CLEANUP_INCOMPLETE',
          });
          const slot = await db.nodeSlot.findUniqueOrThrow({ where: { nodeId } });
          assert.equal(slot.quarantined, true);
          const pending = await db.task.findUniqueOrThrow({ where: { id: tasks[1] } });
          assert.equal(pending.status, preserve ? 'QUEUED' : 'SKIPPED');
          assert.equal(pending.errorCode, preserve ? 'DEVICE_QUEUE_PENDING' : 'BATCH_NEEDS_REVIEW');
          if (!managed) return;
          const cycle = () => db.managedCycle.findUniqueOrThrow({ where: { id: cycleId } });
          const original = await db.run.findUniqueOrThrow({ where: { id: runId } });
          assert.equal(original.stopRequested, true);
          assert.equal((await cycle()).errorCode, 'APP_CLEANUP_RESTART_PENDING');
          await assert.rejects(
            controlTaskPlan(
              db,
              managedId,
              { action: 'START' },
              1,
              admin.id,
              'fixture',
              randomUUID(),
            ),
            (e) => e.code === 'STOP_PENDING',
          );
          const finishedAt = new Date(Date.now() - 31000);
          await db.run.update({ where: { id: runId }, data: { finishedAt } });
          await tickTaskPlans(db);
          assert.equal((await cycle()).generation, 1, 'time alone cannot release the device');
          await db.run.update({ where: { id: runId }, data: { finishedAt: original.finishedAt } });
          if (scenario === 'manual-stop')
            await controlTaskPlan(
              db,
              managedId,
              { action: 'STOP' },
              1,
              admin.id,
              'fixture',
              randomUUID(),
            );
          await reconcileAgent(db, token, {
            protocolVersion: '1.0',
            nodeId,
            bootId,
            reason: 'EXECUTION_ERROR',
            cleanupComplete: true,
            deliveries: [{ deliveryId, fence: 1, cleanupComplete: true, submissions: [] }],
          });
          await db.run.update({ where: { id: runId }, data: { finishedAt } });
          await tickTaskPlans(db);
          assert.equal(
            (await cycle()).generation,
            1,
            'a cleanup receipt needs a new idle heartbeat',
          );
          const heartbeat = JSON.parse(
            await readFile('contracts/fixtures/agent.valid.json', 'utf8'),
          ).find((m) => m.kind === 'heartbeat');
          await agentHeartbeat(db, token, {
            ...heartbeat,
            nodeId,
            releaseId,
            bootId,
            agentVersion,
            ...(preserve
              ? {
                  capabilities: {
                    ...heartbeat.capabilities,
                    downloadProtocol: '1.0',
                    registrationProtocol: '1.0',
                  },
                  report: JSON.parse(
                    await readFile('contracts/fixtures/health.incremental.valid.json', 'utf8'),
                  ),
                }
              : {}),
            sentAt: new Date().toISOString(),
            currentDelivery: null,
          });
          if (scenario === 'manual-stop') {
            await tickTaskPlans(db);
            assert.equal((await cycle()).status, 'STOPPED');
            assert.equal((await cycle()).generation, 1);
          } else {
            await db.run.update({ where: { id: runId }, data: { finishedAt: new Date() } });
            await tickTaskPlans(db);
            assert.equal(
              (await cycle()).generation,
              1,
              'restart cannot occur before thirty seconds',
            );
            await db.run.update({ where: { id: runId }, data: { finishedAt } });
            await tickTaskPlans(db);
            const restarted = await cycle();
            assert.equal(restarted.generation, 2);
            assert.equal(restarted.status, 'QUEUED');
            assert.equal(restarted.attemptLimit, 4);
            const old = await db.run.findUniqueOrThrow({ where: { id: runId } });
            assert.equal(old.status, 'NEEDS_REVIEW');
            assert.equal(old.attemptsStarted, 1);
            if (scenario === 'auto-restart-queue') {
              await Promise.all([tickTaskPlans(db), tickTaskPlans(db)]);
              const resumed = await db.run.findMany({
                where: { nodeId, purpose: 'REGISTER', id: { not: runId } },
              });
              assert.equal(resumed.length, 1, JSON.stringify(await cycle()));
              assert.equal(resumed[0].sourceDownloadId, downloadId);
              assert.equal(resumed[0].supersedesRunId, runId);
              assert.equal(resumed[0].attemptLimit, 3);
              assert.equal(resumed[0].successTarget, 3);
              assert.deepEqual(resumed[0].executionPlan.assets, assets);
              assert.deepEqual(
                resumed[0].executionPlan.openPolicy.sessions.map((g) => g.assetIndexes),
                [[0], [0, 1]],
              );
              assert.equal(await db.run.count({ where: { nodeId, purpose: 'DOWNLOAD' } }), 1);
              assert.equal(
                (await db.task.findUniqueOrThrow({ where: { id: tasks[1] } })).errorCode,
                'DEVICE_QUEUE_TRANSFERRED',
              );
            }
          }
          return;
        }
        await close(sessions[0].id, true);
        const retired = await db.task.findUniqueOrThrow({ where: { id: tasks[1] } });
        assert.equal(retired.status, 'SKIPPED');
        assert.equal(retired.errorCode, 'DEVICE_SESSION_SKIPPED');
        assert.equal(retired.attemptStarted, false);
        const exhausted = { status: 'PARTIAL_FAILED', errorCode: 'DEVICE_PLAN_EXHAUSTED' };
        await assert.rejects(send(null, 'RUN_FINISHED', exhausted));
        await start(sessions[1].id);
        for (const index of [2, 3]) {
          await send(index, 'TASK_STAGE', { stage: 'DOWNLOADING' });
          await finish(index);
        }
        await assert.rejects(close(sessions[1].id, true));
        await close(sessions[1].id);
        await send(null, 'RUN_FINISHED', exhausted);
        const run = await db.run.findUniqueOrThrow({ where: { id: runId } });
        assert.equal(run.attemptsStarted, 3);
        assert.equal(run.successes, 2);
        assert.equal(run.status, 'PARTIAL_FAILED');
        const slot = await db.nodeSlot.findUniqueOrThrow({ where: { nodeId } });
        assert.equal(slot.runId, null);
        assert.equal(slot.quarantined, false);
        return;
      }
      if (concurrency === 2) await send(2, 'TASK_STAGE', { stage: 'DOWNLOADING' });
      await assert.rejects(close(sessions[0].id));
      if (concurrency === 2) await finish(2);
      await finish(0);
      await send(1, 'TASK_STAGE', { stage: 'DOWNLOADING' });
      await finish(1);
      await close(sessions[0].id);
      if (concurrency === 1) {
        await start(sessions[1].id);
        await send(2, 'TASK_STAGE', { stage: 'DOWNLOADING' });
        await finish(2);
      }
      await send(3, 'TASK_STAGE', { stage: 'DOWNLOADING' });
      await finish(3);
      await assert.rejects(send(null, 'RUN_FINISHED', { status: 'SUCCEEDED' }));
      await close(sessions[1].id);
      await send(null, 'RUN_FINISHED', { status: 'SUCCEEDED' });
      const run = await db.run.findUniqueOrThrow({ where: { id: runId } });
      assert.equal(run.successes, 4);
      assert.equal(run.attemptsStarted, 4);
      assert.equal(run.status, 'SUCCEEDED');
      const summary = await runSummary(db, runId);
      assert.deepEqual(summary.deviceSessions, { started: 2, closed: 2, failed: 0, active: 0 });
      const timeline = await runTimeline(db, runId, {});
      assert.ok(
        timeline.items.some((e) => e.deviceSessionId === sessions[1].id && e.appIndex === 1),
      );
      assert.ok(
        timeline.items.some((e) => e.type === 'DEVICE_SESSION' && e.title.includes('整机清理')),
      );
    } finally {
      await db.runEvent.deleteMany({ where: { deliveryId } });
      await db.task.deleteMany({ where: { runId } });
      await db.delivery.deleteMany({ where: { runId } });
      await db.nodeSlot.deleteMany({ where: { nodeId } });
      await db.agentCredential.deleteMany({ where: { nodeId } });
      await db.run.deleteMany({ where: { nodeId } });
      if (managed) {
        await db.managedCycle.deleteMany({ where: { id: cycleId } });
        await db.managedTask.deleteMany({ where: { id: managedId } });
      }
      await db.configVersion.deleteMany({ where: { configId } });
      await db.configuration.deleteMany({ where: { id: configId } });
      if (proxy) await db.secretVersion.delete({ where: { id: proxy.id } });
      await db.node.deleteMany({ where: { id: nodeId } });
      await db.release.deleteMany({ where: { id: releaseId } });
      await db.$disconnect();
    }
  });
