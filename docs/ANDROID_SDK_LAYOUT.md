# Android SDK 固定档案安装契约

版本 1.3.3，日期 2026 年 10 月 28 日。补充 P1 固定 Playbook，不改变 HTTP 结构、节点协议、配置结构、数据库和未知结果恢复规则。

## 行为

经过签名清单摘要校验的 command-line tools 19.0 档案，必须实际位于 SDK/cmdline-tools/19.0/bin 和 lib。current 只作为指向该版本目录的链接。不能使 current 指向 SDK/cmdline-tools/archive/cmdline-tools：AVD 管理器会对实际路径规范化，再推断 SDK 根目录；ANDROID_HOME 不能修正该错误布局。

离线解压的 emulator 和 command-line tools 必须有对应的本地 package.xml。由固定模板和签名清单中的数字版本生成泛型本地包描述；路径分别固定为 emulator、cmdline-tools;19.0。版本必须为 major.minor.micro 三段数字，不能把未校验字符串拼入 XML。模板只描述已校验并解压的档案，不下载新版本，也不替代管理员 SDK 许可确认及原有许可步骤。

正例：规范化后仍在 SDK/cmdline-tools/19.0 的工具、存在匹配 emulator 描述、已安装系统镜像，AVD 创建成功。反例：多一层目录时找不到镜像；规范目录但缺少 emulator 包描述时必须报缺少包；版本不是三段数字时禁止生成描述。不能把仅创建 AVD 当作 Android 启动通过。

布局和元数据改变 Playbook 摘要，使用新签名 Agent 0.3.3，保留旧发布和失败记录。已有同工具链安装通过带 creates 的目录迁移升级，不重复移动已迁移目录；后续 current 指向新的规范位置。

## 验证范围

普通账户、真实 Google command-line tools 19.0 与虚构镜像文件测试目录推断、包识别及 AVD 创建。测试不启动该虚构镜像。EC2 上的真实系统镜像启动、sys.boot_completed=1、Agent 注册与心跳另行验收。

参考：[官方 SDK 目录布局](https://developer.android.com/tools/sdkmanager)、[AVD 管理器实际路径推断](https://android.googlesource.com/platform/tools/base/+/studio-master-dev/sdklib/src/main/java/com/android/sdklib/tool/AvdManagerCli.java)。
