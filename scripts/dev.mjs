import { spawn } from 'node:child_process';
const children = [];
const jobs = [
  ['node_modules/typescript/bin/tsc', '-p', 'apps/control-api/tsconfig.json', '--watch'],
  ['--watch', 'apps/control-api/dist/main.js'],
  ['node_modules/vite/bin/vite.js', 'apps/web', '--config', 'apps/web/vite.config.ts'],
];
for (const args of jobs) {
  const child = spawn(process.execPath, args, {
    stdio: 'inherit',
    env: process.env,
    windowsHide: true,
  });
  children.push(child);
  child.on('error', () => {
    console.error('开发服务启动失败');
    process.exitCode = 1;
  });
}
function stop() {
  for (const child of children) child.kill();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
