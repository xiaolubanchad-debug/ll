import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { PrismaClient } from '@prisma/client';
import { initializeAdmin } from './admin.js';
function hiddenPassword(prompt: string) {
  if (!stdin.isTTY)
    throw new Error('非交互初始化需临时提供 ADMIN_USERNAME 与 ADMIN_PASSWORD 环境变量');
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let text = '';
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      stdout.write('\n');
    };
    const onData = (data: Buffer) => {
      for (const char of data.toString('utf8')) {
        if (char === '\u0003') {
          cleanup();
          reject(new Error('初始化已取消'));
          return;
        }
        if (char === '\r' || char === '\n') {
          cleanup();
          resolve(text);
          return;
        }
        if (char === '\u007f' || char === '\b') text = text.slice(0, -1);
        else if (char >= ' ') text += char;
      }
    };
    stdin.on('data', onData);
  });
}
let db: PrismaClient | undefined;
try {
  let username = process.env.ADMIN_USERNAME,
    password = process.env.ADMIN_PASSWORD;
  if (!username) {
    const rl = createInterface({ input: stdin, output: stdout });
    username = await rl.question('管理员用户名：');
    rl.close();
  }
  if (!password) {
    password = await hiddenPassword('管理员密码（输入不回显）：');
    const confirm = await hiddenPassword('再次输入密码：');
    if (password !== confirm) throw new Error('两次密码不一致');
  }
  delete process.env.ADMIN_PASSWORD;
  db = new PrismaClient();
  await initializeAdmin(db, username, password);
  console.log('超级管理员已创建，可以登录中台');
} catch (error) {
  console.error(error instanceof Error ? error.message : '初始化失败');
  process.exitCode = 1;
} finally {
  await db?.$disconnect();
}
