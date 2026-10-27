# P0 启动与验证

P0 提供管理员初始化、登录、退出、改密、会话与审计，服务器及任务的受保护只读列表，以及前后端共享的配置草稿校验。服务器录入和部署属于 P1；配置保存下发及实际测试属于后续阶段。

## 本地启动

需要 Node.js 24、npm 10 或更高版本，以及 PostgreSQL 17。以下命令在仓库根目录执行。

```sh
npm ci
npm run db:generate
npm run setup:env
docker compose --env-file .env -f deploy/compose/postgres.yml up -d --wait
npm run db:migrate
npm run build
npm run admin:init
npm run dev
```

管理员初始化时输入用户名与密码，密码不回显。用户名为 3–64 位字母、数字或 ._-，不区分大小写；管理员密码为 12–128 个字符。这与后续 APK 测试账户的生成规则不同。初始化命令只允许创建一个超级管理员，重复执行不会覆盖密码，没有默认账户。

管理页面地址为 http://127.0.0.1:5173，API 仅监听本机 3000 端口。setup:env 生成随机数据库密码和 CSRF 密钥，已有 .env 不覆盖。若已有 PostgreSQL，跳过 Docker 命令，并在 .env 中设置正确的 DATABASE_URL；不能使用生产数据库进行测试。

非交互部署可以临时注入 ADMIN_USERNAME、ADMIN_PASSWORD 后运行管理员初始化命令。不要把真实值写入 Git、命令行参数或共享日志，使用后删除临时环境变量。

db:migrate 对空数据库执行已提交迁移，重复执行不重复建表。没有使用 db push 或修改生产结构的隐藏启动步骤。Node、Run 表当前只包含列表所需基础字段，后续阶段通过新增迁移扩展，当前没有创建或执行任务的写接口。

## 生产前配置

生产环境要求 NODE_ENV=production、HTTPS APP_ORIGIN、COOKIE_SECURE=true、独立随机 SESSION_CSRF_KEY，以及受保护的数据库连接。生产配置不满足要求时 API 拒绝启动。

P0 的本地 Compose 文件只提供数据库，不是已验证的生产中台部署包。正式 Nginx、TLS 和整套部署配置在后续交付中提供。API 放在反向代理后时只能通过私有网络访问；单层可信反向代理设置 TRUST_PROXY_HOPS=1，不能让客户端直接访问同一个 API 端口来伪造来源 IP。对外代理必须屏蔽 /api/v1/health/ready，该接口只供本机检查。

会话 Cookie 为 HttpOnly、SameSite=Strict，生产环境额外带 Secure。浏览器不把会话或 CSRF Token 写入 localStorage。会话绝对有效期 12 小时，数据库只保存随机会话令牌的 SHA-256；CSRF Token 绑定会话并保存在页面内存中，刷新后从受保护的 me 接口恢复。

所有写接口检查精确 Origin，登录使用同源 JSON；登录后写接口还要求 X-CSRF-Token。改密会撤销旧会话并为当前浏览器签发新会话。用户或密码错误采用统一提示；数据库限流按 IP 和 IP/用户名窗口记数，API 重启不清空。

## 验证命令

```sh
npm run lint
npm run typecheck
npm run check:contracts
npx playwright install chromium --only-shell
npm test
```

npm test 先构建，再启动临时 PostgreSQL 17.6。所有数据库操作在随机、独立的 p0_ Schema 内执行，完成后只清理本次创建的 Schema，并停止测试服务。不会读取 .env 中的生产连接，不访问 EC2，不执行真实 APK 注册。临时数据库文件和截图保留在本地 .tmp，已排除 Git。

如果已有测试 PostgreSQL，可通过 TEST_DATABASE_URL 指定；脚本仍使用新的隔离 Schema。测试账号为虚构身份，密码随机生成。Linux root 环境不适合直接启动临时 PostgreSQL，可使用 Docker 提供测试数据库；GitHub CI 使用 PostgreSQL 服务完成同样测试。

验收覆盖首次及重复迁移、CLI 初始化、单管理员约束、密码摘要、匿名访问限制、秘密不回显、Cookie/CSRF、过期及退出、改密撤销会话、数据库限流在重启后保留、请求大小及格式、接口与 OpenAPI 漂移、浏览器刷新登录、前后端配置校验和移动端布局。测试失败以非零退出，不能因临时数据库退出钩子覆盖失败状态。

## 契约生成

contracts/config.schema.json、agent.schema.json、auth.schema.json 和 p0.http.json 为输入。执行 npm run generate:contracts 更新共享类型、浏览器可用的静态校验器与 contracts/openapi.json；npm run check:contracts 比较输出与输入，发现漂移则失败。

共享类型表达结构，条件字段约束由同一份生成校验器及共享跨字段规则执行。校验器在构建时生成，浏览器无需运行时 eval。P0 OpenAPI 仅列已实现路由，完整后续接口清单仍以 HTTP_API.md 为设计依据。

## 依赖基线

Prisma CLI 与 Client 固定为 6.19.3。对 deepmerge-ts 8.0.0 和 multer 2.5.0 设有明确 override，修补上游间接依赖问题；每次更新必须重新验证 Prisma 生成、迁移和 API。Vue 与 AJV 使用修补版本，依赖结果以 package-lock.json 为准，不使用强制忽略 peer 冲突的安装方式。

本阶段没有测试真实 SSH 部署、APK 兼容性、设备 ID 或产品后台结果；这些不属于 P0 的验收范围。
