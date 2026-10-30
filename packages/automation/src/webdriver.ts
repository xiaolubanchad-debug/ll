import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import type { Locator, Rect } from './registration-types.js';
import { RegistrationError } from './registration-types.js';
import { safeUiSelector } from '@apk/contracts';

// Only this fixed adapter may address the job-owned loopback Appium server.
// Mutations are sent once. Only read-only lookup and snapshot recovery may retry within policy.
export class AppiumClient {
  session = '';
  constructor(
    readonly port: number,
    private readonly signal?: AbortSignal,
  ) {
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new RegistrationError('APPIUM_FAILED');
  }
  async command(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
    timeout = 10000,
    signal: AbortSignal | null = this.signal ?? null,
  ): Promise<unknown> {
    if (!/^\/[A-Za-z0-9_./%-]*$/.test(path)) throw new RegistrationError('APPIUM_FAILED');
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const reading = method === 'GET' && /\/(source|screenshot)$/.test(path);
    return new Promise((ok, no) => {
      let timedOut = false;
      const req = request(
        {
          host: '127.0.0.1',
          port: this.port,
          path,
          method,
          headers: {
            'content-type': 'application/json',
            ...(data ? { 'content-length': data.length } : {}),
          },
          agent: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (b: Buffer) => {
            size += b.length;
            if (size > 16 * 1024 * 1024) req.destroy();
            else chunks.push(b);
          });
          res.on('end', () => {
            try {
              const result = JSON.parse(Buffer.concat(chunks).toString()) as { value?: unknown };
              if ((res.statusCode ?? 500) >= 400) {
                const value = result.value as { error?: string } | undefined;
                if (
                  method === 'GET' &&
                  /\/element\/[A-Za-z0-9-]+\/enabled$/.test(path) &&
                  ['stale element reference', 'no such element'].includes(value?.error ?? '')
                )
                  throw new RegistrationError('APPIUM_ELEMENT_GONE');
                throw new RegistrationError(
                  !reading
                    ? 'APPIUM_FAILED'
                    : value?.error === 'invalid session id'
                      ? 'APPIUM_SESSION_LOST'
                      : (res.statusCode ?? 500) >= 500
                        ? 'APPIUM_READ_SERVER'
                        : 'APPIUM_READ_REJECTED',
                );
              }
              ok(result.value);
            } catch (error) {
              no(
                error instanceof RegistrationError
                  ? error
                  : new RegistrationError(reading ? 'APPIUM_READ_INVALID' : 'APPIUM_FAILED'),
              );
            }
          });
          res.on('error', () =>
            no(new RegistrationError(reading ? 'APPIUM_READ_CONNECTION' : 'APPIUM_FAILED')),
          );
        },
      );
      const timer = setTimeout(
        () => {
          timedOut = true;
          req.destroy();
        },
        Math.max(1, Math.min(timeout, 120000)),
      );
      const abort = () => req.destroy();
      req.on('close', () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      });
      req.on('error', () =>
        no(
          new RegistrationError(
            signal?.aborted
              ? 'CANCELLED'
              : !reading
                ? 'APPIUM_FAILED'
                : timedOut
                  ? 'APPIUM_READ_TIMEOUT'
                  : 'APPIUM_READ_CONNECTION',
          ),
        ),
      );
      if (signal?.aborted) abort();
      else {
        signal?.addEventListener('abort', abort, { once: true });
        req.end(data);
      }
    });
  }
  async start(capabilities: Record<string, unknown>) {
    const value = (await this.command(
      'POST',
      '/session',
      { capabilities: { alwaysMatch: capabilities, firstMatch: [{}] } },
      60000,
    )) as { sessionId?: unknown };
    if (typeof value?.sessionId !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(value.sessionId))
      throw new RegistrationError('APPIUM_FAILED');
    this.session = value.sessionId;
  }
  path(suffix: string) {
    return '/session/' + this.session + suffix;
  }
  async find(locator: Locator, timeout: number, signal?: AbortSignal) {
    const by = {
      id: 'id',
      accessibilityId: 'accessibility id',
      xpath: 'xpath',
      androidUiAutomator: '-android uiautomator',
    }[locator.by];
    if (locator.by === 'androidUiAutomator' && !safeUiSelector(locator.value))
      throw new RegistrationError('FLOW_STEP_FAILED');
    const deadline = Date.now() + timeout;
    do {
      if (signal?.aborted) throw new RegistrationError('CANCELLED');
      try {
        const values = await this.command(
          'POST',
          this.path('/elements'),
          { using: by, value: locator.value },
          Math.min(3000, Math.max(1, deadline - Date.now())),
          signal ?? null,
        );
        if (Array.isArray(values) && values.length) {
          const id = (values[0] as Record<string, unknown>)['element-6066-11e4-a52e-4f735466cecf'];
          if (typeof id === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(id)) return id;
        }
      } catch {
        /* Finding may be polled; no mutating command is retried. */
      }
      if (signal?.aborted) throw new RegistrationError('CANCELLED');
      await new Promise((r) => setTimeout(r, Math.min(200, Math.max(0, deadline - Date.now()))));
    } while (Date.now() < deadline);
    throw new RegistrationError('FLOW_STEP_FAILED');
  }
  async click(id: string, timeout = 10000) {
    await this.command('POST', this.path('/element/' + id + '/click'), {}, timeout);
  }
  async submit(id: string, timeout: number) {
    await this.command('POST', this.path('/element/' + id + '/click'), {}, timeout, null);
  }
  async tap(x: number, y: number, timeout = 10000) {
    if (![x, y].every((v) => Number.isInteger(v) && v >= 0 && v <= 16384))
      throw new RegistrationError('AUTO_PAGE_INVALID');
    await this.command(
      'POST',
      this.path('/actions'),
      {
        actions: [
          {
            type: 'pointer',
            id: 'registration-touch',
            parameters: { pointerType: 'touch' },
            actions: [
              { type: 'pointerMove', duration: 0, x, y, origin: 'viewport' },
              { type: 'pointerDown', button: 0 },
              { type: 'pause', duration: 60 },
              { type: 'pointerUp', button: 0 },
            ],
          },
        ],
      },
      timeout,
    );
  }
  async input(id: string, value: string) {
    await this.command('POST', this.path('/element/' + id + '/value'), { text: value });
  }
  async hideKeyboard() {
    const shown = await this.command('GET', this.path('/appium/device/is_keyboard_shown'));
    if (shown === true) await this.command('POST', this.path('/appium/device/hide_keyboard'), {});
    else if (shown !== false) throw new RegistrationError('AUTO_PAGE_UNREADABLE');
  }
  async back(timeout = 10000, signal?: AbortSignal) {
    await this.command('POST', this.path('/back'), {}, timeout, signal ?? this.signal ?? null);
  }
  async rect(id: string) {
    const r = (await this.command(
      'GET',
      this.path('/element/' + id + '/rect'),
      undefined,
      5000,
      null,
    )) as Rect;
    if (!r || ![r.x, r.y, r.width, r.height].every(Number.isFinite))
      throw new RegistrationError('EVIDENCE_UNSAFE');
    return r;
  }
  async source(signal?: AbortSignal) {
    const value = await this.read('/source', signal);
    if (typeof value !== 'string' || Buffer.byteLength(value) > 2097152)
      throw new RegistrationError('EVIDENCE_UNSAFE');
    return value;
  }
  async attached(id: string, signal?: AbortSignal): Promise<boolean> {
    if (!/^[A-Za-z0-9-]{1,100}$/.test(id)) throw new RegistrationError('APPIUM_FAILED');
    try {
      const value = await this.command(
        'GET',
        this.path('/element/' + id + '/enabled'),
        undefined,
        2000,
        signal ?? this.signal ?? null,
      );
      if (typeof value !== 'boolean') throw new RegistrationError('APPIUM_READ_INVALID');
      return true;
    } catch (error) {
      if (error instanceof RegistrationError && error.code === 'APPIUM_ELEMENT_GONE') return false;
      throw error;
    }
  }
  async screenshot(signal?: AbortSignal) {
    const value = await this.read('/screenshot', signal);
    if (typeof value !== 'string' || value.length > 13981016)
      throw new RegistrationError('EVIDENCE_UNSAFE');
    return Buffer.from(value, 'base64');
  }
  private async read(path: string, signal?: AbortSignal): Promise<unknown> {
    const effectiveSignal = signal ?? this.signal;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.command(
          'GET',
          this.path(path),
          undefined,
          35000,
          effectiveSignal ?? null,
        );
      } catch (error) {
        if (
          attempt !== 0 ||
          effectiveSignal?.aborted ||
          !(error instanceof RegistrationError) ||
          !['APPIUM_READ_TIMEOUT', 'APPIUM_READ_CONNECTION', 'APPIUM_READ_SERVER'].includes(
            error.code,
          )
        )
          throw error;
        try {
          await delay(400, undefined, { signal: effectiveSignal });
        } catch {
          throw new RegistrationError('CANCELLED');
        }
      }
    }
  }
  async close() {
    if (this.session)
      await this.command('DELETE', this.path(''), undefined, 5000, null).catch(() => {});
  }
}
