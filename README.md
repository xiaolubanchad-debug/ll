# APK 自动化测试部署中台

1.15.3 自有客户端回传总预算、幂等和持续验收规则见 [回传契约](docs/V1153_REPORTING_CONTRACT.md)。

1.15.2 的稳定依赖选择和启动退出处理见 [运行环境契约](docs/V1152_RUNTIME_CONTRACT.md)。

1.15.1 按用户最新要求，每台 EC2 同时仅运行一个模拟器，覆盖旧双路执行要求；见 [单模拟器契约](docs/V1151_SERIAL_DEVICE_CONTRACT.md)。设备内仍可随机测试多个不同 APP。

1.15 多 APP 设备会话、30 款机型档案和十个独立测试客户端遵循 [设备会话契约](docs/V115_DEVICE_SESSIONS_CONTRACT.md)。本次执行规则覆盖每轮仅一个 APP 和整批型号不重复的旧限制；旧不可变配置保持。

1.14.5 修复测试数据的筛选和密码弹窗组件加载；1.14.4 统一中台与 Agent 0.12.3 的执行能力判断，包含引擎启动和心跳协议验证；1.14.2 增加模拟器默认网络就绪等待，系统启动后再安装和打开 APP；每轮前台停留仍为 10 秒。自有测试 APK、测试数据和独立设备档案见 [测试契约](docs/V114_TEST_DATA_CONTRACT.md)；新增客户端仅用于中台控制的模拟器，实际请求 IP 直接随创建回执保存，不另做出口探测。

1.13.1 增加独立模拟器准备优化和步骤耗时，见 [性能契约](docs/V1131_PERFORMANCE_CONTRACT.md)，对应 Agent 0.11.1；每轮新模拟器、代理和前台停留 10 秒保持。

1.13 增加 APP 启动停留 1/2 路并发与每日共享额度，见 [并发契约](docs/V113_CONCURRENCY_CONTRACT.md)，对应 Agent 0.11.0。下载与部署仍整台互斥，完成数和尝试上限由两路共享。

1.12 新任务默认使用 APK 启动、前台停留 10 秒和清理，完成轮数不代表注册账户，见 [启动停留契约](docs/V112_APP_OPEN_CONTRACT.md)，对应 Agent 0.10.0。旧注册历史保持原有含义。

1.11.2 原生弹层返回关闭见 [增量契约](docs/V1112_MODAL_CONTRACT.md)，对应 Agent 0.9.2。

1.11.1 的页面切换只读退避和启动加载识别见 [读取增量契约](docs/V1111_READ_CONTRACT.md)，对应 Agent 0.9.1。

1.11 补齐 APP 弹窗关闭确认、可点击父控件、受限图形 × 识别和阶段日志，见 [启动准备契约](docs/V111_CONTRACT.md)，对应 Agent 0.9.0。

1.10.1 补充高速下载控件、子框架和源码 APK 地址发现，规则与验证边界见 [下载增量契约](docs/V1101_DOWNLOAD_CONTRACT.md)，对应 Agent 0.8.1。

1.10 默认内容隔离与真实功能测试见 [增量契约](docs/V110_CONTRACT.md)，对应 Agent 0.8.0。原始画面不作为新执行证据上传或展示。

1.9.2 导航站跳过、注册入口修正与自动身份独立观察见 [增量契约](docs/V192_CONTRACT.md)，对应 Agent 0.7.2。

1.9.1 的安卓版本一致性和复杂页面读取修正见 [实测修正契约](docs/V191_CONTRACT.md)，对应 Agent 0.7.1。

1.9 安卓网页、APP 广告公告处理与页面读取遵循 [1.9 契约](docs/V19_CONTRACT.md)，对应 Agent 0.7.0。

1.8.1 显式下载复跑规则见 [补充契约](docs/V181_CONTRACT.md)；普通开始仍每日复用，不自动重下。

1.8 提供任务中心、三步配置、统一开始停止和历史版本管理，操作见 [1.8 说明](docs/V18_SETUP.md)，规则见 [1.8 契约](docs/V18_CONTRACT.md)。兼容现有 Agent 0.6.0。

超级管理员在中台添加 EC2 服务器，通过 SSH 部署执行程序，统一配置网站、XPath、HTTP 代理和注册步骤。EC2 主动领取任务，执行 APK 下载、安卓安装和注册测试，再回传结果。

采用 Node.js + TypeScript 统一实现中台和执行端。中台可部署在现有 Hostinger Ubuntu 服务器；Android 模拟器运行在通过 KVM 检查的 EC2 节点。

## 当前状态

已实现 P0 工程与登录、P1 服务器管理与部署、P2 配置版本与下载缓存，以及 P3 APK 安装、启动、配置式账户注册和证据回传。真实 PostgreSQL、SQLite、Chromium 和故障注入的 Appium HTTP 边界已联测；Ubuntu 26.04 / KVM EC2 上使用自有 APK 验证两个注册流程、明确拒绝、提交超时和控件变化，并确认进程及目录清理。实际产品注册和住宅代理须使用用户配置另行验收，不能用自有测试结果代替。

原 Python 单机方案被本方案替代。早期本地草稿不作为实现依据，也不纳入发布。

1.5 增加独立每日下载、复用当天 APK 的循环注册、合计成功目标及总尝试上限、随机拼音用户名、每轮模拟器清理、每日计划和独立代理检查。业务验收以 APP 明确注册成功为准，画像或 App UA 的采集不作为前置条件；操作、升级及验证范围见 [1.5 说明](docs/V15_SETUP.md)。新计划默认关闭，真实产品仍须配置对应的注册控件及成功标识。

1.6 增加不同 APP 的注册入口自动识别、本地中英文图片入口 OCR、原生表单操作和加密路径学习。已启用的手工流程优先；页面变化会重新核对，不能可靠识别时提示待适配，提交未知仍暂停。配置和验证范围见 [1.6 说明](docs/V16_SETUP.md) 与 [识别契约](docs/V16_CONTRACT.md)。新功能默认关闭，实际产品按 APK 单独验收。

1.7 增加注册记录、中文执行日志、数据库统计、独立任务地址与历史回填，并整理任务方案、每日计划、APK 资源和代理管理。使用及验收范围见 [1.7 说明](docs/V17_SETUP.md)。本次兼容现有 Agent 0.6.0，实际产品注册记录与系统自有验收分开展示。

## 文档入口

| 文档                                                                   | 内容                                         |
| ---------------------------------------------------------------------- | -------------------------------------------- |
| [实施方案](docs/PLAN.md)                                               | 产品范围、技术栈、模块职责和部署结构         |
| [开发契约](docs/DEVELOPMENT_CONTRACT.md)                               | 状态机、任务协议、幂等、停止和恢复规则       |
| [接口契约](contracts/HTTP_API.md)                                      | 管理端和节点 API、权限、错误和事件格式       |
| [配置 Schema](contracts/config.schema.json)                            | 不包含明文凭据的配置版本结构                 |
| [节点协议 Schema](contracts/agent.schema.json)                         | 节点注册、心跳、领取、接收和结果事件         |
| [部署与凭据规则](docs/DEPLOYMENT_AND_SECURITY.md)                      | SSH、密钥、发布、网络和运维规则              |
| [开发阶段和验收](docs/ROADMAP.md)                                      | 实施顺序、验收场景和交付证据                 |
| [架构决策](docs/DECISIONS.md)                                          | 已确定选择及其变更条件                       |
| [P0 启动与验证](docs/P0_SETUP.md)                                      | 本地启动、管理员初始化、测试和边界           |
| [P1 部署与验证](docs/P1_SETUP.md)                                      | Linux Worker、发布构件、服务器接入及故障恢复 |
| [P1 增量契约](docs/P1_CONTRACT.md)                                     | 部署占用、身份注册、主机核验和重试规则       |
| [P2 配置与下载](docs/P2_SETUP.md)                                      | 升级、配置版本、下载任务、缓存与故障恢复     |
| [P2 增量契约](docs/P2_CONTRACT.md)                                     | 领取、租约、事件、每日缓存和网络约束         |
| [P3 安装注册](docs/P3_SETUP.md)                                        | 代理、注册流程、结果证据与验证边界           |
| [P3 增量契约](docs/P3_CONTRACT.md)                                     | 唯一提交、未知结果、账户与截图保护           |
| [手机屏幕契约](docs/MOBILE_SCREEN_CONTRACT.md)                         | 网页与落地页使用手机布局、竖屏和触屏操作     |
| [下载与注册需求](docs/DAILY_DOWNLOAD_AND_REGISTRATION_REQUIREMENTS.md) | 用户确认的每日 00:05、成功目标与尝试上限     |
| [1.5 执行契约](docs/V15_CONTRACT.md)                                   | 每日下载、缓存资产、配额、跨日与关闭规则     |
| [1.5 使用与验证](docs/V15_SETUP.md)                                    | 新版部署、代理检查、循环注册及每日计划       |
| [1.6 入口识别契约](docs/V16_CONTRACT.md)                               | 自动导航、原生表单、结果证明与路径学习       |
| [1.6 使用与验证](docs/V16_SETUP.md)                                    | 开启自动识别、发布升级及适配边界             |
| [1.7 结果与日志](docs/V17_SETUP.md)                                    | 统计、注册记录、执行时间线及新版操作流程     |
| [1.7 增量契约](docs/V17_CONTRACT.md)                                   | 查询边界、历史回填、日志与隐私规则           |
| [契约样例](contracts/README.md)                                        | 正反例与检查方式                             |

执行节点兼容 Ubuntu 24.04 / 26.04 LTS x86_64。Agent 0.4.1 在完整安装注册基础上，将网页、落地页及下载统一为手机竖屏和触屏模式；旧版本必须升级签名发布后才能使用这项默认行为。0.3.x 继续支持旧下载模式；版本沿革见 [兼容契约](docs/UBUNTU_COMPATIBILITY.md)，安装修复见 [驱动权限契约](docs/APPIUM_INSTALL_FIX.md) 和 [SDK 布局契约](docs/ANDROID_SDK_LAYOUT.md)。

## 开发规则

开发前阅读 [AGENTS.md](AGENTS.md) 和开发契约。跨模块行为先更新契约，再修改实现；不以界面完成度代替端到端验收。

Node.js 24 LTS 为开发基线，依赖安装使用 npm 和受版本控制的 package-lock.json。首次启动步骤见 [P0 启动与验证](docs/P0_SETUP.md)。

```sh
npm ci
npm run db:generate
npm run lint
npm run typecheck
npm run check:contracts
npm run build
```

代码仓库：[xiaolubanchad-debug/ll](https://github.com/xiaolubanchad-debug/ll)。仓库中只能提交代码、文档和虚构样例，禁止提交 SSH 私钥、代理口令、实际账户、APK 和执行日志。
