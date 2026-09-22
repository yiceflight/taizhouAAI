# 在线升级

客户端使用 Tauri updater 校验签名，通过阿里云 OSS 提供静态升级清单和安装包。OSS 桶为 `taizhou-aai-updates`，杭州地域，桶 ACL 保持 private，只有已发布的版本对象和 `client/latest.json` 设置为 public-read。

## 首次配置

真实凭据保存在本地 `.env.oss.local`，Tauri updater 私钥保存在 `.secrets/updater.key`，构建时将文件内容注入环境变量，这两个路径都已加入 `.gitignore`。本项目的发布密钥与其他项目独立，不能替换或丢失，否则旧客户端无法验证新版本。

```bash
pnpm oss:setup
```

`oss:setup` 会检查或创建桶，并验证桶 ACL。它不会打印 AccessKey 或 SecretKey。

## 发布

使用 Tauri 的签名环境构建安装包后，把安装包和 `.sig` 放入同一个 staging 目录：

```bash
TAURI_SIGNING_PRIVATE_KEY="$(cat .secrets/updater.key)" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD= \
  pnpm tauri build
pnpm oss:publish staging 0.1.1
```

发布脚本会把每个版本写入不可变的 `client/v<version>/`，更新 `client/latest.json`，并匿名验证公开 URL。它拒绝覆盖内容不同的旧版本，也拒绝把较新的清单回退到旧版本。

客户端只在正式构建中自动检查更新，启动时检查一次，之后每 6 小时检查一次。发现新版本后显示版本提示；用户确认后下载、校验签名并重启安装，避免在数据采集过程中突然退出。

## 发布前验证

`pnpm oss:publish staging 0.1.1 --dry-run` 只验证本地文件，不访问 OSS。Mac tar.gz 必须包含一个本项目 app，版本必须匹配；发布平台从包内 Mach-O 读取，单架构包不会标成 universal。Mac 包校验目前需在 macOS 使用系统 tar/plutil。Windows 文件名必须包含版本及 Tauri 目标后缀（`_x64-setup.exe`、`_arm64-setup.exe` 或 `_x86-setup.exe`）；目标文件名不能代替真实安装测试。

相同或更旧版本清单均拒绝覆盖；每个平台只接受一个安装包。客户端显示 403 不代表最新版，可能是私有 OSS 桶中尚未发布清单或对象没有公开读取权限。

发布前还会使用客户端内置公钥校验每个安装包的 minisign 签名（文件摘要与受信任注释均校验）。发布使用私有 `client/publish.lock` 互斥对象，要求 OSS 桶未开启过版本控制，成功或失败都会尝试释放锁。如果进程被强制杀死，锁会保留并阻止后续发布；必须确认没有发布进程运行后，才由管理员清理该锁。不可变版本对象通过 OSS 禁止覆盖头写入。相关行为依据 [OSS PutObject 文档](https://www.alibabacloud.com/help/en/oss/developer-reference/putobject)。
