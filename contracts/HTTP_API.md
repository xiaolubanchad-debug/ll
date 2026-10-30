# HTTP 接口契约

1.14 自有测试 APK、测试数据和独立设备档案见 [测试契约](../docs/V114_TEST_DATA_CONTRACT.md)；新增客户端仅用于中台控制的模拟器，实际请求 IP 直接随创建回执保存，不另做出口探测。

1.13.1 增加独立模拟器准备优化和步骤耗时，见 [性能契约](../docs/V1131_PERFORMANCE_CONTRACT.md)，对应 Agent 0.11.1；每轮新模拟器、代理和前台停留 10 秒保持。

1.13 增加 APP 启动停留 1/2 路并发与每日共享额度，见 [并发契约](../docs/V113_CONCURRENCY_CONTRACT.md)，对应 Agent 0.11.0。下载与部署仍整台互斥，完成数和尝试上限由两路共享。

1.12 新任务默认使用 APK 启动、前台停留 10 秒和清理，完成轮数不代表注册账户，见 [启动停留契约](../docs/V112_APP_OPEN_CONTRACT.md)，对应 Agent 0.10.0。旧注册历史保持原有含义。

1.11.2 沿用既有 BACK 关闭事件，账户前的通用弹层后备规则见 [增量契约](../docs/V1112_MODAL_CONTRACT.md)，对应 Agent 0.9.2；没有新增接口或配置字段。

1.11.1 增加只读 WAIT_OVERLAY、账户生成前的一次 RETRY_LOAD 和受限公告 BACK 方法，不新增路由或配置字段；只读退避、阶段校验和加载状态规则见 [读取增量契约](../docs/V1111_READ_CONTRACT.md)，对应 Agent 0.9.1。

1.11 增加可选启动准备设置与受限弹窗阶段事件，见 [增量契约](../docs/V111_CONTRACT.md)，对应 Agent 0.9.0；保留旧配置和无 phase 事件的兼容读取。

1.10.1 补充有界下载入口发现，见 [下载增量契约](../docs/V1101_DOWNLOAD_CONTRACT.md)，对应 Agent 0.8.1。请求、响应和配置 Schema 保持兼容。

1.10 默认内容隔离与真实功能测试见 [增量契约](../docs/V110_CONTRACT.md)，对应 Agent 0.8.0。原始画面不作为新执行证据上传或展示。

1.9.2 导航站跳过、注册入口修正与自动身份独立观察见 [增量契约](../docs/V192_CONTRACT.md)，对应 Agent 0.7.2。

1.9.1 的安卓版本一致性和复杂页面读取修正见 [实测修正契约](../docs/V191_CONTRACT.md)，对应 Agent 0.7.1。

1.9 安卓网页、APP 广告公告处理与页面读取遵循 [1.9 契约](../docs/V19_CONTRACT.md)，对应 Agent 0.7.0。

1.8.1 显式下载复跑规则见 [补充契约](../docs/V181_CONTRACT.md)；普通开始仍每日复用，不自动重下。

1.8 统一任务、开始停止与历史版本管理遵循 [1.8 契约](../docs/V18_CONTRACT.md)，兼容现有 Agent 0.6.0。

1.7 中台结果、中文日志、数据库汇总、历史回填与页面操作遵循 [1.7 契约](../docs/V17_CONTRACT.md)，操作见 [使用说明](../docs/V17_SETUP.md)。兼容 Agent 0.6.0，不改变注册提交及未知结果规则。

版本 1.14.3，前缀 /api/v1。已实现路由由 p0.http.json 至 v18.http.json 以及 v114.http.json 合并生成 openapi.json，CI 比较 Controller、清单和 OpenAPI。下表保留后续阶段设计，以机器清单判定实现范围。

1.6 增加可选 execution.autoRegistration、DISCOVERING 阶段和任务 recognition 摘要，见 [自动识别契约](../docs/V16_CONTRACT.md)。不增加任意截图识别、代码执行或公开 Appium 接口。自动模式仍只允许一次提交，未知结果暂停；启用配置要求新的 AUTO_REGISTRATION_V1 签名发布。

1.5 的 purpose=DOWNLOAD/REGISTER/PROXY_CHECK、N/M、来源下载资产、每日计划 CRUD 和代理探测规则见 [1.5 契约](../docs/V15_CONTRACT.md)。/runs 缺省 purpose 仍为 LEGACY，旧客户端保持原行为；新目的要求签名发布 DAILY_V1。计划更新使用 If-Match 和 Idempotency-Key；配置响应新增受运行时 Schema 校验的 executionPlan，不包含代理口令，秘密仍只在 secretVersions 中下发。App 画像或 UA 是否采集不影响注册成功判定。

1.5.1 不改变请求或响应结构；Agent 0.5.1 的出口检测最多依次请求两个固定 HTTPS 站点，任一返回合法 IP 才成功，仍标记 PROBE_ONLY。停止和无直连回退规则见 1.5 契约。

Agent 0.4.1 的 [移动端屏幕增量 1.4.1](../docs/MOBILE_SCREEN_CONTRACT.md) 不改变本接口版本：browserUserAgent 为空时使用固定 Android 手机浏览器默认值；非空时仅覆盖网页 UA，所有网页仍使用手机屏幕及触屏。

P0 提供登录和校验基础，P1 提供服务器及部署，P2 提供配置版本、下载批次、领取、配置下发、事件和重启核验，见 [P2 契约](../docs/P2_CONTRACT.md)。P3 增加账户加密上传、脱敏 PNG、账户查看审计及人工决议，见 [P3 契约](../docs/P3_CONTRACT.md)。配置与批次的创建、保存、停止和人工核验都要求幂等键，保存版本另需 If-Match。下载模式不下发代理口令。列表查询以机器清单及 Controller 为准，执行事件使用分页轮询，SSE 尚未实现。

节点平台新增接受 Ubuntu 26.04，与 24.04 共用检查和错误码；见 [兼容契约](../docs/UBUNTU_COMPATIBILITY.md)。新签名发布使用 Agent 0.3.1 / Playwright 1.64.1，不改变路由或数据库结构。

## 通用规则

JSON 字段用 camelCase，枚举用大写。成功返回资源本体或 {items,nextCursor}；异步操作返回 202 与 {operationId,resourceId,status}，不能在请求内等待部署结束。空结果返回 204。列表默认 20、最大 100，使用不透明 cursor；所有查询按授权范围过滤。

错误形状为 {error:{code,message,requestId,details}}。details 只包含非敏感字段及校验路径，不包含输入的秘密。HTTP 状态：400 格式错误、401 未认证、403 越权、404 不存在、409 并发或状态冲突、410 过期或吊销、413 内容过大、422 业务校验失败、429 限流、503 依赖暂不可用。

POST 创建批次、部署、配置版本、停止和核验必须带 Idempotency-Key。配置和资产编辑另带 If-Match 版本，旧版本返回 409 STALE_VERSION。任务快照创建后不可修改。

认证分为 AdminSession Cookie 与 NodeBearer。两种身份不能互相使用接口。浏览器写接口校验 CSRF，首次管理员初始化只能在部署命令中完成，没有公开自助注册入口。

## 管理接口

| 方法与路径                             | 输入要点                                                    | 返回与规则                                                      |
| -------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------- |
| POST /auth/login                       | username,password                                           | 安全会话 Cookie，通用失败提示及限流                             |
| POST /auth/logout                      | 无                                                          | 204，撤销会话                                                   |
| GET /auth/me                           | 无                                                          | 管理员摘要，不返回密码摘要                                      |
| PUT /auth/password                     | currentPassword,newPassword                                 | 撤销其他会话，记录审计                                          |
| GET /nodes                             | cursor,limit                                                | 节点摘要，在线/能力/占用分开返回                                |
| POST /nodes                            | name,host,port,username,credentialVersionId                 | Node，初始无可信指纹、不可部署                                  |
| GET /nodes/{id}                        | 无                                                          | 节点信息、最新能力和部署摘要                                    |
| PATCH /nodes/{id}                      | name,连接资料，If-Match                                     | 新资产版本；忙节点禁止修改连接                                  |
| DELETE /nodes/{id}                     | If-Match                                                    | 归档资产并吊销节点身份；先确保节点已停止，不卸载整机            |
| POST /nodes/{id}/fingerprint-probes    | 无                                                          | 异步探测，返回 observedFingerprint；不自动信任                  |
| PUT /nodes/{id}/host-key               | probeId,expectedFingerprint,If-Match                        | 保存与本资产版本成功探测一致、由管理员核验的主机公钥并审计      |
| POST /nodes/{id}/checks                | 无                                                          | 异步连接和能力检查，严格核对已保存主机指纹                      |
| POST /nodes/{id}/reconciliations       | checkId,reason                                              | 新检查确认无安装标记且无活动占用，人工解除隔离；心跳不能释放    |
| GET /releases                          | cursor,limit                                                | 已发布、签名验证的固定版本                                      |
| POST /releases                         | 受信构件清单及签名                                          | 验证成功才登记为固定发布，不接受任意 Shell 或未经核验的下载地址 |
| POST /deployments                      | nodeId,releaseId                                            | 202，预留独占槽；拒绝 NODE_BUSY                                 |
| GET /deployments                       | nodeId,status,cursor,limit                                  | 部署任务列表                                                    |
| GET /deployments/{id}                  | 无                                                          | 状态、步骤、发布与最近错误                                      |
| POST /deployments/{id}/stop            | reason                                                      | 202 或终态原结果，取消请求不等于已回滚                          |
| GET /deployments/{id}/events           | afterSequence,limit                                         | 可补读事件列表                                                  |
| GET /configs                           | cursor,limit                                                | 配置摘要及最新版本号                                            |
| POST /configs/validate                 | 符合 config.schema.json 的草稿                              | P0 已实现，只校验无持久化，返回 {valid:true}，要求会话和 CSRF   |
| POST /configs                          | name                                                        | 配置容器，尚不可执行                                            |
| POST /configs/{id}/versions            | 符合 config.schema.json 的正文                              | 不可变版本、configVersionId、configHash                         |
| GET /configs/{id}/versions/{versionId} | 无                                                          | 非敏感完整配置，不解密代理口令                                  |
| POST /secrets/versions                 | type 与 secretValue；页面文件读取后作为 privateKey 字段上传 | 仅返回 id、type、createdAt；禁止记录请求体                      |
| GET /secrets                           | type,cursor,limit                                           | 秘密元数据，不返回值                                            |
| POST /secrets/{versionId}/revoke       | reason                                                      | 吊销，保留引用及审计，不原地替换                                |
| POST /runs                             | nodeId,configVersionId,releaseId；可选 supersedesRunId      | 202，固定版本、占用节点、生成 runId                             |
| GET /runs                              | nodeId,status,cursor,limit                                  | 批次摘要，状态原样返回                                          |
| GET /runs/{id}                         | 无                                                          | 摘要、配置引用、停止意图、任务计数                              |
| POST /runs/{id}/stop                   | reason                                                      | STOP_REQUESTED；排队时可直接 CANCELLED                          |
| GET /runs/{id}/tasks                   | cursor,limit                                                | 任务状态和非敏感详情                                            |
| GET /runs/{id}/events                  | afterSequence,limit                                         | 持久事件补读                                                    |
| GET /runs/{id}/stream                  | Last-Event-ID                                               | SSE，仅摘要和脱敏日志                                           |
| POST /tasks/{id}/reconciliations       | outcome,reason,evidenceIds                                  | 不改变原始 UNKNOWN 记录，追加人工核验决议                       |
| POST /tasks/{id}/account-view          | reason                                                      | 显式授权查看测试账户，短期响应且审计，Cache-Control:no-store    |
| GET /tasks/{taskId}/artifacts          | 无                                                          | 仅受限功能证据摘要，不返回历史图片或存储路径                    |
| GET /artifacts/{id}/content            | 无                                                          | 鉴权返回受限 JSON，历史图片返回 410；无磁盘路径透传             |
| GET /audit-events                      | cursor,limit                                                | 管理操作审计                                                    |
| GET /health/live                       | 无，公开                                                    | 进程存活，不返回内部地址或配置                                  |
| GET /health/ready                      | 无，内部                                                    | 数据库和关键依赖就绪，供部署系统使用                            |
| GET /openapi.json                      | 管理员会话                                                  | P0/P1 已实现路由的生成文档                                      |

登录及 me 返回 SessionView，包括 admin 摘要和 csrfToken。改密成功也返回 SessionView，并轮换当前 Cookie、撤销旧会话。密码修改和配置校验请求使用 JSON，Header 包含精确 Origin 与 X-CSRF-Token。会话最长 12 小时，非滑动续期。P0 管理员密码为 12–128 个字符，不采用 APK 测试账户的 8–12 位规则。

NodeConnection 凭据上传上限 64 KiB；普通配置正文上限 256 KiB；单份功能证据上限 64 KiB；单份日志上限 20 MiB。注册流程不得包含实际账户密码，只能引用生成变量。所有嵌套未知字段默认拒绝。

## 节点接口

以下业务正文采用 agent.schema.json 中的消息变体。认证仍通过 HTTP Header，节点 ID 同时校验令牌绑定关系。

| 方法与路径                         | 消息或输入                                                                       | 返回与约束                                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| POST /agent/enroll                 | kind=enroll，一次性 Bootstrap Bearer                                             | nodeId、credential、protocolVersion、heartbeatIntervalSeconds；no-store                       |
| POST /agent/heartbeats             | kind=heartbeat，可选 report，P1 currentDelivery 必须为 null                      | serverTime、desiredControl、heartbeatIntervalSeconds；执行租约随 P2 扩展                      |
| POST /agent/claims                 | kind=claim                                                                       | 204 无任务；否则 Delivery，不分配其他节点任务                                                 |
| POST /agent/deliveries/{id}/accept | kind=accept                                                                      | 接收确认、有效租约；持久化后才能调用                                                          |
| POST /agent/deliveries/{id}/config | 当前 fence                                                                       | 固定配置与本任务 secrets；只有有效租约且未吊销身份可取                                        |
| POST /agent/events                 | kind=events                                                                      | ackedEventIds、appliedThroughSequence、recordedForReview；持久化后响应                        |
| PUT /agent/tasks/{taskId}/account  | kind=account                                                                     | 按 accountRef 幂等保存生成账户，重复内容不同则冲突；写入后不回显密码                          |
| POST /agent/artifacts              | JSON/Base64 功能证据、bootId、deliveryId、fence、taskId、kind、sha256、redaction | artifactId，先鉴权后解析大正文；受限规范 JSON ≤64 KiB，Schema、类型及归属校验，不接收任意路径 |
| POST /agent/reconcile              | nodeId、bootId、未确认 delivery 和提交记录摘要                                   | 继续核验、停止或隔离决策；不自动重跑注册                                                      |
| POST /agent/credentials/rotate     | 旧身份认证                                                                       | 新节点凭据和过渡时间，旧凭据按规则失效                                                        |

Delivery 包含 kind=delivery、protocolVersion、deliveryId、runId、nodeId、fence、configVersionId、configHash、releaseId、issuedAt、ackDeadline、leaseExpiresAt。任务领取结果不直接携带全部秘密，Agent 接收后通过受保护配置接口获取。响应有 Cache-Control:no-store。

账户先在节点生成 accountRef 并加密写入 SQLite，再经独立账户接口上传，普通事件仅带引用。账户接口验证节点与任务归属；租约过期后的账户补传仅附加为待核验证据，不能重获执行权。该接口正文属于秘密，禁止请求体日志和 SSE 转发。

desiredControl 为 CONTINUE 或 STOP。租约响应不能覆盖已置 STOP 的控制意图。离线后的迟到事件只作为核验证据，不能获得新的执行权。

首次启动 Agent 必须扫描 SQLite 记录，调用 reconcile，再尝试领取。结果未知的注册不能靠重新启动 Agent 清除。

## 事件和 SSE

业务事件至少包含 eventId、runId、可选 taskId、sequence、occurredAt、type、payload；节点上报另有 deliveryId 和 fence。sequence 在 delivery 内单调，SSE 另使用中台持久 event cursor 作为 id，避免各节点序号冲突。

事件类型限定为 RUN_STARTED、TARGETS_DISCOVERED、TASK_STAGE、SUBMISSION_INTENT、TASK_FINISHED、RUN_FINISHED、STOP_ACK、LOG。Schema 对 payload 分类型校验；账户、口令、完整 UI 输入和秘密不得放入 LOG。

SSE 使用 event:run-status、task-status、log、heartbeat；data 为非敏感 JSON。按 Last-Event-ID 补读；游标已过保留期则提示重新获取快照。SSE 断开不停止任务，也不丢弃已入库事件。

## 错误码基线

| 错误码                        | 含义                   | 默认重试             |
| ----------------------------- | ---------------------- | -------------------- |
| VALIDATION_FAILED             | 字段或流程校验失败     | 修正后再试           |
| NODE_BUSY                     | 部署或任务已占用节点   | 等待，不自动复制任务 |
| NODE_OFFLINE                  | 未收到有效心跳         | 检查节点             |
| NODE_NOT_READY                | 能力、协议或版本不满足 | 修复环境             |
| HOST_KEY_MISMATCH             | SSH 主机身份不符       | 不自动忽略           |
| IDEMPOTENCY_CONFLICT          | 同键不同请求体         | 使用原请求或明确新建 |
| STALE_VERSION                 | 编辑版本过期           | 刷新再编辑           |
| LEASE_EXPIRED / STALE_FENCE   | 执行权失效             | 核验，不重跑注册     |
| SECRET_REVOKED                | 引用凭据版本已吊销     | 新建配置版本         |
| NO_TARGETS                    | XPath 无匹配           | 修正配置             |
| APK_INVALID / ABI_UNSUPPORTED | 文件无效或架构不兼容   | 更换包或镜像         |
| FLOW_NOT_CONFIGURED           | 包名无启用的注册流程   | SKIPPED，添加适配    |
| REGISTRATION_UNKNOWN          | 提交后未获得确定结果   | 人工核验             |
| CLEANUP_INCOMPLETE            | 无法证明执行环境已清理 | 隔离节点             |

创建批次响应示例：

```json
{
  "operationId": "77777777-7777-4777-8777-777777777777",
  "resourceId": "33333333-3333-4333-8333-333333333333",
  "status": "QUEUED"
}
```

第一版没有公开任意 Shell、通用 Appium 转发、AWS 创建实例、无限循环注册或明文秘密读取接口。
