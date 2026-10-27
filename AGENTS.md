# 项目开发约定

先阅读 README.md、docs/PLAN.md、docs/DEVELOPMENT_CONTRACT.md、contracts/HTTP_API.md 及本次涉及的 Schema。用户最新明确要求优先，契约冲突在同一变更中修订。

- 主业务只使用 Node.js 24 和 TypeScript strict。Python 仅为 Ansible 依赖；archive 下的旧草稿不作为实现依据。
- 采用 apps/web、apps/control-api、apps/deploy-worker、apps/agent、packages/contracts、packages/automation 的模块边界。尚未创建的目录不代表已有实现。
- 变更接口、状态机、配置或重试规则，先更新带版本的契约和正反例。TypeScript 类型不能替代运行时校验。
- 所有部署、启动与停止操作遵循数据库锁、幂等及节点回执。已提交注册不得自动重试，未知结果不得误报失败或成功。
- 不假定新模拟器名称或清空数据等于新的真实手机身份；App UA、设备标识和代理出口必须按实际证据表达。
- 不把 URL、XPath、标签或凭据拼成 Shell。使用固定 Playbook 和参数数组，不开放任意远程代码入口。
- 秘密、APK、真实测试账户和执行证据不入 Git。日志与异常必须脱敏，Appium/ADB 不公开监听。
- 保留已有工作。发布、真实部署、实际注册分别标记验证范围；没有实际执行不能声称通过。
- 针对本次行为运行有意义的检查。契约修改运行 npm run check:contracts；业务实现阶段增加 lint、typecheck、test、build。
- 不自行建立子代理或并行代理工作。本文件不要求委派任务。
