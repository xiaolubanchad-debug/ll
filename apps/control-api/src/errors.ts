import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import type { ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Issue } from '@apk/contracts';
import { PlatformError } from '@apk/platform';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details: Issue[] = [],
  ) {
    super(message);
  }
}
export function validated<T>(value: unknown, issues: (value: unknown) => Issue[]): T {
  const errors = issues(value);
  if (errors.length) throw new ApiError(422, 'VALIDATION_FAILED', '输入内容不符合要求', errors);
  return value as T;
}
@Catch()
export class ErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const req = host.switchToHttp().getRequest<Request & { requestId: string }>();
    const res = host.switchToHttp().getResponse<Response>();
    const status =
      error instanceof ApiError || error instanceof PlatformError
        ? error.status
        : error instanceof HttpException
          ? error.getStatus()
          : typeof error === 'object' &&
              error !== null &&
              'status' in error &&
              typeof error.status === 'number'
            ? error.status
            : 500;
    const safeStatus = [400, 401, 403, 404, 409, 410, 413, 422, 429, 500, 503].includes(status)
      ? status
      : 500;
    res.status(safeStatus).json({
      error: {
        code:
          error instanceof ApiError || error instanceof PlatformError
            ? error.code
            : safeStatus === 404
              ? 'NOT_FOUND'
              : safeStatus === 413
                ? 'PAYLOAD_TOO_LARGE'
                : safeStatus === 400
                  ? 'BAD_REQUEST'
                  : 'SERVICE_ERROR',
        message:
          error instanceof ApiError || error instanceof PlatformError
            ? error.message
            : safeStatus === 404
              ? '接口不存在'
              : safeStatus === 400
                ? '请求格式无效'
                : safeStatus === 413
                  ? '内容超过大小限制'
                  : '服务暂时不可用',
        requestId: req.requestId,
        details: error instanceof ApiError ? error.details : [],
      },
    });
  }
}
