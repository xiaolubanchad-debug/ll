import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { DailyExecutionPlan, TestConfiguration } from '@apk/contracts';
import { describeApkFile } from './apk.js';
import { ApkCache, removeOwned } from './cache.js';
import { DownloadError, normalizeUrl } from './common.js';
import type { AutomationEvent, DownloadOptions } from './download.js';
import { NetworkPolicy } from './network.js';

async function openDirect(
  value: string,
  policy: NetworkPolicy,
  signal: AbortSignal,
  userAgent?: string,
) {
  let url = normalizeUrl(value);
  for (let redirects = 0; redirects <= 5; redirects++) {
    signal.throwIfAborted();
    const endpoint = await policy.endpoint(url);
    const request = endpoint.url.protocol === 'https:' ? httpsRequest : httpRequest;
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      request(
        endpoint.url,
        {
          agent: false,
          signal,
          family: isIP(endpoint.address),
          lookup: (_hostname, _options, callback) =>
            callback(null, endpoint.address, isIP(endpoint.address)),
          headers: {
            'accept-encoding': 'identity',
            ...(userAgent ? { 'user-agent': userAgent } : {}),
          },
        },
        resolve,
      )
        .once('error', reject)
        .end();
    });
    const status = response.statusCode ?? 0;
    if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
      response.destroy();
      url = normalizeUrl(new URL(response.headers.location, url).href);
      continue;
    }
    if (status === 200 && !response.headers['content-range']) return { response, url };
    response.destroy();
    throw new DownloadError(
      [401, 403, 410].includes(status)
        ? 'APK_LINK_REJECTED'
        : status === 404
          ? 'APK_LINK_NOT_FOUND'
          : 'APK_DOWNLOAD_HTTP_FAILED',
    );
  }
  throw new DownloadError('APK_REDIRECT_LIMIT');
}

function transferName(response: IncomingMessage, url: string) {
  const disposition = response.headers['content-disposition'] ?? '';
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const name = disposition.match(/filename="([^"]+)"|filename=([^;]+)/i);
  const fallback = new URL(url).pathname.split('/').at(-1) || 'download.apk';
  try {
    return encoded
      ? decodeURIComponent(encoded)
      : (name?.[1] ?? name?.[2] ?? decodeURIComponent(fallback));
  } catch {
    return fallback;
  }
}

export async function runDirectApk(
  config: TestConfiguration,
  plan: DailyExecutionPlan,
  nodeId: string,
  root: string,
  signal: AbortSignal,
  emit: (event: AutomationEvent) => Promise<void>,
  options: DownloadOptions,
) {
  const action = plan.resourceAction;
  if (action?.kind !== 'FETCH') throw new DownloadError('EXECUTION_PLAN_INVALID');
  const taskId = randomUUID();
  const max = config.download.maxApkBytes ?? 268435456;
  const timeout = AbortSignal.timeout(config.download.timeoutMs);
  const transferSignal = AbortSignal.any([signal, timeout]);
  let code: string | undefined;
  let temporary: string | undefined;
  let cache: ApkCache | undefined;
  let response: IncomingMessage | undefined;
  await emit({
    type: 'TARGETS_DISCOVERED',
    payload: {
      targets: [
        {
          taskId,
          targetKey: action.cacheKey,
          label: action.label,
          sourceUrl: normalizeUrl(config.source.url),
        },
      ],
    },
  });
  await emit({ type: 'TASK_STAGE', taskId, payload: { stage: 'DOWNLOADING' } });
  try {
    options.beforeAction?.();
    const jobs = join(root, 'jobs');
    await mkdir(jobs, { recursive: true, mode: 0o700 });
    temporary = await mkdtemp(join(jobs, 'download-'));
    await options.onBrowser?.({ pid: 0, profile: join(temporary, 'profile') });
    const file = join(temporary, 'body.apk');
    const result = await openDirect(
      action.url,
      options.policy ?? new NetworkPolicy(),
      transferSignal,
      config.source.browserUserAgent,
    );
    response = result.response;
    if (/^(?:text\/html|application\/xhtml\+xml)\b/i.test(response.headers['content-type'] ?? ''))
      throw new DownloadError('APK_RESPONSE_HTML');
    const length = response.headers['content-length'];
    const total = length === undefined ? null : Number(length);
    if (total !== null && (!Number.isSafeInteger(total) || total < 1))
      throw new DownloadError('FILE_TRANSFER_MISMATCH');
    if (total !== null && total > max) throw new DownloadError('APK_TOO_LARGE');
    let count = 0;
    let lastReport = 0;
    let prefix = Buffer.alloc(0);
    const report = async () => {
      lastReport = Date.now();
      await emit({
        type: 'RESOURCE_PROGRESS',
        taskId,
        payload: { receivedBytes: count, totalBytes: total },
      });
    };
    await pipeline(
      response,
      async function* (input: AsyncIterable<Buffer>) {
        for await (const chunk of input) {
          options.beforeAction?.();
          count += chunk.length;
          if (count > max) throw new DownloadError('APK_TOO_LARGE');
          if (total !== null && count > total) throw new DownloadError('FILE_TRANSFER_MISMATCH');
          if (prefix.length < 256) {
            prefix = Buffer.concat([prefix, chunk.subarray(0, 256 - prefix.length)]);
            if (/^\s*(?:<!doctype\s+html|<html\b|<head\b|<body\b)/i.test(prefix.toString('utf8')))
              throw new DownloadError('APK_RESPONSE_HTML');
          }
          if (Date.now() - lastReport >= 1000) await report();
          yield chunk;
        }
      },
      createWriteStream(file, { flags: 'wx', mode: 0o600 }),
      { signal: transferSignal },
    );
    if (!response.complete || !count || (total !== null && count !== total))
      throw new DownloadError('FILE_TRANSFER_MISMATCH');
    await report();
    const apk = await describeApkFile(
      file,
      max,
      plan.cacheDay,
      transferName(response, result.url),
      signal,
    );
    options.beforeAction?.();
    cache = await ApkCache.open(join(root, 'resources'));
    apk.fileName = cache.availableName(
      nodeId,
      plan.cacheDay,
      action.cacheKey,
      apk.fileName!,
      apk.apkSha256,
    );
    await cache.put(nodeId, plan.cacheDay, action.cacheKey, file, apk);
    await emit({ type: 'TASK_STAGE', taskId, payload: { stage: 'DOWNLOADED', apk } });
  } catch (error) {
    if (signal.aborted) throw error;
    code = timeout.aborted
      ? 'APK_DOWNLOAD_TIMEOUT'
      : error instanceof DownloadError
        ? error.code
        : 'APK_DOWNLOAD_INTERRUPTED';
  } finally {
    response?.destroy();
    cache?.close();
    if (temporary) await removeOwned(join(root, 'jobs'), temporary);
    await options.onClosed?.();
  }
  await emit({
    type: 'TASK_FINISHED',
    taskId,
    payload: {
      status: code ? 'FAILED' : 'SUCCEEDED',
      proof: code ? 'NONE' : 'FILE_VALIDATION',
      artifactIds: [],
      ...(code ? { errorCode: code } : {}),
    },
  });
  await emit({
    type: 'RUN_FINISHED',
    payload: { status: code ? 'FAILED' : 'SUCCEEDED', ...(code ? { errorCode: code } : {}) },
  });
}
