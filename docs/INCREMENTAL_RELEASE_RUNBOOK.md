# 增量发布操作

依据 [1.18 发布契约](V118_INCREMENTAL_RELEASE_CONTRACT.md)。版本名称不能决定是否可以复用环境，最终以节点检查和新心跳为准。

## 中台

1. 记录当前已部署提交 `BASE`。源码必须提交且工作区干净。
2. `node scripts/release-plan.mjs BASE` 查看相关模块和测试范围。未知源文件、共享契约及数据库变更保守扩大检查。
3. `npm run release:verify -- BASE`：运行契约、lint、类型、相关构建和测试，成功后生成 `.tmp/release-verification.json`。首次改造运行完整测试；之后可通过 `node scripts/test-p0.mjs --only p1,incremental-release` 选择已有测试文件，拼错或未执行的选择会失败。
4. 在宿主机切换到同一提交，拷贝验证回执，执行 `/opt/apk-hub/ops/runtime/node scripts/release-hub.mjs BASE /受保护目录/release-verification.json`。主机第一次可使用 `node scripts/bootstrap-hub-node.mjs` 从已有固定摘要基础镜像安装独立 Node 24，不替换系统 Node。
5. 发布入口持有宿主机锁、数据库发布门禁及现有任务库锁，要求无任务、部署和隔离槽。构建只选相关服务，使用受版本控制的 `deploy/hub/Dockerfile`；依赖安装层优先缓存。已有 Compose 的网络、凭据、权限和卷继续沿用。只更新相关 API、worker、web 镜像，tools 按需构建，不重启 PostgreSQL。

`ops/module-release.json` 记录提交、验证范围、原容器、更新模块、耗时及状态，`ops/module-releases/` 保存回退信息。未知结果保留 NEEDS_REVIEW；完成核对后才允许再次发布，不能直接删除锁文件假装成功。数据库迁移开始后不自动回滚旧业务镜像，避免错误假定旧程序兼容新表结构。其他确定的故障只回退本次涉及的模块。

常规控制器、容量统计、任务控制、发布服务和 Agent 健康报告均有明确测试映射。比如只改容量统计运行容量与服务器交互测试，健康报告运行部署及 Agent 启动测试；共享安全实现、数据库、契约及无法确定影响的代码保守退回完整回归。独立测试会自行初始化管理员，不依赖先运行整套认证测试。测试用例名称未找到或选择的用例没有真正执行时拒绝通过。

## EC2 Agent

- 常规发布：基于已验签清单复用工具链和 npm 锁，`RELEASE_BASE_ID=<已登记清单 UUID>` 后运行 `npm run release:agent`。依赖发生变化时拒绝复用，需显式不设置该值刷新环境元数据并重新全量验证。
- 选择发布版本和默认“自动：环境一致时增量更新”。签名、构件 SHA、固定 Playbook、节点数据库锁、远程安装标记、幂等及 Agent 注册不变。
- 旧 Agent 首次升级到 0.15.0 需要建立可信全量基线。以后 AUTO 轻量核对运行库、浏览器、SDK/型号文件元数据、操作系统包状态及驱动清单；匹配时采用 CODE，任何漂移转 FULL。
- 更改 Android SDK、系统镜像、型号目录或环境配方，必须全量。也可手动选择强制完整环境校验。
- 部署成功要求目标发布 ID、版本、构建提交、环境指纹及方式全部匹配，并收到激活之后的新心跳。步骤和结果显示“代码增量更新”或“完整环境校验”。CODE 保留上次真实全量验证发布和时间，不生成虚假启动证明。

环境基线只减少重复的大文件读取，元数据检查不等于本次全镜像 SHA 审计。系统升级、定期环境审计或怀疑文件完整性时使用强制 FULL。原始回执、密钥、APK、账户与执行证据保存在受保护的运行目录，不提交 Git。
