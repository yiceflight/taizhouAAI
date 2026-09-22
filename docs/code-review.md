# 代码审查与修复（2026-09-21）

## 已发现并修复

| 原问题 | 修复 |
| --- | --- |
| Chrome 插件固定显示「待检测」 | 本机桥接、真实心跳、75 秒过期、连接失败提示 |
| 数据源固定显示「待检测」 | 根据插件上报的实际标签页展示未连接、未打开、加载中、已打开页数 |
| 生成报告永久 disabled、报告数固定为 0 | 页面选择、CDP 采集、原始 JSON 原子保存、报告读取与 HTML 查看 |
| CDP 结果多取了一层 result，成功也读不到值 | 按 Runtime.evaluate 实际返回结构读取，正确处理 exceptionDetails |
| page.ready 消息无处理，任意 CDP 消息入口缺少范围限制 | 接入就绪刷新；只允许固定 capture 操作，采集前后检查业务 URL |
| 业务快捷入口可能打开没有插件的默认浏览器 | 桌面端明确通过 Chrome 打开，启动失败返回错误 |
| Mac 打开扩展管理只检查进程创建，没检查 open 的退出码 | 检查系统启动命令退出状态 |
| 报告文本可能携带 HTML/脚本 | HTML 转义、无脚本 CSP；报告 ID 必须为 UUID |
| 更新失败只有笼统提示 | 显示网络、403、404 等实际原因，保留签名验证与用户触发安装流程 |
| 一个 Mac 包被同时登记 ARM 和 Intel | 检查 tar 中真实 Mach-O 架构、应用 ID 和版本，按实际架构发布 |
| 发布可能回退、重复覆盖、重复平台 | 先检查现有版本；拒绝相同/更旧版本及重复平台；提供离线 dry-run |

## 真实边界

- 当前没有专业监测报告模板、指标公式和业务 API 契约。已实现的是明确标识的网页采集报告，不能据此声称完成专业分析或全量网站数据集成。
- OSS 只读检查确认 `client/latest.json` 尚不存在；匿名请求返回 403。未发布新版本、未改变云端权限。没有清单时不声称已经是最新版。
- Windows 安装包以 Tauri 的版本和架构文件名识别目标，不能替代真实 Windows 安装验收；Mac 架构从包内可执行文件读取。
- 本机桥接的 origin 检查隔离网页与其他普通扩展，不把已被控制的本机进程当作可信安全边界。

## 验证入口

- `pnpm test`：URL 范围、CDP 返回与异常、固定扩展 ID、Mac 架构、版本比较。
- `cargo test --manifest-path src-tauri/Cargo.toml`：来源/Host 边界、过期状态、任务会话与结果匹配、报告落盘及 HTML 安全。
- `pnpm build` 与本机 Tauri debug app 构建。
- 真实 Chrome 插件与 Mac 客户端：连接、网站页数、真实综合地图采集、报告查看与重启恢复；验收结果以任务交付说明为准。

补充审查修复：发布前验证 minisign 文件与受信任注释签名；中文安装包名使用合规 Content-Disposition 编码；发布锁防止并行写入清单；更新诊断显式初始化 TLS provider，避免请求异常后一直显示检查中。

Chrome 后台恢复遵循 [service worker 生命周期](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)；插件身份遵循 [manifest key 说明](https://developer.chrome.com/docs/extensions/reference/manifest/key)。

## 本轮最终验收

- JavaScript 9 项、Rust 5 项检查通过，前端和 Mac debug app 构建成功。
- 已在用户现有 Chrome 中重新加载 v0.2.0 插件，客户端真实显示已连接；检测到 4 个业务标签页。
- 临时停用插件后，客户端和三个数据源均切换为未连接；恢复启用后重新连接。
- 已分别从综合地图、DJI FlightHub、历史云台生成真实网页采集报告，共 3 份；综合地图 HTML 已实际打开核对正文。
- 客户端重启后报告恢复；更新检查真实显示服务器 403，不再停留在检查中。
- 实际 Mac app 打成临时 tar.gz 后，校验识别为 darwin-aarch64；错误版本被拒绝，临时文件已清理。
- 没有进行 Windows 实机验收、专业监测结论验收或线上安装升级发布，不能把上述本机结果当作这些环节的验收。

## 0.2.0 正式发布补充（2026-09-22）

GitHub Actions 运行 `35694179017` 已通过校验、macOS universal 构建、Windows x64 NSIS 构建和 OSS 发布。`client/latest.json` 已匿名返回 `0.2.0`，平台为 `darwin-aarch64`、`darwin-x86_64` 和 `windows-x86_64`；GitHub Release 为 `v0.2.0`。Windows/macOS 安装包均完成 Tauri updater 签名校验；macOS 代码签名与 notarization 仍未配置。

最终重载检查追加：Chrome 重新加载插件会清空 storage.session，改用 storage.local 保存浏览器实例 ID，避免重载后的短暂重复页数。

重载复验通过：连续重新加载新版插件后仍为 1 个浏览器实例、4 个业务页面（2/1/1），最终客户端保持已连接与 3 份真实报告。打包插件文件已与最终源码做 SHA-256 一致性核对。
