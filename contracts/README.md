# 契约结构与检查

config.schema.json 定义不可变测试配置，不包含代理明文。agent.schema.json 定义节点注册、心跳、领取、分配、接收确认、账户专用上传及事件消息。HTTP_API.md 定义接口、鉴权和业务含义；仅有 Schema 校验不代表数据库状态转换或节点权限正确。

样例中的 UUID、example.test 地址、包名、控件及 sampleuser 账户均为虚构值，没有实际登录用途。账户样例只用于专用上传结构校验，禁止将真实账户写回样例。注册流程默认禁用；不能直接用于真实测试。样例 UA 为空，表示使用已安装浏览器默认 UA，不表示修改了 App 原生请求。

Node.js 24 环境执行：

```sh
npm ci
npm run check:contracts
```

检查覆盖 JSON Schema 编译、正例通过、非法代理引用、明文秘密混入、重复提交、可选提交、任意代码字段、节点协议版本及事件类型等反例，也检查文档相对链接。

跨字段检查位于 packages/contracts，前端和 API 共用。auth.schema.json、p1.schema.json 定义管理端输入；p0.http.json 与 p1.http.json 列出已实现路由，生成类型、静态校验器和 OpenAPI 后由 CI 检查漂移。p1.valid.json 使用虚构凭据，覆盖服务器、秘密类型、主机指纹、SDK 许可和健康报告正反例。P1 已实现 SSH 检查、部署租约、Agent 注册及心跳；安装验证边界见 [P1 说明](../docs/P1_SETUP.md)。执行任务租约和 APK 注册留待 P2/P3。

Schema 能验证字段格式，不能证明主机可访问、XPath 可命中、定位器正确、设备标识变化、IP 固定或注册成功。网络和业务验证必须由执行层另行完成。
