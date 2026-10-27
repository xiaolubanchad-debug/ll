# HTTP 接口契约

版本 1.0.0，前缀 /api/v1。此文件定义待实现接口，当前没有运行中的服务。控制端 REST 路由在 P0 生成 OpenAPI，并与本文逐项核对。

## 通用规则

JSON 字段用 camelCase，枚举用大写。成功返回资源本体或 {items,nextCursor}；异步操作返回 202 与 {operationId,resourceId,status}，不能在请求内等待部署结束。空结果返回 204。列表默认 20、最大 100，使用不透明 cursor；所有查询按授权范围过滤。

错误形状为 {error:{code,message,requestId,details}}。details 只包含非敏感字段及校验路径，不包含输入的秘密。HTTP 状态：400 格式错误、401 未认证、403 越权、404 不存在、409 并发或状态冲突、410 过期或吊销、413 内容过大、422 业务校验失败、429 限流、503 依赖暂不可用。

POST 创建批次、部署、配置版本、停止和核验必须带 Idempotency-Key。配置和资产编辑另带 If-Match 版本，旧版本返回 409 STALE_VERSION。任务快照创建后不可修改。

认证分为 AdminSession Cookie 与 NodeBearer。两种身份不能互相使用接口。浏览器写接口校验 CSRF，首次管理员初始化只能在部署命令中完成，没有公开自助注册入口。

## 管理接口

| 方法与路径 | 输入要点 | 返回与规则 |
| --- | --- | --- |
| POST /auth/login | username,password | 安全会话 Cookie，通用失败提示及限流 |
| POST /auth/logout | 无 | 204，撤销会话 |
| GET /auth/me | 无 | 管理员摘要，不返回密码摘要 |
| PUT /auth/password | currentPassword,newPassword | 撤销其他会话，记录审计 |
| GET /nodes | cursor,limit | 节点摘要，在线/能力/占用分开返回 |
| POST /nodes | name,host,port,username,credentialVersionId | Node，初始无可信指纹、不可部署 |
| GET /nodes/{id} | 无 | 节点信息、最新能力和部署摘要 |
| PATCH /nodes/{id} | name,连接资料，If-Match | 新资产版本；忙节点禁止修改连接 |
| DELETE /nodes/{id} | If-Match | 归档资产并吊销节点身份；先确保节点已停止，不卸载整机 |
| POST /nodes/{id}/fingerprint-probes | 无 | 异步探测，返回 observedFingerprint；不自动信任 |
| PUT /nodes/{id}/host-key | expectedFingerprint,If-Match | 保存管理员核验的值并审计 |
| POST /nodes/{id}/checks | 无 | 异步连接和能力检查，严格核对已保存主机指纹 |
| POST /nodes/{id}/reconciliations | decision,reason,evidenceIds | 记录核验；释放槽前确认旧进程终止，拒绝仅凭在线心跳释放 |
| GET /releases | cursor,limit | 已发布、签名验证的固定版本 |
| POST /releases | 受信构件清单及签名 | 验证成功才登记为固定发布，不接受任意 Shell 或未经核验的下载地址 |
| POST /deployments | nodeId,releaseId | 202，预留独占槽；拒绝 NODE_BUSY |
| GET /deployments | nodeId,status,cursor,limit | 部署任务列表 |
| GET /deployments/{id} | 无 | 状态、步骤、发布与最近错误 |
| POST /deployments/{id}/stop | reason | 202 或终态原结果，取消请求不等于已回滚 |
| GET /deployments/{id}/events | afterSequence,limit | 可补读事件列表 |
| GET /configs | cursor,limit | 配置摘要及最新版本号 |
| POST /configs | name | 配置容器，尚不可执行 |
| POST /configs/{id}/versions | 符合 config.schema.json 的正文 | 不可变版本、configVersionId、configHash |
| GET /configs/{id}/versions/{versionId} | 无 | 非敏感完整配置，不解密代理口令 |
| POST /secrets/versions | type 与 secretValue；私钥可用专用上传字段 | 仅返回 secretVersionId、type、createdAt；禁止记录请求体 |
| GET /secrets | type,cursor,limit | 秘密元数据，不返回值 |
| POST /secrets/{versionId}/revoke | reason | 吊销，保留引用及审计，不原地替换 |
| POST /runs | nodeId,configVersionId,releaseId；可选 supersedesRunId | 202，固定版本、占用节点、生成 runId |
| GET /runs | nodeId,status,cursor,limit | 批次摘要，状态原样返回 |
| GET /runs/{id} | 无 | 摘要、配置引用、停止意图、任务计数 |
| POST /runs/{id}/stop | reason | STOP_REQUESTED；排队时可直接 CANCELLED |
| GET /runs/{id}/tasks | cursor,limit | 任务状态和非敏感详情 |
| GET /runs/{id}/events | afterSequence,limit | 持久事件补读 |
| GET /runs/{id}/stream | Last-Event-ID | SSE，仅摘要和脱敏日志 |
| POST /tasks/{id}/reconciliations | outcome,reason,evidenceIds | 不改变原始 UNKNOWN 记录，追加人工核验决议 |
| POST /tasks/{id}/account-view | reason | 显式授权查看测试账户，短期响应且审计，Cache-Control:no-store |
| GET /artifacts/{id}/content | 无 | 鉴权下载，Content-Disposition，无磁盘路径透传 |
| GET /audit-events | cursor,limit | 管理操作审计 |
| GET /health/live | 无，公开 | 进程存活，不返回内部地址或配置 |
| GET /health/ready | 无，内部 | 数据库和关键依赖就绪，供部署系统使用 |

NodeConnection 凭据上传上限 64 KiB；普通配置正文上限 256 KiB；单张截图上限 10 MiB；单份日志上限 20 MiB。注册流程不得包含实际账户密码，只能引用生成变量。所有嵌套未知字段默认拒绝。

## 节点接口

以下业务正文采用 agent.schema.json 中的消息变体。认证仍通过 HTTP Header，节点 ID 同时校验令牌绑定关系。

| 方法与路径 | 消息或输入 | 返回与约束 |
| --- | --- | --- |
| POST /agent/enroll | kind=enroll，一次性 Bootstrap Bearer | nodeId、独立凭据、protocolVersion、轮换时间；no-store |
| POST /agent/heartbeats | kind=heartbeat | serverTime、desiredControl、租约到期及事件确认位置 |
| POST /agent/claims | kind=claim | 204 无任务；否则 Delivery，不分配其他节点任务 |
| POST /agent/deliveries/{id}/accept | kind=accept | 接收确认、有效租约；持久化后才能调用 |
| GET /agent/deliveries/{id}/config | 当前 fence | 固定配置与本任务 secrets；只有有效租约且未吊销身份可取 |
| POST /agent/events | kind=events | ackedEventIds、appliedThroughSequence、recordedForReview；持久化后响应 |
| PUT /agent/tasks/{taskId}/account | kind=account | 按 accountRef 幂等保存生成账户，重复内容不同则冲突；写入后不回显密码 |
| POST /agent/artifacts | multipart 文件、deliveryId、fence、taskId、kind、sha256 | artifactId，类型及归属校验，不接收任意文件路径 |
| POST /agent/reconcile | nodeId、bootId、未确认 delivery 和提交记录摘要 | 继续核验、停止或隔离决策；不自动重跑注册 |
| POST /agent/credentials/rotate | 旧身份认证 | 新节点凭据和过渡时间，旧凭据按规则失效 |

Delivery 包含 kind=delivery、protocolVersion、deliveryId、runId、nodeId、fence、configVersionId、configHash、releaseId、issuedAt、ackDeadline、leaseExpiresAt。任务领取结果不直接携带全部秘密，Agent 接收后通过受保护配置接口获取。响应有 Cache-Control:no-store。

账户先在节点生成 accountRef 并加密写入 SQLite，再经独立账户接口上传，普通事件仅带引用。账户接口验证节点与任务归属；租约过期后的账户补传仅附加为待核验证据，不能重获执行权。该接口正文属于秘密，禁止请求体日志和 SSE 转发。

desiredControl 为 CONTINUE 或 STOP。租约响应不能覆盖已置 STOP 的控制意图。离线后的迟到事件只作为核验证据，不能获得新的执行权。

首次启动 Agent 必须扫描 SQLite 记录，调用 reconcile，再尝试领取。结果未知的注册不能靠重新启动 Agent 清除。

## 事件和 SSE

业务事件至少包含 eventId、runId、可选 taskId、sequence、occurredAt、type、payload；节点上报另有 deliveryId 和 fence。sequence 在 delivery 内单调，SSE 另使用中台持久 event cursor 作为 id，避免各节点序号冲突。

事件类型限定为 RUN_STARTED、TARGETS_DISCOVERED、TASK_STAGE、SUBMISSION_INTENT、TASK_FINISHED、RUN_FINISHED、STOP_ACK、LOG。Schema 对 payload 分类型校验；账户、口令、完整 UI 输入和秘密不得放入 LOG。

SSE 使用 event:run-status、task-status、log、heartbeat；data 为非敏感 JSON。按 Last-Event-ID 补读；游标已过保留期则提示重新获取快照。SSE 断开不停止任务，也不丢弃已入库事件。

## 错误码基线

| 错误码 | 含义 | 默认重试 |
| --- | --- | --- |
| VALIDATION_FAILED | 字段或流程校验失败 | 修正后再试 |
| NODE_BUSY | 部署或任务已占用节点 | 等待，不自动复制任务 |
| NODE_OFFLINE | 未收到有效心跳 | 检查节点 |
| NODE_NOT_READY | 能力、协议或版本不满足 | 修复环境 |
| HOST_KEY_MISMATCH | SSH 主机身份不符 | 不自动忽略 |
| IDEMPOTENCY_CONFLICT | 同键不同请求体 | 使用原请求或明确新建 |
| STALE_VERSION | 编辑版本过期 | 刷新再编辑 |
| LEASE_EXPIRED / STALE_FENCE | 执行权失效 | 核验，不重跑注册 |
| SECRET_REVOKED | 引用凭据版本已吊销 | 新建配置版本 |
| NO_TARGETS | XPath 无匹配 | 修正配置 |
| APK_INVALID / ABI_UNSUPPORTED | 文件无效或架构不兼容 | 更换包或镜像 |
| FLOW_NOT_CONFIGURED | 包名无启用的注册流程 | SKIPPED，添加适配 |
| REGISTRATION_UNKNOWN | 提交后未获得确定结果 | 人工核验 |
| CLEANUP_INCOMPLETE | 无法证明执行环境已清理 | 隔离节点 |

创建批次响应示例：

```json
{
  "operationId": "77777777-7777-4777-8777-777777777777",
  "resourceId": "33333333-3333-4333-8333-333333333333",
  "status": "QUEUED"
}
```

第一版没有公开任意 Shell、通用 Appium 转发、AWS 创建实例、无限循环注册或明文秘密读取接口。
