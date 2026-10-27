import { createApp } from './app.js';
import { settings } from './settings.js';
try {
  const config = settings();
  const app = await createApp();
  app.enableShutdownHooks();
  await app.listen(config.port, config.host);
  console.log('中台 API 已启动');
} catch {
  console.error('中台启动失败，请检查环境配置、数据库连接和迁移状态');
  process.exitCode = 1;
}
