# 本地安卓驱动注册契约

版本 1.3.2，日期 2026 年 10 月 28 日。补充 P1 固定部署工具的权限边界，不改变 HTTP 或节点协议、数据库结构及重试规则。

## 行为

Appium 的 `driver install --source=local` 会调用 npm link；APPIUM_HOME 不能单独控制 npm 的全局链接目录。驱动必须以 apk-runner 身份从本次冻结 npm lock 安装的本地包注册，同时将 npm_config_prefix 固定到当前 tools_root 下的 npm-global。Node 运行时目录继续由 root 所有，不能通过改属主、放宽权限或用 root 注册驱动修复问题。

正例：root 保护的 Node 运行时、执行账户可写的工具目录、本地 UiAutomator2 包、独立 APPIUM_HOME 和 npm-global；安装成功且 Appium 能列出预期驱动版本。反例：省略独立 npm 前缀时，普通账户不得写入 root 保护的全局包目录；不得将驱动标记为已完成。只有注册命令成功后才写原有完成标记。

Playbook 摘要变化必须创建新签名发布 Agent 0.3.2；旧发布记录与构件不可覆盖。失败或未知部署保留，节点继续隔离。恢复前确认旧控制进程与远程安装进程均结束，核对安装标记所属操作后清除该次遗留标记，再通过新的只读检查和管理员核验解除隔离。后续安装另建受数据库锁约束的部署操作。

## 验证范围

以 Ubuntu 24.04 / 26.04、真实 npm 和 Appium、本地固定版本驱动及普通 Linux 账户验证成功注册和 root 运行时保护。此测试不代表模拟器启动或 APK 注册成功；实际 EC2 安装、空模拟器启动和 Agent 心跳分别验收。

参考：[npm link 的全局 prefix 目录](https://docs.npmjs.com/cli/npm-link/)、[npm 环境配置](https://docs.npmjs.com/cli/v11/using-npm/config/)。
