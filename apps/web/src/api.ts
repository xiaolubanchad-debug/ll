import type { SessionView } from '@apk/contracts';
export type { SessionView } from '@apk/contracts';
export interface Row {
  id: string;
  name?: string;
  host?: string;
  nodeId?: string;
  status?: string;
  action?: string;
  createdAt: string;
}
export interface Page {
  items: Row[];
  nextCursor: string | null;
}
export class RequestError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
let csrfToken = '';
export function useSession(session: SessionView | null) {
  csrfToken = session?.csrfToken ?? '';
  if (!session) pendingMutations.clear();
}
export async function api<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch('/api/v1' + path, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(method !== 'GET'
          ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }
          : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new RequestError(0, '无法连接中台，请检查服务是否启动');
  }
  if (response.status === 204) return undefined as T;
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = data as { error?: { message?: string; requestId?: string } } | null;
    throw new RequestError(response.status, error?.error?.message ?? '请求失败，请稍后重试');
  }
  return data as T;
}
const pendingMutations = new Map<string, string>();
export async function mutation<T = unknown>(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  method = 'POST',
) {
  const intent = JSON.stringify([method, path, body, headers]);
  let key = pendingMutations.get(intent);
  if (!key) {
    key = crypto.randomUUID();
    pendingMutations.set(intent, key);
  }
  const result = await api<T>(path, method, body, { ...headers, 'Idempotency-Key': key });
  pendingMutations.delete(intent);
  return result;
}
