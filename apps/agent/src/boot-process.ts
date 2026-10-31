import type { ChildProcess } from 'node:child_process';

export function bootProcessExited(child: ChildProcess): boolean {
  return !child.pid || child.exitCode !== null || child.signalCode !== null;
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (bootProcessExited(child)) return true;
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      child.removeListener('exit', finish);
      resolve(bootProcessExited(child));
    };
    const timer = setTimeout(finish, timeoutMs);
    child.once('exit', finish);
    if (bootProcessExited(child)) finish();
  });
}

export async function stopBootProcess(child: ChildProcess, timeoutMs = 5000): Promise<void> {
  if (bootProcessExited(child)) return;
  child.kill('SIGTERM');
  if (await waitForExit(child, timeoutMs)) return;
  child.kill('SIGKILL');
  if (!(await waitForExit(child, timeoutMs))) throw Error('ANDROID_CLEANUP_FAILED');
}
