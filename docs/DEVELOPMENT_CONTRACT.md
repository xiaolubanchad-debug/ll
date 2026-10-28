# 开发契约

版本 1.3.1，日期 2026 年 10 月 28 日。MUST 表示发布必须满足，SHOULD 表示偏离时必须记录原因，MAY 表示可选。P0/P1 实现范围见对应启动文档；P2 行为由 [P2_CONTRACT.md](P2_CONTRACT.md) 细化，验证边界见 [P2_SETUP.md](P2_SETUP.md)。P3/P4 的契约不表示已完成能力。

## 契约权威与变更

优先级为用户最新明确要求、带版本的本契约与接口契约、JSON Schema、实施方案、实现代码。发现相互冲突必须在同一变更中修正，不允许通过实现悄悄改变接口含义。

contracts/ 下的 JSON Schema 是线上数据结构校验来源，HTTP_API.md 定义路由和行为。从这些结构及 p0.http.json、p1.http.json 生成共享 TypeScript 类型、静态校验器与 OpenAPI，并纳入漂移检查。类型生成对 if/then/else 只表达结构，跨字段约束由公共运行时校验器负责，不能仅依赖 TypeScript 编译来验证外部请求。

接口前缀为 /api/v1，节点协议 protocolVersion 为 1.0，配置 schemaVersion 为 1.0。新增可选字段必须保留默认行为；改变必填项、字段类型、状态含义、重试或提交规则属于破坏性变更，必须升级契约版本并提供迁移及兼容测试。不兼容节点拒绝接收任务，界面显示需升级。

Ubuntu 24.04 与 26.04 的执行节点检查及固定浏览器版本遵循 [平台兼容契约 1.3.0](UBUNTU_COMPATIBILITY.md)；平台接受不代替 KVM 和实际安卓启动证明。

## 模块与进程边界

1. web 只能调用 control-api。页面仅在管理员上传时短暂持有 SSH 凭据，保存或退出表单后清除；不持久保存凭据，不接收已保存秘密的明文，不持有数据库密码或节点令牌，不直接连接服务器。
2. control-api 接受管理及节点业务请求；deploy-worker 使用受限数据库账号领取部署任务和写入部署事件。两者的状态更新通过共享领域服务及事务规则完成，不能各写一套规则。Agent 无中台数据库访问权限。
3. deploy-worker 只执行固定发布的 Playbook。不得把 URL、XPath、标签或凭据拼接成 Shell，不提供任意远程命令接口。
4. agent 通过 HTTPS 调用中台，不能访问中台数据库。automation 包只接受已验证的任务输入，通过回调输出事件，不读取管理端会话和 SSH 凭据。
5. 注册流程只允许 click、input、wait、back 和 submit。禁止 eval、任意 JavaScript、Shell、插件上传和任意 Appium 命令透传。
6. 所有外部进程以参数数组启动，shell=false。进程组、超时和清理都有归属记录，不能用 pkill 杀死其他服务的模拟器。

## 标识与时间

实体 ID 使用 UUID；顺序由单独的 sequence 表示，不从 UUID 推断先后。所有传输时间使用 UTC RFC3339，界面默认 Asia/Shanghai。下载 cacheDay 用 Asia/Shanghai 日历日期，跨日以开始下载时的日期为准，不能下载结束后重新计算日期。

runId 是批次，taskId 是单个图标任务，deliveryId 是一次节点分配，eventId 是事件去重键，fence 是递增执行代号。任何重试必须区分网络请求重发、下载重试和新建业务测试。

## 核心数据与约束

| 实体 | 必要内容 | 不变量 |
| --- | --- | --- |
| Admin / Session | 密码摘要、会话到期、撤销时间 | 密码不明文，首次设置无默认通用密码 |
| Node | 地址、SSH 凭据引用、主机指纹、能力、心跳、版本 | 注册令牌一次性，Agent 凭据仅授权自身 |
| SecretVersion | 类型、密文、密钥 ID、版本、吊销状态 | 只追加版本，普通查询不返回秘密 |
| Release | 构件摘要、签名、兼容协议、依赖清单 | 已发布版本不可变，不能引用分支 HEAD |
| Deployment | 节点、发布、状态、步骤与事件 | 一个节点同一时刻仅一个部署，不与执行任务并行 |
| ConfigVersion | schemaVersion、配置内容、摘要、创建者 | 保存后不可变，凭据引用固定到版本 |
| Run | 节点、配置版本、发布版本、幂等键、状态 | 一批次一个节点，不动态换配置 |
| Delivery / NodeSlot | 租约、fence、接收确认、节点槽 | 数据库事务互斥，失联不等于可重新占用 |
| Task | 图标快照、包元数据、阶段、提交意图、结果 | 一个批次同一 targetKey 只有一个任务 |
| Event / Outbox | 事件 ID、时间、sequence、已确认位置 | 同一 eventId 或同一任务 sequence 不重复生效 |
| Artifact | 任务、类型、相对存储键、大小、SHA-256 | 不接受任意写入路径，不公开直接访问 |
| AccountResult | 任务、账户密文、查看审计 | 不进入 SSE 和普通日志 |

配置摘要是规范化非敏感 JSON 的 SHA-256；下发的秘密独立于配置正文，不记录到摘要样例或日志。旧 SecretVersion 被吊销时，引用它的新批次拒绝执行，不自动替换成最新版。

## 节点连接和健康

节点有独立维度：connection 为 ONLINE 或 OFFLINE；deployment 为未部署、部署中、失败或已安装；capabilities.download / android 为环境检查结果；occupancy 为 IDLE、BUSY、DRAINING 或 QUARANTINED。不能用一个 online 布尔值代表可运行安卓。

默认每 15 秒心跳，45 秒未收到则显示 OFFLINE。健康信息包含系统、磁盘、KVM、工具版本和当前 deliveryId，不传输口令。完整任务必须同时满足协议兼容、安卓健康检查通过、节点空闲、发布版本一致、配置有效。

注册 bootstrap 令牌默认有效期 10 分钟、使用一次、绑定节点。注册后换取独立 Agent 凭据。初次注册或凭据轮换不应覆盖未核验的旧进程，必须先停止旧服务并协调旧任务。

## 任务分配和租约

1. 管理员创建批次时，事务内验证节点、配置和固定发布版本，预留节点槽。并发请求只有一个成功，另一个返回 NODE_BUSY。
2. Agent 通过 POST /agent/claims 领取自身已分配批次。中台返回 deliveryId、fence、ACK 截止时间和租约到期时间。重复领取返回同一个 delivery，不创建第二份任务。
3. 租约默认 120 秒，接收确认截止 30 秒。Agent 在 SQLite 中持久化 delivery 后调用 accept，成功后才执行。网络重试使用相同 deliveryId 和 fence。
4. 心跳延长租约，但不清除 stopRequested。所有写状态和续租请求必须匹配当前 deliveryId 与 fence。
5. ACK 超时、节点重启或租约失效后，旧任务进入 NEEDS_REVIEW，节点隔离。中台不得自动把该任务分配给另一节点；恢复需 reconcile 确认旧进程终止和实际执行进度。
6. 租约失效后 Agent 不开始新的外部动作，也不再领取目标。已经提交注册时只做有界结果核验和本地记录，然后清理。失去授权不能无限继续整批测试。
7. 旧 fence 的事件可以作为隔离的迟到证据保存并返回 recordedForReview=true，但不能续租、重新激活任务、释放新执行槽或直接覆盖新结果。
8. 批次执行期间节点必须保持固定发布版本。中台升级及配置保存都不能更改已分配快照。

## 状态与转换

批次状态固定为：QUEUED、ASSIGNED、RUNNING、STOP_REQUESTED、SUCCEEDED、PARTIAL_FAILED、FAILED、CANCELLED、NEEDS_REVIEW。

| 当前状态 | 合法后继 | 条件 |
| --- | --- | --- |
| QUEUED | ASSIGNED、CANCELLED、FAILED | 领取；未领取取消；前置检查失败 |
| ASSIGNED | RUNNING、STOP_REQUESTED、NEEDS_REVIEW | 持久化接收确认；要求停止；ACK 或租约异常 |
| RUNNING | STOP_REQUESTED、SUCCEEDED、PARTIAL_FAILED、FAILED、NEEDS_REVIEW | 以任务汇总和确认状态判定 |
| STOP_REQUESTED | CANCELLED、NEEDS_REVIEW | 节点确认安全停止；无法确认或有未知注册结果 |
| NEEDS_REVIEW | 终态保持 | 写入核验决议，重试必须新建关联批次 |
| SUCCEEDED、PARTIAL_FAILED、FAILED、CANCELLED | 终态保持 | 禁止复活和原地重跑 |

单 APK 任务阶段为 QUEUED → DOWNLOADING → DOWNLOADED → PREPARING → INSTALLING → LAUNCHING → REGISTERING → VERIFYING → SUCCEEDED。下载模式在 DOWNLOADED 后可直接 SUCCEEDED。缓存命中仍产生 DOWNLOADED 事件并标记 cacheHit。

允许退出至 FAILED、SKIPPED 或 CANCELLED。提交意图写入后无法确认成功或失败时转 UNKNOWN；不能因工作进程退出就记为注册失败。阶段单调前进，迟到事件不使状态倒退。

汇总优先级：存在 UNKNOWN 或执行权不确定则 NEEDS_REVIEW；已确认停止则 CANCELLED 并保留完成项；无匹配项则 FAILED/NO_TARGETS；全部任务成功才 SUCCEEDED；有成功也有失败或跳过则 PARTIAL_FAILED；没有成功则 FAILED。SKIPPED 不计为注册成功。

## 停止、重启与提交

点击停止是请求，不是结果。界面先显示 STOP_REQUESTED，Agent 心跳收到意图后停止进入下一个目标。排队中的批次可以直接 CANCELLED。节点离线时提示停止待送达，不宣称已停。

提交前的下载或准备步骤 SHOULD 在 10 秒内响应停止，随后最多等待 30 秒清理。已经提交注册时最多继续核验 60 秒；核验不了则 UNKNOWN。清理超时或无法证明进程已停止时节点保持 QUARANTINED，不能释放给新任务。

提交的顺序 MUST 为：生成账户 → 加密持久化账户 → 持久化 submissionId 与提交意图 → 调用唯一 submit → 观察成功或明确失败 → 持久化结果 → 上传。提交意图到远端实际生效之间无法做到原子事务，因此不承诺产品端 exactly once。

Agent 重启后先恢复本地记录并向中台 reconcile，不立即重跑。提交意图存在但结果缺失的账户标为 UNKNOWN。管理员核验并记录决议后，才允许在新批次中重试；原记录保留，不能删掉后自动再注册。

## 幂等和重试

创建批次、部署、保存配置版本、停止及核验接口 MUST 使用 Idempotency-Key。键按管理员或节点、HTTP 方法及路由作用域保存；相同键相同请求体返回原结果，相同键不同请求体返回 IDEMPOTENCY_CONFLICT。有效记录至少保留 7 天，运行中对象不能提前清理。

浏览器发现可重试一次，但不能重复建立相同 targetKey。下载最多重试两次，使用指数退避；失败临时文件删除。Appium 点击 submit、WebdriverIO 命令重试和完整注册流程自动重试必须关闭。

任务创建成功但响应丢失时，页面以原幂等键查询或重发。节点上传事件按 eventId 去重，本地 SQLite 先写后发。中台写库成功才 ACK，本地收到 ACK 后才能清理待传队列。同 eventId 或同 delivery/sequence 的正文不一致返回 EVENT_CONFLICT。

事件按 delivery 内 sequence 顺序派生状态。允许重传和跨请求乱序到达，但有序号缺口的事件先暂存，不能越过缺失的 SUBMISSION_INTENT 就判定可安全重试。响应区分已持久化的 ackedEventIds 和已应用的 appliedThroughSequence；节点保留未确认事件并补发缺口。

## 缓存和证据

targetKey = SHA-256(规范化 source URL、XPath、pid、绝对 href、必要的位置标识)。URL 保留业务 query，不擅自去除推广参数；规范化只处理 scheme/host 大小写和 fragment。入口去重与下载缓存使用相同规则，避免轮播副本重复注册。

cacheKey 包含 nodeId、cacheDay 和 targetKey。缓存必须同时有成功校验元数据、存在的文件及匹配的 SHA-256。不同入口下载到相同 APK 时可共享文件实体，但任务和来源独立，不能未经配置就删除其中一个入口测试。

文件证据类型限定为 screenshot、ui-tree、log、result。上传大小、扩展名和 MIME 有限制，SHA-256 核对，所有下载通过鉴权 API。日志默认保留 30 天，截图 14 天、APK 缓存 7 天；有未完成或 UNKNOWN 引用时暂停相关清理。账户默认保留 30 天并允许管理员提前销毁秘密，审计及非敏感结果继续保留。

## 验收和代码约束

TypeScript strict 模式，禁止用 any 绕过协议校验；密钥由专用模块管理，日志只有脱敏出口；网络请求有超时与响应上限。数据库迁移随版本提交，不手动修改生产结构。

每个跨模块变更必须包含契约差异、相应正反例、迁移影响和有意义的验证。必测行为包括节点并发占用、重复下发、停止离线、submit 超时、过期 fence、下载缓存损坏、秘密脱敏及重启恢复。测试先使用模拟节点和自有测试页面，真实注册只有在目标 APK 和流程准备好后执行。

不创建与实现逐行镜像的测试，不为文档排版写业务测试。实际测试通过前不得标记阶段验收完成。详细场景见 ROADMAP.md。
