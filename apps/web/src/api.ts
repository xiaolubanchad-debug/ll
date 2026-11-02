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
      signal: AbortSignal.timeout(20000),
      headers: {
        ...(method !== 'GET'
          ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }
          : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new RequestError(0, '无法连接中台或请求超时，请稍后重试');
  }
  if (response.status === 204) return undefined as T;
  const data: unknown = await response.json().catch(() => null);
  if (response.ok && data === null) throw new RequestError(503, '中台响应暂时无法解析，请稍后重试');
  if (!response.ok) {
    const error = data as { error?: { message?: string; requestId?: string } } | null;
    throw new RequestError(response.status, error?.error?.message ?? '请求失败，请稍后重试');
  }
  return data as T;
}
const pendingMutations = new Map<string, string>();
export function uploadApk<T>(
  path: string,
  file: File,
  progress: (percent: number) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', '/api/v1' + path);
    request.timeout = 600000;
    request.setRequestHeader('Content-Type', 'application/octet-stream');
    request.setRequestHeader('X-CSRF-Token', csrfToken);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) progress(Math.round((event.loaded / event.total) * 100));
    };
    request.onload = () => {
      let data;
      try {
        data = JSON.parse(request.responseText);
      } catch {
        reject(new RequestError(503, '上传结果暂时无法读取，请刷新查看状态'));
        return;
      }
      if (request.status >= 200 && request.status < 300) resolve(data as T);
      else reject(new RequestError(request.status, data?.error?.message ?? '上传失败，请重试'));
    };
    request.onerror = request.ontimeout = () =>
      reject(new RequestError(0, '上传中断或超时，请刷新查看状态后重试'));
    request.send(file);
  });
}
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
