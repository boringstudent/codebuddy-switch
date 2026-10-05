# 开发指南

## 环境要求

Windows、Node.js ≥ 20、Rust stable（msvc 工具链）。项目仅支持 Windows x64。

## 开发命令

```bash
npm install
npm run tauri dev     # 开发模式（前端热更新 + 桌面壳）
npm run build         # 前端类型检查 + 产物（tsc && vite build）
npm test              # 前端逻辑单测（vitest）
cargo test -p wb-switch-core   # 核心库测试
```

## 发布新版本

1. 更新 `src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`package.json` 中的版本号并提交
2. 打 tag 推送：`git tag v<版本> && git push origin v<版本>`
3. CI（`.github/workflows/build.yml`）在 windows-latest 上构建 NSIS 安装包与 MSI，并上传到对应 tag 的 GitHub Release

本地手动打包：`npm run tauri build`（产物在 `target/release/bundle/{nsis,msi}/`）。绿色便携版可直接压缩 `target/release/wb-switch-rust.exe` 得到。

## 目录结构

```
src-tauri/
  src/
    commands.rs      # Tauri command 薄包装
    tray.rs          # 系统托盘
crates/
  wb-switch-core/    # 核心逻辑：账号/签到/积分/会话/API 代理等模块
src/                 # 前端：pages/components/lib（api.ts 走 Tauri invoke）
docs/images/         # README 预览图（账号信息需打码）
```

## 隐私注意事项

- 用户数据（账号库 `accounts.json`、代理库 `proxy_db.json` 等）保存在用户目录 `~/.wb-switch/`，不进入仓库与安装包
- 仓库不提交本地数据（`accounts.json`、`target/`、`dist/` 由 `.gitignore` 排除）
- 发布前用 `git grep` 扫描 token 模式（`ghp_`/`npm_`/`gho_` 等）
- README 预览截图中的账号名、手机号等必须先打码再提交
