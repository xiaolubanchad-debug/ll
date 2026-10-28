#!/usr/bin/env node
// Fixed OpenSSH helper. The secret is read from a protected job file, never argv.
import fs from 'node:fs';
let fd;
try {
  const file = process.env.APK_SSH_PASSPHRASE_FILE;
  if (!file) throw Error();
  fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const info = fs.fstatSync(fd);
  if (
    !info.isFile() ||
    info.size > 65536 ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid()
  )
    throw Error();
  process.stdout.write(fs.readFileSync(fd));
  process.stdout.write('\n');
} catch {
  process.exitCode = 1;
} finally {
  if (fd !== undefined) fs.closeSync(fd);
}
