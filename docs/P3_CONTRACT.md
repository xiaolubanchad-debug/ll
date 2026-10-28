# P3 安卓安装与注册契约

版本 1.4.0。Agent 0.4.0 的签名发布增加 REGISTRATION_V1；心跳增加可选 registrationProtocol=1.0。原 DOWNLOAD_ONLY、下载协议 1.0 与配置 schemaVersion=1.0 继续兼容。FULL 同时要求发布能力、注册协议、安卓/KVM 健康、固定工具镜像和未吊销的 HTTP_PROXY 凭据，旧节点明确要求升级。

## 执行与代理

下载仍直连，每个已校验 APK 串行调用安卓适配器。按包名查找启用流程，缺失时 SKIPPED/FLOW_NOT_CONFIGURED，不猜测活动或提交。每个目标创建独立 AVD 工作目录，按位置轮换 deviceProfiles；镜像必须匹配签名工具链。ADB 严格选择本次 emulator serial，安装前复核缓存摘要及实际设备 ABI，然后安装并启动指定活动。

HTTP 代理凭据仅在持有租约的受保护配置响应中下发。节点启动本机认证转发器，将上游认证放入 HTTP Header；模拟器参数只含本机无口令端口。代理失败不得直连回退。转发器逐连接校验并固定目标公网地址，生产配置没有私网放行开关。固定 HTTPS IP 检查通过后才安装 APK，记录的 IP 仅代表这一次探测；轮询代理不保证注册时出口相同，不覆盖 UDP/DNS，不解密第三方 TLS。

设备证据记录实际 API、型号、语言、shell 作用域 Android ID 的摘要和本次 AVD 名称。明确标记 EMULATOR_NOT_REAL_DEVICE、SHELL_NOT_APP、PROBE_ONLY 和 App UA 未验证；不修改硬件身份、设备证明或模拟器检测，不将 shell Android ID 当作 App 实际读取标识。

## 账户和唯一提交

账户由加密随机数生成：用户名 6–10 位 ASCII 字母，密码 8–12 位 ASCII 字母数字并同时包含两类。先加密写 SQLite，再经独立 PUT 账户接口幂等上传，成功前不得输入账户。代理、账户和原始 UI 树不得进入日志、普通事件或进程参数。

注册仅使用配置动作 click/input/wait/back/submit。定位支持 id、accessibilityId、XPath，以及限定的无副作用 UiSelector 链；不开放 UiScrollable、任意代码或 Appium 命令。Node 使用 Appium 标准 WebDriver HTTP 的固定适配器，不启用命令自动重试；只有查找和结果查询可有界轮询。该选择替代原方案的 WebdriverIO 客户端，用于明确控制 submit 的单次传输与响应丢失边界。

提交后的配置步骤只允许 wait，并与提交传输、截图和证据确认共用最多 60 秒总期限；不再允许 back。截图前后读取的 UI 树必须一致，否则按证据不确定处理。证据上传超过期限时，已遮盖图片保留在节点队列，注册记为 UNKNOWN，后续只补传证据。

提交前可选步骤仅在定位失败、尚未执行动作时跳过；已发送的点击或输入出错不能借 optional 自动继续或重试。

唯一 submit 之前先在同一 SQLite 事务保存 submissionId、accountRef 和 SUBMISSION_INTENT outbox，再发出一次点击。调用超时、断线或崩溃均不得重发。提交后只做有界核验，成功标识存在才考虑 APP_UI 成功；可选 failure 标识表示明确拒绝。未获得确定结果为 UNKNOWN/REGISTRATION_UNKNOWN。完整成功必须有匹配账户、提交意图、设备证据及本任务脱敏截图，FILE_VALIDATION 不能代表注册成功。

截图在节点内存中遮盖账户输入框，以及 UI 树中包含用户名或密码的可见区域；无法安全定位敏感区域时不上传原图。成功证据缺失时保守记录 UNKNOWN。截图传输使用有界 JSON/Base64（PNG 不超过 10 MiB）；只有节点归属、delivery/fence 和文件摘要校验通过才保存，普通查询不含本地路径。管理员必须登录后查看截图，查看账户须 POST reason 并记录审计，返回 no-store。

## 停止、重启和汇总

提交前停止新动作并清理；提交后允许最多 60 秒只读核验，再最多 30 秒清理。进程、AVD 目录及代理连接按唯一工作目录、AVD 名称和服务 UID 记录归属；不能按通用进程名杀进程。清理失败立即隔离，不继续下一 APK。

事件回执增加 desiredControl 与 reconcileRequired，节点及时观察已提交的停止意图。停止与 RUN_FINISHED 竞争时，中台保存并确认结束事件，但不释放占用，仍等待 STOP_ACK；UNKNOWN 或清理失败仍优先隔离。重启核验也将中台已保存、尚无确定终态的提交意图转为 UNKNOWN，即使节点本地摘要缺失。

重启先终止本次记录的安卓/Appium 进程并清理拥有的目录，再补传 outbox、账户和未确认提交摘要并 reconcile。任何存在意图但未确认结果的任务保守为 UNKNOWN，不重新安装或注册。旧 fence 只能补传证据，不能恢复执行权或覆盖新任务。

UNKNOWN、清理不完整或执行权不确定优先汇总 NEEDS_REVIEW，保留节点隔离；停止回执不能把 UNKNOWN 改成 CANCELLED。其余按已有优先级：已确认停止、全部成功、部分成功、无成功。管理员对未知任务追加核验决议，原 UNKNOWN 记录不变；只有明确成功/失败决议、节点清理确认及新的空闲心跳齐全，才能解除节点占用，重试另建批次。

## 交付和边界

先使用自有 APK 的两种注册页面验证成功、拒绝、提交超时、控件变化及清理；独立验证真实 PostgreSQL、SQLite、代理认证、无自动重发和秘密脱敏。EC2 上用自有测试包进行真实 Android/Appium 验证；真实产品流程和住宅代理须在用户配置后单独验收。源码与构建脚本可提交，APK、实际测试账户、凭据、截图和原始执行记录不入 Git。账户查看默认 30 天有效，UNKNOWN 暂停过期；物理留存清理和备份恢复属于 P4 运维收尾，不能据此宣称 P4 完成。
