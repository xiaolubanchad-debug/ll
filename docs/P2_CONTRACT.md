# P2 配置、任务与下载契约

版本 1.2.0。P2 执行 DOWNLOAD_ONLY；FULL 配置可保存，开始执行时返回 FEATURE_UNAVAILABLE，安装和注册仍属 P3。节点协议 1.0 保留原消息，新增可选 downloadProtocol=1.0；只有签名发布包含 DOWNLOAD_V1 且心跳声明该能力的节点可以接收 P2 任务。P1 节点继续注册及心跳，但必须升级才能下载。

配置容器与不可变版本分开保存。创建、保存版本、开始、停止和人工核验采用 Idempotency-Key；保存版本另校验 If-Match 容器版本。相同键重发返回原结果，内容改变拒绝。配置摘要为规范 JSON SHA256；普通接口只返回固定秘密版本引用，不返回代理口令。DOWNLOAD_ONLY 不下发代理秘密。

批次创建事务内锁 Node 和 NodeSlot，固定配置、节点及发布版本，独占 runId 槽，与部署和其他批次互斥。领取重复返回同一 delivery；ACK 30 秒、租约 120 秒。Agent 先写 SQLite，再 accept，再读取配置并核对 SHA256。心跳和所有状态写入核对节点、bootId、deliveryId、fence 和固定发布，心跳不能清除停止意图。

事件按 delivery/sequence 持久化，eventId 和 sequence 的内容冲突拒绝；乱序先保存，连续后才应用。API 返回已保存 IDs 和连续应用位置；Agent SQLite outbox 在 ACK 后标记已发送。迟到或失效 fence 的事件仅作核验证据。成功必须有全部目标及经过 DOWNLOADED 的静态 APK 校验记录，不能把空目标或任意成功消息计为成功。

目标发现事件可按 startIndex 连续分块，complete=true 才结束发现并允许下载；兼容旧样例中省略这两个字段的单块消息。P2 心跳缩短到 5 秒以响应停止，P1 保持 15 秒。页面使用事件分页与状态轮询；SSE 留待后续增强。

停止排队任务可立即取消；已领取则 STOP_REQUESTED，收到 STOP_ACK(cleanupComplete=true) 才取消并释放槽。超时、重启和租约失效进入 NEEDS_REVIEW，保持隔离，不分配到其他节点。Agent 启动先清理自己记录的浏览器进程并 reconcile，不重跑旧 delivery；管理员须引用节点确认的清理结果和新的空闲心跳才能解除隔离。原 NEEDS_REVIEW 记录保持，新任务另建。

浏览器在源页面按 DOM 顺序发现 XPath 全部元素，相同 pid+href 合并轮播副本；无 pid 保留位置。targetKey 规范化 source URL（保留 query，去 fragment）、XPath、pid、绝对 href 及必要位置。超限明确失败。点击前监听下载及新窗口，同页、弹窗和直接下载共用处理；落地页按精确 host 优先、通配其次的规则有限点击。发现最多重试一次，单目标下载最多重试两次，停止和租约失效不重试。

网页和 APK 不使用业务代理。专用本地 HTTP(S) 出口代理逐连接解析域名，拒绝所有非公网地址和混合解析，连接固定到已核验地址；每次重定向重新核验。Chromium 显式取消 loopback 代理豁免、禁用 QUIC 和非代理 WebRTC，拦截非 HTTP(S) 导航；远端部署增加专用服务账号的私网出口限制。测试只可通过代码注入精确测试端点，管理配置无放行内网选项。

宿主机出口规则已获得用户明确授权，范围仅执行账户，记录见 [P2_EGRESS_REVIEW.md](P2_EGRESS_REVIEW.md)。代码和语法测试不能替代真实 EC2 生效检查；浏览器 HTTP(S) 防护仍须独立通过真实测试。

文件先进入任务临时目录，默认最多 256 MiB，可配置 1 KiB–512 MiB；超时、停止及失败清理临时文件。验证 ZIP 结构、条目路径/重复、CRC、解压上限及二进制 AndroidManifest 的包名，提取版本和原生 ABI。该证明仅为 FILE_VALIDATION，不表示已安装或注册。元数据不含节点绝对路径，APK 保留在节点，不上传到公共目录。

cacheKey 包含 nodeId、开始下载时 Asia/Shanghai 日期及 targetKey。成功后文件和校验元数据原子落库；同日命中仍重新检查大小、SHA256 和 APK 内容，损坏则重新下载。跨日重新下载，不因完成时间跨日改变归属。SQLite 单节点进程锁阻止并发 Agent；浏览器、outbox、缓存均在持久目录，升级不清空。默认清理 7 天前且无未完成批次引用的缓存。

管理页面提供配置版本列表/查看/保存、固定版本开始下载、任务状态/目标结果/事件及停止和核验。页面网络重试保留同一幂等键。验收使用真实 PostgreSQL、SQLite、Chromium 和本地自有站点；真实 EC2 和实际产品网站另行标明验证范围。
