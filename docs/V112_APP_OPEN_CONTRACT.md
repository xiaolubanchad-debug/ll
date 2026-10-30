# 1.12 APP 启动停留执行契约

版本 1.12.0，Agent 0.10.0，2026-10-30。用户最新要求替代新任务的表单注册流程。

新任务默认 `execution.mode=FULL`、`execution.appOpen={dwellMs:10000}`、`contentIsolation=true`，必须引用有效 HTTP 代理，`registrationFlows=[]` 且不允许 `autoRegistration`。下载模式不能携带 appOpen。旧配置及注册历史不改写；迁移通过保存新的不可变配置版本完成。新模式须签名功能 `APP_OPEN_V1`，不下发到旧 Agent。

每日北京时间 00:05 下载及当天缓存规则不变。所有 APK 合计目标 N 改为完成轮数，M 仍为总尝试上限。每轮使用独立模拟器及代理连接，复用已校验 APK，安装、启动、确认目标包前台后计时 10 秒，随后关闭模拟器、代理及工作目录。上一轮清理完成后才开始下一轮；缓存保留供复用。无需 Appium、页面树、截图、OCR、弹窗点击、账户生成、注册入口识别或表单提交。原始内容不采集、不上传。

兼容现有传输字段：`purpose=REGISTER` 表示缓存 APK 的循环执行，`successTarget/successes` 在 appOpen 配置中表示目标/完成轮数，绝不表示成功账户。视图新增可选 `executionKind=APP_OPEN|REGISTRATION|DOWNLOAD_ONLY`，从对应版本快照计算；旧轮次使用旧快照。界面明确展示启动停留完成，不与账户注册统计混算。

阶段严格为 DOWNLOADING → DOWNLOADED → PREPARING → INSTALLING → LAUNCHING → HOLDING → TASK_FINISHED。INSTALLING 仍需实际设备和代理探测摘要，不承诺真实手机身份、APP 上报画像或固定出口 IP。前台检测只读取固定 ADB 系统 Activity 状态，至少两次、间隔不超过约 1 秒；采用单调时钟从首次确认目标前台起测量满 10000ms，并在结束时再次确认。仅轮询证据，不能证明任意两次采样之间始终可见，更不能证明 APP 后台已注册账户。

成功事件 `proof=APP_OPEN`，携带 `openObservation={dwellMs:10000,elapsedMs:>=10000,samples:>=2,scope:FOREGROUND_POLL_ONLY,cleanupComplete:true}`，无账户、识别摘要、附件和错误码。中台必须同时核对新配置、HOLDING、APK、设备摘要、无提交意图及清理完成。该事件不得用于旧注册/下载批次；旧 APP_UI 证明也不能用于新模式。仅 APP_OPEN 成功增加完成轮数，不写 registrationStartedAt，不增加确认账户统计。

前台不匹配、APP 启动/安装失败均不计完成；停留中停止立即中断并清理，不能补发成功。清理失败以 CLEANUP_INCOMPLETE 隔离节点，禁止开启下一轮。未知的旧注册结果保持未知，不能迁移后重试。数据库锁、幂等键、租约、fence、停止回执和重启清理规则不变。

正例：缓存 APK 安装启动、目标包前台轮询满 10 秒、清理成功 → 完成 1 轮、账户数 0。反例：未满 10 秒、启动后离开前台、停止、清理失败、旧节点、伪造账户或混用注册配置 → 不计完成。测试、签名发布、实际部署、自有 APK 与产品 APK 实测分别记录，未执行不宣称通过。

验收：新增执行器的停止、离开前台、清理失败及禁用 UI/账户调用测试通过；真实 PostgreSQL 的阶段、证明、防混用、旧节点拒绝和账户统计隔离测试通过。任务中心三步配置、升级提示、开始停止及版本管理已用 Chromium 验证。既有下载、缓存、注册和日志回归通过；lint、typecheck、契约检查与 build 通过。EC2 自有 iota APK 实测前台轮询停留 10032ms、11 次采样，零表单提交、零附件、未启动 Appium，清理成功。该记录是候选源码自有 APK 验证；签名发布、更新部署及真实产品启动结果另以运维回执记录，不据此宣称产品账户注册成功。
