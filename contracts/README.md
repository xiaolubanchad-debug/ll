# 契约结构与检查

config.schema.json 定义不可变测试配置，不包含代理明文。agent.schema.json 定义节点注册、心跳、领取、分配、接收确认、账户专用上传及事件消息。HTTP_API.md 定义接口、鉴权和业务含义；仅有 Schema 校验不代表数据库状态转换或节点权限正确。

样例中的 UUID、example.test 地址、包名、控件及 sampleuser 账户均为虚构值，没有实际登录用途。账户样例只用于专用上传结构校验，禁止将真实账户写回样例。注册流程默认禁用；不能直接用于真实测试。样例 UA 为空，表示使用已安装浏览器默认 UA，不表示修改了 App 原生请求。

Node.js 24 环境执行：

```sh
npm ci
npm run check:contracts
```

检查覆盖 JSON Schema 编译、正例通过、非法代理引用、明文秘密混入、重复提交、可选提交、任意代码字段、节点协议版本及事件类型等反例，也检查文档相对链接。

跨字段检查已迁移到 packages/contracts 的公共运行时校验器，前端和 API 共用，原正反例继续执行。auth.schema.json 与 p0.http.json 新增 P0 登录输入及已实现路由契约；生成类型、静态校验器和 OpenAPI 后由 CI 检查漂移。当前没有实现 SSH 部署、节点租约或 APK 注册逻辑，相关场景按 ROADMAP.md 验收。

Schema 能验证字段格式，不能证明主机可访问、XPath 可命中、定位器正确、设备标识变化、IP 固定或注册成功。网络和业务验证必须由执行层另行完成。
