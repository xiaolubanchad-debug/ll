# Ubuntu 执行节点兼容契约

版本 1.3.0，日期 2026 年 10 月 28 日。该增量扩展 P1/P2 的执行节点平台检查；HTTP 路由、节点协议 1.0、配置 Schema 1.0 和数据库结构不变。

## 平台规则

执行节点接受 Ubuntu 24.04 LTS 和 Ubuntu 26.04 LTS，架构仍为 x86_64。发行版与 VERSION_ID 精确匹配；Ubuntu 22.04、26.10、未知版本、Debian 以及 ARM 节点均拒绝。共享运行时校验由 p1.schema.json 的 ExecutionOS 提供，Worker 和 Agent 使用同一校验。

| 系统与架构 | 平台检查 | 其他条件 |
| --- | --- | --- |
| ubuntu:24.04 / x86_64 | 接受 | 继续检查 KVM、磁盘、权限和工具 |
| ubuntu:26.04 / x86_64 | 接受 | 继续检查 KVM、磁盘、权限和工具 |
| ubuntu:26.04 / aarch64 | UNSUPPORTED_ARCH | 不开始安装 |
| ubuntu:26.10 / x86_64 | UNSUPPORTED_OS | 不开始安装 |
| debian:13 / x86_64 | UNSUPPORTED_OS | 不开始安装 |

系统版本可接受不等于安卓已就绪。KVM、至少 20 GiB 剩余磁盘、sudo、严格主机指纹核验、安装锁和实际模拟器启动证明继续生效。无 KVM 的 26.04 返回 NO_KVM，不能通过更换系统版本绕过。

## 固定发布与兼容

新发布使用 Agent 0.3.1、Playwright 1.64.1，支持 24.04 与 26.04。测试工具与发布生成器使用同一锁定版本；不依赖旧 Playwright 对未知系统的回退或平台覆盖变量。Java 17、Node.js 24、Android 固定签名档案沿用现有发布规则。

部署工具固定为 Ansible Core 2.20.10 / Runner 2.4.2；Worker 的 Python 要求 3.12–3.14，目标节点的系统 Python 3.12 / 3.14 均受支持。现有使用 Python 3.11 的 Worker 镜像需重建；中台生产镜像切换到固定 Node.js 24.18.0 的 Debian Trixie 版本，以提供 Python 3.13。不能仅更新 Playbook 而保留不支持目标 Python 的旧部署工具。

修改 Playbook 会改变其摘要，必须生成和登记新的签名发布，不能覆盖旧发布清单或构件。旧记录保持不变；旧 Playbook 的发布不能用于新的部署脚本，页面明确提示选择新发布。Agent 0.3.0 的下载与回执行为继续兼容，0.2.0 保留注册心跳模式。

## 验证与边界

契约正反例覆盖平台允许列表。真实 Ansible 执行同一平台断言，覆盖 24.04、26.04、错误发行版、版本和架构；集成测试覆盖 Worker 的只读检查和部署前阻断，以及 Agent 共用运行时校验。Linux 容器可验证两种发行版的软件包、固定浏览器和下载流程，但不能代表 EC2 的 KVM 或 Android 启动已经验收。实际 EC2 上仍要求空模拟器启动和匹配 Agent 心跳后才能报告部署成功。

2026 年 10 月 28 日已在 Ubuntu 24.04 与 26.04 容器验证真实系统依赖安装、非 root 浏览器的直接下载/新窗口/同页落地、每日缓存和无 KVM 时的拒绝行为；79 项契约检查、代码及类型检查、P0/P1/P2 回归与管理页面测试通过。Windows 跳过的 Linux 专用进程清理仍由 Linux CI 检查。自有 APK 结构样本不代表实际产品安装或注册。

参考：[Playwright 系统要求](https://playwright.dev/docs/intro#system-requirements)、[Playwright 1.64.1](https://github.com/microsoft/playwright/releases/tag/v1.64.1)、[Android Linux KVM](https://developer.android.com/studio/run/emulator-acceleration)。
