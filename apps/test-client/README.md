# 自有测试 APK

此客户端仅由中台任务启动。安装后，Agent 通过 `run-as` 向 APP 私有文件注入短期测试凭据；手动启动未配置的安装只显示提示，不创建账户。固定包名为 `com.apkplatform.testclient`。为允许私有文件注入，APK 使用 `debuggable=true`，仅用于本项目测试环境。

APP 读取自身 Android ID、实际 Build 型号和 WebView UA，使用本轮测试 UA 发送账户创建请求。中台从该请求获取来源 IP，并生成用户名与随机密码。网络重试复用持久化的安装编号和请求编号。该客户端不额外查 IP，不包含管理员或节点长期密钥。

Linux 构建需要 Node.js 24、JDK 21、Android build tools 和平台 `android.jar`。运行 `node apps/test-client/build.mjs /private/test-client-output /private/android-build-cache`。缓存目录包含从官方 SDK 解压的 `buildTools/<目录>/` 与 `platform/<目录>/android.jar`。构建器不下载依赖。输出目录包含签名密钥和密码，必须保密；发布时只复制 `<sha256>.apk` 与 `current.json` 到中台只读 APK 目录，不能发布整个输出目录。

接口、设备档案和验证范围见 [1.14 契约](../../docs/V114_TEST_DATA_CONTRACT.md)。源码可以开源，APK、签名私钥、系统镜像、真实测试数据和执行回执不入 Git。
