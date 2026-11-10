# 报告邮件配置

设置 → 邮件发送：通过标签添加多个报告接收邮箱（回车添加，支持逗号、分号、换行批量粘贴，自动去重），使用窗口底部“保存设置”统一保存；发送窗口显示保存的地址，不接收密码或临时收件地址。收件邮箱默认留空，必须由使用者指定。旧版单邮箱配置自动读取为一个标签。发送时将报告发送给全部已保存收件人；未保存的更改和取消操作不会改变收件人配置。

默认发信地址为 `report@dayialgo.com`。本机私有构建配置 `.secrets/email-defaults.json` 可预置该地址的 SMTP 密码：

```json
{"password":"填写部署专用的 SMTP 密码"}
```

该文件已被 `.gitignore` 排除，不提交真实密码。`build.rs` 将值写入 Cargo 的忽略构建目录，不输出到构建日志。无此文件的构建不会内置密码，使用者需在设置里填写。CI/其他构建机需单独配置此私有文件。源码构建、Windows 构建和发布均需确保私有配置已提供。

**内置密码会随二进制分发，可被提取，不能依赖桌面包隐藏共享 SMTP 凭据。** 此模式用于已授权的当前部署；若面向不受信任用户分发，应改用服务端邮件网关。发信账号轮换后，需更新私有构建配置并重新发布，或在各安装实例的设置中更新密码。

用户保存的地址和密码作为一个条目写入操作系统凭据存储，不写入监测数据库、前端持久化或运行日志。开发版与正式版使用各自应用标识隔离。界面只接收“已配置”状态，不读取保存的明文密码。密码留空保留当前密码，更改发信地址必须同时提供对应密码。

“清空数据”也删除本机邮件配置，使收件邮箱恢复为空、发信账号恢复本版本构建默认值；“恢复默认”仅恢复监测策略，不改变独立保存的邮件设置。

验证：

- `pnpm exec vitest run tests/email-settings.test.tsx tests/settings-flight.test.tsx tests/data-reset-ui.test.tsx tests/patrol-tab.test.tsx`
- `cargo test --manifest-path src-tauri/Cargo.toml email::tests`（默认不发信、不访问真实凭据存储）
- `cargo test --manifest-path src-tauri/Cargo.toml email::tests::native_credential_round_trip -- --ignored`（写入并清除独立测试条目，不发送邮件）
