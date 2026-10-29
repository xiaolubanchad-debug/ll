import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { runEvents, claimRun, acceptRun, digest, encrypt } from '@apk/platform';
import { functionalEvidenceText } from '@apk/contracts';

test('database policy binds functional evidence to the result and refuses queued old nodes', async () => {
  const db = new PrismaClient(),
    nodeId = randomUUID(),
    configId = randomUUID(),
    versionId = randomUUID(),
    releaseId = randomUUID(),
    runId = randomUUID(),
    deliveryId = randomUUID(),
    taskId = randomUUID(),
    accountRef = randomUUID(),
    artifactId = randomUUID(),
    bootId = randomUUID(),
    token = randomBytes(32).toString('base64url');
  const file = join(process.env.ARTIFACT_DIR, artifactId + '.json');
  const config = JSON.parse(await readFile('contracts/fixtures/config.valid.json', 'utf8'));
  config.execution.mode = 'FULL';
  const content = (stage, outcome) =>
    Buffer.from(
      functionalEvidenceText({
        schemaVersion: '1.0',
        kind: 'FUNCTIONAL_EVIDENCE',
        stage,
        outcome,
        verification: stage === 'RESULT' ? 'CONFIGURED_LOCATOR' : 'NO_SUBMISSION',
        sourceDigest: 'c'.repeat(64),
        controls: [],
      }),
    );
  const features = ['DOWNLOAD_V1', 'REGISTRATION_V1', 'CONTENT_ISOLATION_V1'];
  try {
    await db.release.create({
      data: {
        id: releaseId,
        sha256: digest(releaseId),
        artifactName: 'agent-' + digest(releaseId) + '.tgz',
        manifest: { features },
      },
    });
    await db.node.create({
      data: {
        id: nodeId,
        name: 'Owned content isolation policy',
        host: '192.0.2.110',
        agentVersion: '0.8.0',
        agentReleaseId: releaseId,
        downloadProtocol: '1.0',
        slot: { create: { fence: 1 } },
      },
    });
    await db.agentCredential.create({
      data: { nodeId, tokenHash: digest(token), releaseId, bootId },
    });
    await db.configuration.create({ data: { id: configId, name: 'Owned isolation fixture' } });
    await db.configVersion.create({
      data: {
        id: versionId,
        configId,
        version: 1,
        body: config,
        configHash: digest(JSON.stringify(config)),
        createdBy: randomUUID(),
      },
    });
    await db.run.create({
      data: {
        id: runId,
        nodeId,
        releaseId,
        configVersionId: versionId,
        status: 'RUNNING',
        discovered: true,
        purpose: 'REGISTER',
        successTarget: 1,
        attemptLimit: 2,
        attemptsStarted: 1,
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
    await db.task.create({
      data: {
        id: taskId,
        runId,
        position: 0,
        label: 'Owned functional policy',
        sourceUrl: 'https://example.test/',
        targetKey: digest(taskId),
        status: 'VERIFYING',
        apk: { packageName: 'com.example.app', apkSha256: 'd'.repeat(64) },
        observation: { profileId: 'owned' },
        accountRef,
        submissionId: randomUUID(),
        attemptStarted: true,
      },
    });
    await db.accountResult.create({
      data: {
        accountRef,
        taskId,
        deliveryId,
        fence: 1,
        encrypted: encrypt(
          { username: 'ownedfixture', password: 'Owned12345' },
          'account:' + accountRef,
        ),
        contentHash: digest(accountRef),
      },
    });
    await mkdir(process.env.ARTIFACT_DIR, { recursive: true });
    let bytes = content('DISCOVERY', 'UNVERIFIED');
    await writeFile(file, bytes);
    await db.artifact.create({
      data: {
        id: artifactId,
        taskId,
        deliveryId,
        fence: 1,
        kind: 'functional-evidence',
        sha256: digest(bytes),
        bytes: bytes.length,
        storageKey: artifactId + '.json',
      },
    });
    const message = () => ({
      kind: 'events',
      protocolVersion: '1.0',
      nodeId,
      deliveryId,
      fence: 1,
      events: [
        {
          eventId: randomUUID(),
          sequence: 1,
          runId,
          taskId,
          type: 'TASK_FINISHED',
          occurredAt: new Date().toISOString(),
          payload: { status: 'SUCCEEDED', proof: 'APP_UI', artifactIds: [artifactId], accountRef },
        },
      ],
    });
    for (const pair of [
      ['DISCOVERY', 'UNVERIFIED'],
      ['RESULT', 'FAILED'],
    ]) {
      bytes = content(...pair);
      await writeFile(file, bytes);
      await db.artifact.update({
        where: { id: artifactId },
        data: { sha256: digest(bytes), bytes: bytes.length },
      });
      await assert.rejects(runEvents(db, token, message()), (e) => e.code === 'EVENT_CONFLICT');
      assert.equal(
        (await db.task.findUniqueOrThrow({ where: { id: taskId } })).status,
        'VERIFYING',
      );
      assert.equal((await db.run.findUniqueOrThrow({ where: { id: runId } })).successes, 0);
      assert.equal(
        await db.runEvent.count({ where: { deliveryId } }),
        0,
        'rejected event transaction rolls back',
      );
    }
    bytes = content('RESULT', 'SUCCEEDED');
    await writeFile(file, bytes);
    await db.artifact.update({
      where: { id: artifactId },
      data: { sha256: digest(bytes), bytes: bytes.length },
    });
    await runEvents(db, token, message());
    assert.equal((await db.run.findUniqueOrThrow({ where: { id: runId } })).successes, 1);
    await db.run.update({ where: { id: runId }, data: { status: 'SUCCEEDED' } });
    const queued = await db.run.create({
      data: {
        nodeId,
        releaseId,
        configVersionId: versionId,
        purpose: 'REGISTER',
        successTarget: 1,
        attemptLimit: 2,
      },
    });
    await db.nodeSlot.update({ where: { nodeId }, data: { runId: queued.id } });
    await db.node.update({ where: { id: nodeId }, data: { agentVersion: '0.7.2' } });
    await assert.rejects(
      claimRun(db, token, { kind: 'claim', protocolVersion: '1.0', nodeId, bootId }),
      (e) => e.code === 'NODE_UPGRADE_REQUIRED',
    );
    assert.equal(await db.delivery.count({ where: { runId: queued.id } }), 0);
    const assigned = await db.delivery.create({
      data: {
        runId: queued.id,
        bootId,
        fence: 1,
        ackDeadline: new Date(Date.now() + 30000),
        leaseExpiresAt: new Date(Date.now() + 120000),
      },
    });
    await db.run.update({ where: { id: queued.id }, data: { status: 'ASSIGNED' } });
    await assert.rejects(
      acceptRun(db, token, assigned.id, {
        kind: 'accept',
        protocolVersion: '1.0',
        nodeId,
        bootId,
        deliveryId: assigned.id,
        fence: 1,
      }),
      (e) => e.code === 'NODE_UPGRADE_REQUIRED',
    );
  } finally {
    const runs = (await db.run.findMany({ where: { nodeId }, select: { id: true } })).map(
        (r) => r.id,
      ),
      ds = (
        await db.delivery.findMany({ where: { runId: { in: runs } }, select: { id: true } })
      ).map((d) => d.id);
    await db.artifact.deleteMany({ where: { deliveryId: { in: ds } } });
    await db.runEvent.deleteMany({ where: { deliveryId: { in: ds } } });
    await db.accountResult.deleteMany({ where: { deliveryId: { in: ds } } });
    await db.task.deleteMany({ where: { runId: { in: runs } } });
    await db.delivery.deleteMany({ where: { id: { in: ds } } });
    await db.run.deleteMany({ where: { id: { in: runs } } });
    await db.nodeSlot.deleteMany({ where: { nodeId } });
    await db.agentCredential.deleteMany({ where: { nodeId } });
    await db.node.deleteMany({ where: { id: nodeId } });
    await db.configVersion.deleteMany({ where: { configId } });
    await db.configuration.deleteMany({ where: { id: configId } });
    await db.release.deleteMany({ where: { id: releaseId } });
    await rm(file, { force: true });
    await db.$disconnect();
  }
});
