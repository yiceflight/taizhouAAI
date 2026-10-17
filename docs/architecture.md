# 项目结构与运行边界

这份文档是项目结构的当前入口。按历史日期记录的验收和发布文档保留证据，但新的代码、配置和排障说明应先更新这里及对应专题文档。

## 一条主链

```text
Chrome 扩展
    │ 仅通过受限 localhost HTTP
    ▼
Tauri bridge ──► readiness ──► monitoring / weather / flight / reports
    │                                  │
    └──────────── runtime_log ◄────────┘
                    │
                    ├─ runtime-logs.sqlite3（本机诊断）
                    └─ 业务 SQLite（监测、设置、巡查和报告索引）
```

桥接回执只表示浏览器任务返回。业务成功必须由对应模块的持久化结果或平台回执证明；`app.pulse`、窗口状态和端口连通性只能作为观察证据。

## 模块职责

| 模块 | 只负责 |
| --- | --- |
| `bridge.rs` | localhost 监听、会话租约、任务投递和回执 |
| `readiness.rs` | 插件及三个业务网站的就绪判断 |
| `monitoring.rs` | K⁺ 小时数据读取、校验、落库和定时调度 |
| `weather.rs` | 读取司空天气并保存适飞判定 |
| `flight.rs` | 超标任务去重、准备、提交门控和状态同步 |
| `flight_report.rs` | 巡飞资料采集、校验、DOCX 生成和版本归档 |
| `reports.rs` | 三个网站的只读网页快照报告 |
| `runtime_log.rs` | 结构化运行证据、筛选和 JSONL 导出 |
| `environment.rs` | 正式/测试身份和更新边界 |
| `extension/*` | 页面适配和浏览器侧任务执行 |

业务模块不能通过运行日志改变业务状态；日志写入失败也不能把业务结果改判为失败。

## 正式版与测试版

所有环境差异从以下入口决定：

- 正式版：`src-tauri/tauri.conf.json`、`bridge-config.json`、`pnpm tauri build`。
- 开发和显式测试版：`src-tauri/tauri.test.conf.json`、`test-environment` feature、`pnpm dev:client` 或 `pnpm build:test-client`。
- 插件源码只有 `extension/`；`extension-dev/` 是构建生成物。

正式版使用 `com.taizhou.aai` / `14520`，测试版使用 `com.taizhou.aai.dev` / `14521`。测试版不注册 updater，并使用独立应用数据；两个版本的浏览器页面统一使用当前系统 Chrome。远端账号、司空项目和无人机仍可能共享业务状态，不能把本机隔离当成远端沙箱。

## 修改顺序

1. 先确定修改属于桥接、业务模块、界面还是构建环境，避免把跨层逻辑塞进一个文件。
2. 需要新增状态时，先定义持久化结构和状态转换，再接入 UI。
3. 需要新增浏览器任务时，先在 `extension/src/` 固定来源和失败条件，再在 Rust 侧校验回执。
4. 所有可观察行为写入结构化事件；详情只放操作元数据，不放页面正文、截图或凭据。
5. 完成后按影响范围运行 Node、UI、Rust 和构建检查；真实 Chrome、Windows、远端平台和飞行仍需单独验收。

## 当前入口

- 开发客户端：`pnpm dev:client`
- 正式前端构建：`pnpm build`
- 显式测试包：`pnpm build:test-client`
- Node/扩展测试：`pnpm test`
- React UI 测试：`pnpm test:ui`
- Rust 单元测试：`cargo test --manifest-path src-tauri/Cargo.toml --lib --quiet`

详细操作分别见 [`docs/environment-isolation.md`](environment-isolation.md)、[`docs/runtime-logs.md`](runtime-logs.md)、[`docs/workspace-flow.md`](workspace-flow.md) 和 [`docs/code-review.md`](code-review.md)。
