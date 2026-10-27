export class PlatformError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function fault(code: string, message: string, status = 409): never {
  throw new PlatformError(status, code, message);
}
