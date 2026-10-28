# P3 安装注册与验证

版本 1.4.0，Agent 0.4.0。执行规则见 [P3 契约](P3_CONTRACT.md)。下载模式仍兼容 0.3.x；完整测试同时要求签名发布 REGISTRATION_V1、注册协议 1.0、Android/KVM 健康和有效 HTTP_PROXY 引用。

## 管理员操作

1. 在服务器页面部署 Agent 0.4.0，等待在线、安卓启动已核验和注册能力已支持。
2. 在配置页面展开 HTTP 代理配置，填写地址、端口、用户名和密码，点击加密保存。页面只显示凭据引用；选择引用应用到草稿会切换为 FULL。
3. 为每个 APK 包名配置启用的 registrationFlows、启动 activity、控件定位及成功标识。缺少流程会跳过，不猜测注册步骤。第一版使用受校验的 JSON；示例包名和控件不能直接用于产品。
4. 保存新版本，在任务页选择节点及固定版本，点击开始安装注册。新批次会生成新测试账户。同日复用下载缓存仍会重新安装注册，不能把新批次当作 HTTP 请求重试。
5. 在注册证据中查看脱敏截图、设备观测及代理探测。查看账户必须填写原因，记录审计；显示 30 秒后隐藏，不写浏览器本地存储。
6. UNKNOWN 不自动重试。先核对 APK 产品自己的后台并记录任务决议，再确认节点清理、新的空闲心跳，解除批次占用。原未知记录不会改成成功或失败。

设备观测只代表模拟器及 shell Android ID 摘要；不能宣称为真实手机。代理探测不证明轮询住宅代理的注册出口，App UA 默认未验证。系统不提供更改硬件身份、设备证明或规避模拟器检测的能力。

## 中台升级

先备份数据库、密钥及已有证据，再构建同一提交的 API、Worker 和 Web，运行 Prisma 四条迁移。新的 AccountResult、Artifact、TaskReview 和审计 details 不影响旧下载记录。API 仍以非 root 用户运行。

设置 ARTIFACT_DIR=/var/lib/apk-hub/artifacts，挂载仅 API 可写的持久目录，目录 0700、文件 0600，所有者与 API 容器 UID 一致。不可将此目录作为 Nginx 静态目录。反向代理仅对精确 /api/v1/agent/artifacts 路径允许 14 MiB JSON，并关闭请求缓冲；普通接口保持 256 KiB。API 在解析大正文前核验节点身份，随后验证归属、fence、摘要、PNG 格式和遮盖标记。

签名发布必须来自干净提交；不可覆盖已有清单或构件。通过中台部署新发布，等待 Agent 注册和心跳后才算上线。systemd 停止期限为 100 秒，覆盖提交后的只读核验与清理。账户密钥和 SQLite 位于持久 execution 目录，不随 Agent 身份或发布目录重建。

## 验证方法和范围

`npm run check:contracts` 检查正反例与生成文件漂移。`npm run lint`、`npm run typecheck`、`npm run build`、`npm test` 覆盖真实 PostgreSQL、SQLite、Chromium、认证代理及故障注入的 Appium HTTP 边界。提交响应丢失仍只有一次点击；提交前停止没有提交；提交后停止和重启不重复注册；清理失败保留隔离；账户不可替换，截图归属、摘要与鉴权独立检查。

[自有测试 APK 源码](../tests/android-fixture/MainActivity.java) 和 [构建脚本](../tests/android-fixture/build.mjs) 生成两个独立包：单页注册与两页注册。Linux 构建需要 Node 24、JDK、unzip 和 zip；运行 `node tests/android-fixture/build.mjs .tmp/p3-android-fixture`。脚本按官方元数据校验固定 build-tools 35.0.0 与 Android 35 SDK 下载摘要，生成临时签名。构件、签名、账户、截图和执行证据均不入 Git。

[真实 Android 验证程序](../tests/android-fixture/verify.mjs) 在受控 EC2 上运行。测试端点使用 RFC 5737 保留地址，只由自有认证代理映射到本机测试服务，代码注入的测试网络策略不进入产品配置。覆盖两个流程成功、明确拒绝、响应超时与控件变化，并核对后台请求次数、已遮盖截图、进程及目录清理。此程序是独立模块验收；生产节点需另外通过中台升级与心跳确认。实际产品流程和住宅代理另行记录，不能用自有测试 APK 的结果代替。

Appium 使用官方 `--tmp` 参数，将临时目录限定到本次任务；[官方 CLI 说明](https://appium.io/docs/en/3.7/reference/cli/server/) 记录了该参数。清理按唯一 AVD、临时目录、serial 和服务 UID 识别进程；明确识别后再访问环境，已退出的僵尸进程不视为活动执行，无法确认的情况仍隔离。

P4 的物理数据清理、备份恢复演练和完整运维收尾不包含在 P3 验收中。
