# 1.21 通用 XPath 元素检查

版本 1.21.0，Agent 0.17.0。用户最新要求优先：人工填写需要检查的元素，不进行自动历史基线推断。支持属性（如 pid/name/自定义属性）、标签（如 i）和完整 XPath。只增加检查记录和中台提醒，不自动改写配置、扩大点击范围或重新下载。

## 人工检查配置与每日记录

source.elementChecks 为可选人工列表，每项 id、label、kind。ATTRIBUTE 填 attribute/value；TAG 填 tag；XPATH 填 xpath。保存为不可变配置版本。组装 XPath 使用严格名称校验和 XPath 字面量转义，不拼接 Shell。没有检查项时不额外检查。规则只检查元素是否存在，不点击。最高 1000 项，沿用配置正文大小限制。

每日下载访问来源页后执行人工列表，保存 FOUND / NOT_FOUND / READ_FAILED、实际匹配数量和执行时间。对初次未匹配共享最多 3 秒等待，禁止每项叠加无上限等待。网页打不开或规则无法执行记录 READ_FAILED，不能冒充元素消失。检查结果归属本次下载日期和冻结配置，修改规则后历史结果仍可查看。

正常点击另外保留通用定位失败记录，未找到、不可见、多候选不明确或目标变化均记录原 XPath、目标描述和时间，不限 pid。首次执行下载 XPath 完全无匹配同样记录。人工检查失败只提醒，其他正常入口继续原流程；不把 APP 安装或文件传输失败记为 XPath 失效。

## 协议与展示

新增 ELEMENT_OBSERVATION：CHECK 携带 ruleId、有限 status 和 matchedCount；ISSUE 携带 DISCOVERY/CLICK 范围、有限原因和可选元素描述。不接收任意消息、原始 HTML、额外秘密字段或客户端任意 XPath。ruleId 必须存在于本批次配置，同项只记录一次；点击问题必须属于当前下载入口及 DOWNLOADING 阶段。下载及历史完整流程的网页阶段可记录；REGISTER/PROXY_CHECK 和 APP 内阶段不得冒用来源检查。沿用 sequence、fence、租约及幂等，迟到证据不计有效提醒。

有人工检查配置的任务要求 Agent 0.17.0 / XPATH_OBSERVATION_V1；旧节点提示升级。RunSummaryView.sourceElements 列出人工项目、实际 XPath、结果和时间、通用点击问题；TaskPlanView.sourceWarning 在服务器行提醒并跳转下载详情。TimelinePage 允许可选 locator，日志可展开完整 XPath。日期和规则由不可变配置提供，提醒仅在中台内显示，不发送外部消息。

## 正反例

正例：人工填写 pid=1230、标签 i、name=download，分别生成 //*[@pid='1230']、//i、//*[@name='download']，每天记录各自结果；复杂条件直接填完整 XPath。点击前控件被删除保存 NOT_FOUND，存在但隐藏保存 NOT_VISIBLE。反例：只检查 pid、网站读取失败却报元素消失、自动推断需检查项、提醒后擅自扩充点击范围，均不允许。

此前按用户要求未执行测试；现按最新要求“测试了再发布”，补齐人工检查、事件回传和页面操作回归后，经正常发布门禁上线。构件签名和部署启动确认保留；不运行真实外部网站任务，不改 SDK/镜像/型号池。
