import { installEgress } from './egress.js';
installEgress().catch(() => {
  console.error('节点出口规则安装失败');
  process.exitCode = 1;
});
