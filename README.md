# APK 自动化测试部署中台

超级管理员在中台添加 EC2 服务器，通过 SSH 部署执行程序，统一配置网站、XPath、HTTP 代理和注册步骤。EC2 主动领取任务，执行 APK 下载、安卓安装和注册测试，再回传结果。

采用 Node.js + TypeScript 统一实现中台和执行端。中台可部署在现有 Hostinger Ubuntu 服务器；Android 模拟器运行在通过 KVM 检查的 EC2 节点。

## 当前状态

已实现 P0 工程及登录基础、P1 服务器管理与部署：加密 SSH 凭据、主机指纹核验、环境检查、签名发布、独立部署 Worker、固定 Ansible 安装脚本，以及 Agent 注册和心跳。P1 已通过本地真实 PostgreSQL、SSH 和浏览器测试；远程安装环境使用模拟验收，尚未在真实 EC2 上验证 Android 启动。APK 下载、安装及注册业务属于 P2/P3。

原 Python 单机方案被本方案替代。早期本地草稿不作为实现依据，也不纳入发布。

## 文档入口

| 文档                                              | 内容                                         |
| ------------------------------------------------- | -------------------------------------------- |
| [实施方案](docs/PLAN.md)                          | 产品范围、技术栈、模块职责和部署结构         |
| [开发契约](docs/DEVELOPMENT_CONTRACT.md)          | 状态机、任务协议、幂等、停止和恢复规则       |
| [接口契约](contracts/HTTP_API.md)                 | 管理端和节点 API、权限、错误和事件格式       |
| [配置 Schema](contracts/config.schema.json)       | 不包含明文凭据的配置版本结构                 |
| [节点协议 Schema](contracts/agent.schema.json)    | 节点注册、心跳、领取、接收和结果事件         |
| [部署与凭据规则](docs/DEPLOYMENT_AND_SECURITY.md) | SSH、密钥、发布、网络和运维规则              |
| [开发阶段和验收](docs/ROADMAP.md)                 | 实施顺序、验收场景和交付证据                 |
| [架构决策](docs/DECISIONS.md)                     | 已确定选择及其变更条件                       |
| [P0 启动与验证](docs/P0_SETUP.md)                 | 本地启动、管理员初始化、测试和边界           |
| [P1 部署与验证](docs/P1_SETUP.md)                 | Linux Worker、发布构件、服务器接入及故障恢复 |
| [P1 增量契约](docs/P1_CONTRACT.md)                | 部署占用、身份注册、主机核验和重试规则       |
| [契约样例](contracts/README.md)                   | 正反例与检查方式                             |

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
