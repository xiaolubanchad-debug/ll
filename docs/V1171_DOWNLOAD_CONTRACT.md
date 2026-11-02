# 1.17.1 下载判定与校验诊断

版本 1.17.1，Agent 0.14.1。只调整通用错误判定、二进制清单兼容与受限诊断，保留安卓手机环境、既有入口范围、内容隔离、代理、每日缓存、停止和文件完整性保护。验证仅使用自有页面和合成测试包，不访问或适配成人内容入口，不重新开启已有业务任务。

触屏操作区分准备、命令成功返回及收到下载事件。准备日志在触屏前发出，命令成功后才记录“已操作”。操作异常且没有下载证据时结束为 DOWNLOAD_SOURCE_UNCONFIRMED 或 DOWNLOAD_CONTROL_UNCONFIRMED；不吞掉异常、不猜测点击生效、不再次点击未知结果。等待结束仍无下载事件时为 DOWNLOAD_NO_FILE。停止或租约撤销优先于下一次操作，仍保留每页和总点击预算。

收到浏览器下载事件不等于文件保存完成。保存完成后发送固定消息，传输超时和其他传输错误分别为 DOWNLOAD_TRANSFER_TIMEOUT / DOWNLOAD_TRANSFER_FAILED；超限仍为 APK_TOO_LARGE，取消仍按既有停止规则。不得记录 URL、HTML、文件名、文件正文、代理信息或原始异常。

inspectApk 保留 APK_INVALID 作为调用层主错误码；受限子原因映射到任务错误码 APK_INVALID_TOO_SMALL、APK_INVALID_NOT_ZIP、APK_INVALID_ZIP_STRUCTURE、APK_INVALID_ZIP_POLICY、APK_INVALID_CRC、APK_INVALID_MANIFEST_MISSING、APK_INVALID_MANIFEST_FORMAT、APK_INVALID_MANIFEST_METADATA。文件魔数只用于失败分类，不作为新的兼容拒绝条件。未知文件读取错误不误报为已确认的包损坏。旧错误码继续读取，旧记录不回填推测原因，无数据库迁移。

Android 二进制清单属性优先按 typedValue 读取。整数类型即使附带 rawValue，也读取整数 data，避免将 minSdkVersion 错判为字符串；不把未知预览系统名强转成 SDK 整数。ZIP、路径、重复条目、CRC、清单边界、包名、大小及安装前 SHA-256 校验均保留，不通过校验的文件不进入有效缓存。

依据为 [AOSP ResXMLTree_attribute](https://android.googlesource.com/platform/frameworks/base/+/7d4200d/include/utils/ResourceTypes.h) 的原始文本与类型化字段，以及 [PackageParser](https://android.googlesource.com/platform/frameworks/base/+/master/core/java/android/content/pm/PackageParser.java) 对 minSdkVersion 的类型化读取。自有合成清单复现此兼容缺陷，不据此断言历史第三方失败包均为同一原因。

正例：带原始文本的整数 SDK/版本号正确解析；普通下载、自动下载、落地页下载仍工作；文件保存后才报告校验阶段；被遮挡按钮报告操作未确认且不补点；准备日志中收到停止后不触屏。反例：把超时当 APK 损坏、记录失败却写点击已成功、放宽 CRC、把无效文件放进缓存、扩大入口搜索范围、重新提交未知操作，均不允许。

验证覆盖合成清单前后对照、ZIP 与 CRC 反例、真实 Chromium 触屏失败/超时/传输取消、停止后零后续动作、PostgreSQL 事件校验及中文结果显示。签名发布、中台/EC2 部署、自有验证和真实产品行为分别标记范围。
