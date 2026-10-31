# 1.15 机型参数档案

30 个型号代码核对自 [Google Play 官方设备清单](https://storage.googleapis.com/play_public/supported_devices.csv)。这些是 QA 镜像的机型参数；不提供厂商 ROM、真实 ARM 芯片、硬件认证或厂商服务。API 列表示实际选择运行的 SDK 系统版本。显示密度统一采用 420 的测试设置，不声称是真机出厂逻辑密度。只有对应节点实际启动核对通过的档案才可用。

| 档案     | 名称               | 系统型号代码 | 厂商    | Android / API | 测试屏幕    |
| -------- | ------------------ | ------------ | ------- | ------------- | ----------- |
| phone-01 | Xiaomi 11T         | 21081111RG   | Xiaomi  | 12 / 31       | 1080 × 2400 |
| phone-02 | Xiaomi 11T Pro     | 2107113SG    | Xiaomi  | 12 / 31       | 1080 × 2400 |
| phone-03 | Xiaomi 12          | 2201123G     | Xiaomi  | 12 / 31       | 1080 × 2400 |
| phone-04 | Xiaomi 12 Pro      | 2201122G     | Xiaomi  | 12 / 31       | 1440 × 3200 |
| phone-05 | Xiaomi 12 Lite     | 2203129G     | Xiaomi  | 12 / 31       | 1080 × 2400 |
| phone-06 | Xiaomi 12T         | 22071212AG   | Xiaomi  | 12 / 31       | 1220 × 2712 |
| phone-07 | Xiaomi 12T Pro     | 22081212UG   | Xiaomi  | 12 / 31       | 1220 × 2712 |
| phone-08 | Xiaomi 13          | 2211133G     | Xiaomi  | 13 / 33       | 1080 × 2400 |
| phone-09 | Xiaomi 13 Pro      | 2210132G     | Xiaomi  | 13 / 33       | 1440 × 3200 |
| phone-10 | Xiaomi 13T         | 2306EPN60G   | Xiaomi  | 13 / 33       | 1220 × 2712 |
| phone-11 | Xiaomi 13T Pro     | 23078PND5G   | Xiaomi  | 13 / 33       | 1220 × 2712 |
| phone-12 | Xiaomi 14          | 23127PN0CG   | Xiaomi  | 14 / 34       | 1200 × 2670 |
| phone-13 | Galaxy S22         | SM-S901B     | samsung | 12 / 31       | 1080 × 2340 |
| phone-14 | Galaxy S22+        | SM-S906B     | samsung | 12 / 31       | 1080 × 2340 |
| phone-15 | Galaxy S22 Ultra   | SM-S908B     | samsung | 12 / 31       | 1440 × 3088 |
| phone-16 | Galaxy S23         | SM-S911B     | samsung | 13 / 33       | 1080 × 2340 |
| phone-17 | Galaxy S23+        | SM-S916B     | samsung | 13 / 33       | 1080 × 2340 |
| phone-18 | Galaxy S23 Ultra   | SM-S918B     | samsung | 15 / 35       | 1440 × 3088 |
| phone-19 | Galaxy S24         | SM-S921B     | samsung | 16 / 36       | 1080 × 2340 |
| phone-20 | Galaxy S24+        | SM-S926B     | samsung | 16 / 36       | 1440 × 3120 |
| phone-21 | Galaxy S24 Ultra   | SM-S928B     | samsung | 14 / 34       | 1440 × 3120 |
| phone-22 | Galaxy A34 5G      | SM-A346B     | samsung | 13 / 33       | 1080 × 2340 |
| phone-23 | Galaxy A53 5G      | SM-A536B     | samsung | 12 / 31       | 1080 × 2400 |
| phone-24 | Galaxy A54 5G      | SM-A546B     | samsung | 13 / 33       | 1080 × 2340 |
| phone-25 | HUAWEI P30         | ELE-L29      | HUAWEI  | 10 / 29       | 1080 × 2340 |
| phone-26 | P30 Pro            | VOG-L29      | HUAWEI  | 10 / 29       | 1080 × 2340 |
| phone-27 | HUAWEI Mate 20     | HMA-L29      | HUAWEI  | 10 / 29       | 1080 × 2244 |
| phone-28 | HUAWEI Mate 20 Pro | LYA-L29      | HUAWEI  | 10 / 29       | 1440 × 3120 |
| phone-29 | HONOR 20           | YAL-L21      | HUAWEI  | 10 / 29       | 1080 × 2340 |
| phone-30 | P20 Pro            | CLT-L29      | HUAWEI  | 10 / 29       | 1080 × 2240 |

系统版本依据包括 [小米 13 官方资料](https://www.mi.com/global/support/faq/details/KA-12718/)、[小米 14 官方资料](https://www.mi.com/in/product/xiaomi-14/specs/)、[三星系统版本与机型表](https://docs.samsungknox.com/admin/knox-platform-for-enterprise/kbas/cc-guidance-documents/) 和官方更新记录。旧华为档案使用 Android 10 QA 环境，不作为 HarmonyOS 验证。版本匹配还会检查 APK 的 minSdkVersion 和真实 x86_64 ABI；未知元数据拒绝进入多 APP 计划。
