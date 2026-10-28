import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { RegistrationError } from './registration-types.js';
import type { OcrLine } from './registration-types.js';

export async function recognizeRegistrationScreenshot(
  bytes: Buffer,
  toolsRoot: string,
  workspace: string,
  signal: AbortSignal,
): Promise<OcrLine[]> {
  if (signal.aborted) throw new RegistrationError('CANCELLED');
  if (bytes.length > 10485760) throw new RegistrationError('AUTO_PAGE_INVALID');
  return new Promise((ok, no) => {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('./ocr-worker.js', import.meta.url)),
        '--ocr-job',
        join(workspace, 'ocr-job'),
      ],
      {
        cwd: workspace,
        env: { ...process.env, ANDROID_AVD_HOME: join(workspace, 'avds') },
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      },
    );
    let output = '',
      failure: string | undefined,
      settled = false,
      killTimer: ReturnType<typeof setTimeout> | undefined,
      hardTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: string, lines?: OcrLine[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(hardTimer);
      signal.removeEventListener('abort', abort);
      if (error) no(new RegistrationError(error));
      else ok(lines!);
    };
    const stop = (code: string) => {
      if (failure) return;
      failure = code;
      try {
        child.kill('SIGTERM');
      } catch {
        failure = 'CLEANUP_INCOMPLETE';
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          failure = 'CLEANUP_INCOMPLETE';
        }
        hardTimer = setTimeout(() => finish('CLEANUP_INCOMPLETE'), 2000);
      }, 500);
    };
    const abort = () => stop('CANCELLED'),
      timer = setTimeout(() => stop('AUTO_OCR_TIMEOUT'), 30000);
    signal.addEventListener('abort', abort, { once: true });
    child.on('error', () => finish('AUTO_OCR_UNAVAILABLE'));
    child.stdout.on('data', (b) => {
      output += b.toString();
      if (output.length > 512000) stop('AUTO_OCR_FAILED');
    });
    child.stdin.on('error', () => {});
    child.on('close', (code) => {
      if (failure) return finish(failure);
      if (code !== 0) return finish('AUTO_OCR_UNAVAILABLE');
      try {
        const parsed = JSON.parse(output) as { lines: OcrLine[] };
        if (
          !Array.isArray(parsed.lines) ||
          parsed.lines.length > 2000 ||
          parsed.lines.some(
            (line) =>
              typeof line.text !== 'string' ||
              line.text.length > 200 ||
              !Number.isFinite(line.confidence) ||
              line.confidence < 0 ||
              line.confidence > 100 ||
              !line.rect ||
              ![line.rect.x, line.rect.y, line.rect.width, line.rect.height].every(
                (v) => Number.isFinite(v) && v >= 0 && v <= 4096,
              ),
          )
        )
          throw Error();
        finish(undefined, parsed.lines);
      } catch {
        finish('AUTO_OCR_FAILED');
      }
    });
    if (signal.aborted) abort();
    else child.stdin.end(JSON.stringify({ toolsRoot, image: bytes.toString('base64') }));
  });
}
