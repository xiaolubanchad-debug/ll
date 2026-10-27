export interface Settings {
  databaseUrl: string;
  origin: string;
  csrfKey: Buffer;
  secureCookie: boolean;
  host: string;
  port: number;
  trustProxyHops: number;
  loginMaxAttempts: number;
}
export function settings(env: NodeJS.ProcessEnv = process.env): Settings {
  const fail = (): never => {
    throw new Error(
      '环境配置无效，请检查 DATABASE_URL、APP_ORIGIN 和 SESSION_CSRF_KEY；配置值不输出到日志',
    );
  };
  let db: URL, origin: URL;
  try {
    db = new URL(env.DATABASE_URL ?? '');
    origin = new URL(env.APP_ORIGIN ?? '');
  } catch {
    return fail();
  }
  if (
    !['postgres:', 'postgresql:'].includes(db.protocol) ||
    !db.hostname ||
    !db.username ||
    !db.pathname.slice(1)
  )
    return fail();
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.origin !== env.APP_ORIGIN ||
    origin.username ||
    origin.password
  )
    return fail();
  const key = Buffer.from(env.SESSION_CSRF_KEY ?? '', 'base64');
  if (key.length !== 32 || key.toString('base64') !== env.SESSION_CSRF_KEY) return fail();
  const secure = env.COOKIE_SECURE !== 'false';
  if (!['true', 'false', undefined].includes(env.COOKIE_SECURE)) return fail();
  if (env.NODE_ENV === 'production' && (!secure || origin.protocol !== 'https:')) return fail();
  if (!secure && !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) return fail();
  const port = Number(env.PORT ?? 3000),
    hops = Number(env.TRUST_PROXY_HOPS ?? 0),
    max = Number(env.LOGIN_MAX_ATTEMPTS ?? 20);
  if (
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535 ||
    ![0, 1].includes(hops) ||
    !Number.isInteger(max) ||
    max < 1 ||
    max > 1000
  )
    return fail();
  return {
    databaseUrl: env.DATABASE_URL!,
    origin: origin.origin,
    csrfKey: key,
    secureCookie: secure,
    host: env.HOST ?? '127.0.0.1',
    port,
    trustProxyHops: hops,
    loginMaxAttempts: max,
  };
}
