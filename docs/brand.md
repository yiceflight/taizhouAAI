# 江苏省泰州环境监测中心智能监测系统 · Logo

以绿叶、蓝色监测波形和青色感知节点构成环形标志，表达生态环境、多源监测与智能感知。

- 白底 PNG：`public/brand/monitoring-logo.png`
- 网页图标：`public/brand/favicon.png`
- 桌面端 PNG / ICNS / ICO：`src-tauri/icons/`
- 开发环境桌面图标：`src-tauri/icons/dev/icon.png` / `icon.icns`（带 `D` 角标，运行时仅由 `pnpm dev:client` 使用）
- Chrome 插件图标：`extension/icons/`
- 系统名称通过界面文字独立排版，保证中文清晰、可访问。

使用内置 image_gen 生成原图，使用 `pnpm tauri icon public/brand/monitoring-logo.png` 导出应用图标。应用标识、升级地址和包名保持稳定，显示名称统一使用中文全称。

开发版图标用 `swift scripts/generate-dev-icon.swift` 重新生成（macOS）。运行时替换 Dock 图标不会自动获得安装版的留白：在 1024 像素画布上，主体为 824 × 824，四边各留 100 像素透明边距。`D` 角标在主体裁剪后单独绘制，避免被圆角裁掉；PNG 与 ICNS 共用同一布局。

## 生成提示词

```text
Use case: logo-brand.
Asset type: production desktop app logo mark for 江苏省泰州环境监测中心智能监测系统 (Taizhou Monitoring Center Intelligent Monitoring System).
Primary request: Design a polished, distinctive, minimal symbol for a Chinese environmental monitoring center's intelligent monitoring software. A bold circular near-ring of two fluid interlocking shapes, one forest green leaf-like arc and one monitoring blue water-wave arc, enclosing a clean white negative-space wave/monitoring pulse. A single small cyan data dot near the upper right opening evokes sensing and connected intelligence. Coherent unified silhouette, confident rounded geometry, strong small-size legibility, institutional and modern.
Color palette: deep ecological green #27745A, monitoring blue #237DA5, small teal #56B8AE accent. Flat solid fills, crisp edges, no shading or gradients.
Composition: just ONE centered symbol filling approximately 82% of a square 1024 x 1024 image with consistent safe margins.
Scene/backdrop: solid white background (#FFFFFF), no transparency, checkerboard, or shadow.
Constraints: SYMBOL ONLY. No text, letters, captions, numbers, mockups, borders, presentation panels, watermark, drop shadows, 3D, thin intricate circuitry, or official national emblems. The Chinese name will be typeset separately in the application.
```
