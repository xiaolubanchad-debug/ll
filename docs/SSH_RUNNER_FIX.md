# 部署工具 SSH 身份选择修复

版本 1.3.1，日期 2026 年 10 月 28 日。修复 P1/P2 部署工具的密钥选择，不改变节点协议、数据库结构、安装 Playbook 或重试规则。

## 行为契约

私钥环境检查由 SSH2 直接加载密钥；实际安装通过 Ansible Runner、ssh-agent 和 OpenSSH 连接。启用 IdentitiesOnly=yes 时，必须通过固定作业目录中的 IdentityFile 显式选择本次私钥。只把私钥交给 ssh-agent 并不足以保证 OpenSSH 使用它。

每次安装或激活创建独立 0700 作业目录。Runner 的 env/ssh_key 只负责向本次 ssh-agent 加载密钥；另外写入 0600 的选定身份文件和对应公钥文件，通过 ansible_ssh_private_key_file 传入其路径。带口令私钥保留加密内容，口令写入本次 0600 文件，由镜像中固定的 OpenSSH ASKPASS 程序读取；不依赖交互终端或密码提示文本匹配。辅助程序检查文件属主、权限、类型和大小，拒绝符号链接，失败不输出秘密或错误细节。固定主机指纹与 IdentitiesOnly=yes 保留，不继承操作者的其他代理身份。作业结束或失败后删除本次所有临时文件。

Runner 删除其 ssh_key 输入后，选定身份文件仍须存在，直到 OpenSSH 连接完成。不得把已被删除的 env/ssh_key 用作 IdentityFile。密码登录不创建虚假的私钥文件。

每次作业建立独立 SSH 连接，关闭 OpenSSH 跨作业的 ControlMaster/ControlPersist 复用，确保新的凭据或主机指纹核验实际生效。错误密钥与错误主机指纹的测试应紧跟成功连接，验证连接缓存不能使其误报成功。

runner_on_unreachable 也必须按固定白名单错误码归类：认证拒绝为 SSH_AUTH_FAILED、主机公钥校验失败为 HOST_KEY_MISMATCH、其他连接失败为 SSH_UNREACHABLE。页面与事件只返回固定错误码，不转发原始 Ansible 输出、远端消息或凭据。未知安装结果仍依现有安装标记与节点核验隔离，不自动重放部署。

## 验收

以真实 Ansible Runner、OpenSSH 客户端和隔离 SSH 测试服务验证普通私钥、带口令私钥、错误密钥与错误主机指纹；固定测试 Playbook 只输出虚构标记，不安装软件。另在已登记 EC2 上进行只读 Python 连接验证。实际重试安装必须另建受数据库锁和节点槽约束的部署操作，保留原失败记录。

本修复未修改 Playbook 与 Agent，现有 Agent 0.3.1 签名发布仍可使用；只更新中台 Worker 无需重签或覆盖已有发布。
