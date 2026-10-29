# 1.9 安卓网页与 APP 启动准备

版本 1.9.0，2026-10-29，Agent 0.7.0。下载在安卓手机模式 Chromium 内完成；安装、启动、弹窗处理和注册全部在已配置代理的安卓模拟器 APP 内完成。现有每日缓存、N/M、停止、租约、提交未知规则不变。

## 安卓网页

来源、同页跳转及新窗口共用手机视口、竖屏和触屏；默认 Android Chrome UA。显式 UA 只接受 Android Mobile Chrome 格式，不接受 iPhone、桌面或含换行的 UA。旧配置若不符合，明确报错而非静默切换平台。通过 CDP 和上下文初始化脚本同步 Android 平台、移动端 Client Hints 和 UA；新窗口在 Page 对象创建前执行的脚本也必须得到安卓信息，不能因等待 CDP 堵塞首个请求。首个来源及落地页请求也必须带 Android 平台与 mobile=?1。页面脚本执行前完成设置，检查实际 UA、平台、触屏、屏幕和 Client Hints。不能把模拟网页环境描述为真实手机。

新增 BROWSER_ENVIRONMENT 事件，payload 只含 role=SOURCE/LANDING、platform=Android、mobile=true、touch=true、width=412、height=915、userAgent、scope=EMULATED_BROWSER。事件只说明网页环境，不涉及 APP UA 或画像。不得记录 URL 查询、Cookie、代理口令。无效设置或校验失败不得继续点击，报 ANDROID_BROWSER_REQUIRED / BROWSER_ENVIRONMENT_INVALID。

## APP 广告与公告

打开 APP 后、每次入口导航后和填写/提交前，先检查明确的“跳过广告、关闭广告、关闭、稍后、我知道了”等控件；公告确认必须同时具有公告/通知语义；仅针对当前 APP 的可见、唯一、可定位控件，不点广告内容。数字倒计时等待可跳过状态。原生控件优先，图片兜底只对明确文字且高置信度、唯一、位置重新核对的关闭/跳过候选触控，不猜角落坐标。无法识别、多个候选或无限弹出则有界停止并保留原因。外部包、验证码、付费等页面仍不做猜测操作。

共享每次注册最多 12 次关闭动作及 30 秒弹窗处理预算；启动倒计时最多等待 15 秒，仍受当前阶段总期限、停止及租约限制。每次关闭后重新读取页面，不能继续使用旧控件。已记录提交意图后只读核验，不关闭弹窗或重复提交。新增 APP_OBSTRUCTION 事件（taskId 必填），payload 只含 action=SKIP_AD/CLOSE_AD/CLOSE_POPUP/ACK_NOTICE/WAIT_SPLASH、method=CONTROLS/OCR、index=1..12。不得包含原始控件文字或账户。

关闭后仍须检查注册表单原绑定；表单改变则停止，不自动补填或重新提交。普通注册入口不能被当作关闭按钮；购买、立即体验、下载推荐 APP、关闭账户等不能被识别为广告关闭。

## 页面读取

UiAutomator2 会话使用 waitForIdleTimeout=500、waitForSelectorTimeout=1000；取消过长的隐式空闲等待，页面稳定性由客户端连续快照校验。source 读取上限 15 秒，可在同一阶段期限内最多重试一次只读读取；只针对传输、超时和已知的暂态服务端错误，非法会话/不支持等不重试。不能重试点击、输入、提交等变更命令。

错误区分 APPIUM_READ_TIMEOUT、APPIUM_READ_CONNECTION、APPIUM_READ_SERVER、APPIUM_SESSION_LOST、APPIUM_READ_REJECTED 和 APPIUM_READ_INVALID；只保留固定错误码，不泄露原始响应。读取基础设施故障不一律标为需要注册规则适配。页面结构和截图仍需完整校验，不能因放宽等待伪报成功。

参数含义参照 [UiAutomator2 Settings](https://appium.github.io/appium-uiautomator2-driver/latest/reference/settings/) 和 [Chromium Emulation](https://chromedevtools.github.io/devtools-protocol/tot/Emulation/)。

## 验收

正例：来源、首个 popup 请求及其页面脚本均报告 Android mobile；同页/新页自动下载保持手机模式；倒计时→跳过→公告→注册，入口中途及填写前出现广告时重新核对后继续；短暂只读超时恢复且没有重复提交。

反例：iPhone/桌面 UA、首个落地页请求仍为桌面、UA 与 Client Hints 矛盾；多个关闭候选、付费/广告正文、变化的截图、无限公告、停止期间的点击；丢失提交响应后重发，均不得通过。真实 1111 下载、安装、注册和日志另记实测范围，未提交或未知不算成功。
