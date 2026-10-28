# P1 部署、接入和验收

版本 1.1.0。服务器管理页面、部署 API、Worker、固定 Ansible Playbook 和 Agent 已实现。本地验收使用真实 PostgreSQL 17.6、SSH 服务与 Chromium；Ubuntu/KVM 状态和安装器使用测试替身。尚未接入真实 EC2，因此不能把本次测试当作云端安装或 APK 注册已通过。

## 中台准备

先按 [P0 启动说明](P0_SETUP.md) 安装依赖、迁移数据库、建立管理员并启动管理页面。已有 P0 数据库直接运行 `npm run db:migrate`，新增迁移保留原账户及会话，并为原有节点补建占用槽。先备份数据库和密钥。

真实部署 Worker 运行在 Ubuntu 24.04 x86_64，与 API 使用同一代码提交、同一受保护发布目录和主密钥。Windows 可开发及运行本地测试，不能运行生产安装器。Worker 本身不需要 KVM；目标 EC2 接受 Ubuntu 24.04 / 26.04 LTS x86_64，详见 [兼容契约](UBUNTU_COMPATIBILITY.md)。目标必须有可供 apk-runner 使用的 `/dev/kvm`、至少 20 GiB 剩余空间及 sudo 权限。

在 Linux 中台安装 Python 3.12、venv、OpenSSH 客户端和 sshpass，然后安装固定 Ansible 依赖：

```sh
sudo apt-get update
sudo apt-get install -y python3-venv openssh-client sshpass acl
python3 -m venv .venv-deploy
.venv-deploy/bin/pip install -r deploy/requirements.txt
npm ci
npm run db:generate
npm run db:migrate
npm run build
npm run setup:deployment
```

setup:deployment 创建 32 字节加密主密钥、Ed25519 发布密钥对，并保留已有密钥。它将路径补入 `.env`，另生成只含 Worker 必需配置的 `data/keys/worker.env`，不复制管理员数据库连接、会话密钥或签名私钥路径。重复运行会刷新 Worker 配置快照；不会轮换密钥。密钥目录只允许服务账号读取，Linux 文件权限为 0600。

在 `.env` 填写 `CONTROL_PLANE_URL=https://你的中台域名`，该域名需要 EC2 可访问、有效 TLS，并转发 `/api/v1/agent/`。然后再次运行 `npm run setup:deployment` 同步 Worker 配置，并重启 API。HTTP 仅允许本机开发地址。Agent 主动连接中台，不开放外部 Agent、Appium 或 ADB 服务端口；安全组只需允许 Worker 来源的 SSH。

由有创建数据库角色权限的运维账号执行一次：

```sh
npm run db:worker
```

该命令创建独立 `apk_worker` 数据库角色，将随机密码保存在 `data/keys/worker-url.env`。仅授予部署所需表和列的权限，不能读取管理员会话或编辑服务器地址。已有角色或连接文件时拒绝覆盖；不要把数据库创建者凭据作为 Worker 连接。备份时必须同时保存数据库、加密主密钥、可信发布公钥和发布构件；签名私钥单独保管。

将 `.venv-deploy/bin` 放入服务的 PATH，运行 `npm run worker`。生产使用进程管理器维持 Worker；可参考 [systemd 示例](../deploy/systemd/apk-deploy-worker.service)。示例的服务用户和绝对路径需按安装位置调整。API 和 Worker 均使用非 root 服务账号，只有远程固定安装步骤通过 sudo 执行。

## 生成固定发布

在源码干净且已提交的中台仓库运行：

```sh
npm run release:agent
```

命令读取官方 Node/Android 元数据，固定各档案 URL、revision 和校验值，生成冻结 npm lock、打包 Agent 与空模拟器启动检查器，以 Ed25519 签名。输出在忽略 Git 的 `data/releases` 中。首次需要网络访问 npm、nodejs.org 和 dl.google.com；Google 元数据暂不可用时命令失败，不退回未经校验的地址。

发布固定 Node 24.18.0、Playwright 1.64.1（新发布；旧 P1 清单保持 1.56.1）、Appium 3.9.0、UiAutomator2 driver 8.7.2、Android API 35/google_apis/x86_64，Android 档案版本以本次签名清单为准。后续部署不重新解析 latest。Agent 构件和 npm lock 使用 SHA256；部分 Google 元数据仅提供 SHA1，按其官方值校验并在签名清单中固定。

首次安装选择 Agent 0.3.4 的新签名发布，包含普通账户驱动注册的独立 npm 前缀及 SDK 规范布局和包描述，见 [驱动安装契约](APPIUM_INSTALL_FIX.md) 和 [SDK 安装契约](ANDROID_SDK_LAYOUT.md)。旧发布保留历史，不覆盖其 Playbook 摘要。

在服务器页面展开“登记签名发布版本”，粘贴输出的 manifest JSON。API 校验签名、本地构件摘要、归档文件白名单及 npm lock 摘要后登记。发布包必须已放在 API 和 Worker 共用的 RELEASE_DIR，页面不能上传任意脚本或远程下载地址。Playbook 内容变化后必须生成新发布，旧清单不能用于新脚本。

## 页面操作

1. 添加服务器：填写名称、IP/域名、端口、SSH 用户和私钥或密码；需要时填写 sudo 密码。私钥可带口令，保存后凭据不回显，编辑留空可沿用原凭据。
2. 点击“探测主机指纹”。探测在认证前结束，不发送登录凭据。从 EC2 控制台或其他可信渠道核对主机 SHA256 指纹，再输入并确认；系统不会自动信任探测值。
3. 点击“SSH 连接与环境检查”，查看系统、磁盘、KVM 和 sudo 结果。有 sudo 密码的节点可能在免密 sudo 检查中显示需要权限，部署时会实际验证所填密码。此检查只读，不代表模拟器已经启动成功。
4. 选择已登记版本，阅读并确认 Android SDK 许可，再点击“一键部署”。同一服务器只能有一个检查、部署或执行任务占用。界面显示排队、连接、检查、安装、配置、启动、核验及终态，可补读步骤记录。
5. 只有安装成功、空模拟器实际启动、Agent 注册及匹配版本心跳就绪后，才显示部署成功。在线、安卓能力和任务占用分别展示。Agent 每 15 秒心跳，45 秒未收到显示离线。

相同版本且当前健康的节点重复部署，会等一条本次操作之后的新心跳后复用身份。升级或重装先停旧服务，再创建新的单次注册令牌；部署数据目录保留。修改地址、端口或 SSH 用户会清除主机信任并撤销旧身份。

## 失败、停止和核验

SSH 认证失败、主机指纹变化、系统或架构不符、无 KVM、磁盘不足、sudo 失败各自显示错误。生产部署仍需在真实 EC2 验证该实例类型提供 KVM，以及 Android、软件渲染和下载网络的兼容性。

停止运行中的部署会先记录请求，再由 Worker 终止本次控制进程。停止不等于卸载或完整回滚。Worker 失联、租约过期或远程安装标记未清除时进入 NEEDS_REVIEW，节点保持隔离，不会自动重放安装。

恢复时先由运维确认旧 Ansible/包管理/安装进程已经结束，再核对 `/var/lib/apk-platform/install.lock` 和 `install.lock.d` 的所属操作；仅在确认结束后清除遗留标记。不要删除正在运行操作的标记。回到页面发起新的只读检查，确认返回无安装标记，再点击“依据新检查解除隔离”。心跳或重启 Worker 不能代替该核验。

归档服务器前，在远端停止 `apk-agent`，等待离线后归档；历史操作保留，身份被吊销，不删除 EC2 或远程业务目录。

## 测试范围

```sh
npm run lint
npm run typecheck
npm run check:contracts
npm audit --omit=dev --audit-level=high
npm test
ansible-playbook -i 'target,' --syntax-check deploy/ansible/install.yml deploy/ansible/activate.yml
node scripts/check-ansible.mjs .venv-deploy/bin/ansible-playbook
```

验收包含 P0 回归、首次及重复迁移、真实 SSH 密码与私钥认证、无凭据指纹探测、固定脚本执行、故障错误码、加密凭据及不回显、发布校验、幂等与双 Worker 竞争、注册响应丢失重试、身份吊销、过期隔离和核验、受限 PostgreSQL 角色，以及服务器页面新增/停止/归档操作。CI 在 Linux 检查 Playbook 语法，并用真实 Ansible 本地连接验证含模板符号的凭据保持原文。

测试安装器明确使用替身，不下载或启动真实 Android、不登录 EC2、不安装实际 APK。真实 EC2 的首次安装、升级、网络断开及安卓启动，仍需在提供测试实例后单独验收。P1 Agent 只注册和心跳，不领取或执行 APK 测试任务。
