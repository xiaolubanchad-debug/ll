import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { bootProcessExited, stopBootProcess } from '../apps/agent/dist/boot-process.js';

test('cleanup of an already exited child returns without waiting for a past exit event', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(2)'], { stdio: 'ignore' });
  await once(child, 'exit');
  assert.equal(bootProcessExited(child), true);
  await stopBootProcess(child, 50);
  assert.equal(child.listenerCount('exit'), 0);
});

test('cleanup terminates only its live child and removes its exit listener', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    stdio: 'ignore',
  });
  await once(child, 'spawn');
  assert.equal(bootProcessExited(child), false);
  try {
    await stopBootProcess(child, 1000);
    assert.equal(bootProcessExited(child), true);
    assert.equal(child.listenerCount('exit'), 0);
  } finally {
    if (!bootProcessExited(child)) child.kill('SIGKILL');
  }
});

test(
  'signal exit is terminal even though exitCode is null',
  { skip: process.platform === 'win32' },
  async () => {
    const child = spawn(process.execPath, ['-e', "process.kill(process.pid,'SIGUSR2')"], {
      stdio: 'ignore',
    });
    await once(child, 'exit');
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, 'SIGUSR2');
    assert.equal(bootProcessExited(child), true);
    await stopBootProcess(child, 30);
    assert.equal(child.listenerCount('exit'), 0);
  },
);

test(
  'cleanup escalates when its child ignores a graceful stop',
  { skip: process.platform === 'win32' },
  async () => {
    const child = spawn(
      process.execPath,
      ['-e', "process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)"],
      {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      },
    );
    await once(child, 'message');
    try {
      await stopBootProcess(child, 50);
      assert.equal(child.signalCode, 'SIGKILL');
      assert.equal(child.listenerCount('exit'), 0);
    } finally {
      if (!bootProcessExited(child)) child.kill('SIGKILL');
    }
  },
);
