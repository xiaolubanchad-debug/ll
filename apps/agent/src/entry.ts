import { main } from './main.js';
main().catch((error) => {
  console.error('Agent 无法启动，请检查受保护的配置与身份文件');
  process.exitCode = error instanceof Error && error.message === 'IDENTITY_REJECTED' ? 78 : 1;
});
