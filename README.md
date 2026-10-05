# CodeBuddy

WorkBuddy、CodeBuddy IDE、CodeBuddy CLI 与 VS Code CodeBuddy 插件账号切换桌面 App（Tauri），四者均支持国内版 / 国际版，并提供积分到期与 Token 用量监控。

本项目整合了两个开源项目的成果：[changexbc/workbuddy-switch](https://github.com/changexbc/workbuddy-switch)（账号切换、积分监控与统计、Agent 状态悬浮窗）与 [hailinzhao/antigravity-tools](https://github.com/hailinzhao/antigravity-tools)（批量签到、API Key 代理），并在此基础上合并演进为统一的桌面应用。

<p align="center">
  <img src="public/icon-transparent.png" alt="CodeBuddy 图标" width="128" />
</p>

多账号共享登录态，一键切换 WorkBuddy 登录账号。**会话复制**：把当前账号的会话以新 id 复制给目标账号，源账号数据不受影响，云端归属目标账号。**关联会话**：复制过的会话会自动建立跨账号关联，集中查看各账号副本状态，并把新增内容同步过去。

## 快速开始

前往 [GitHub Releases](https://github.com/boringstudent/codebuddy-switch/releases/latest) 下载对应平台的安装包：

| 平台 | 安装包 | 安装方式 |
| --- | --- | --- |
| macOS Apple Silicon（M 系列，arm64） | `CodeBuddy_<版本>_aarch64.dmg` | 打开 DMG，将 `CodeBuddy.app` 拖入「应用程序」 |
| macOS Intel（x86_64） | `CodeBuddy_<版本>_x86_64.dmg` | 打开 DMG，将 `CodeBuddy.app` 拖入「应用程序」 |
| Windows x64 | `CodeBuddy_<版本>_x64-setup.exe` / `CodeBuddy_<版本>_x64_en-US.msi` | 运行安装程序并按提示完成安装 |
| Windows x64（便携版） | `CodeBuddy_<版本>_x64-portable.zip` | 解压后直接运行 `CodeBuddy.exe`，无需安装 |
| Linux x64 | `CodeBuddy_<版本>_amd64.deb` / `CodeBuddy_<版本>_amd64.AppImage` | Debian/Ubuntu 安装 `.deb`；其他发行版可给 AppImage 添加执行权限后直接运行 |

macOS 首次启动若提示无法验证开发者，先在 Finder 中按住 Control 点击应用并选择「打开」，或前往「系统设置 → 隐私与安全性」选择「仍要打开」。仅当安装包来自上述官方 Releases、且系统仍提示「已损坏」时，再执行：

```bash
xattr -rd com.apple.quarantine "/Applications/CodeBuddy.app"
```

应用能启动但切换账号时提示无权限，请参阅下方 [macOS 权限说明](#macos-权限说明)。

## 功能

| 模块 | 说明 |
| --- | --- |
| 账号管理 | OAuth 扫码登录、导入导出账号、删除账号 |
| 账号切换 | 一键切换 WorkBuddy 登录账号，切换过程实时显示进度 |
| 会话复制 | 把当前账号勾选的会话复制给目标账号，源账号数据不受影响 |
| 关联会话 | 复制过的会话自动建立跨账号关联；按客户端集中查看同一会话在各账号中的副本状态，支持增量同步、分歧处理与新增 / 解除关联 |
| 积分到期查询 | 自动查询每个账号的积分剩余量与到期时间；7 天内到期高亮，并按紧迫程度排序、标注「建议优先使用」 |
| 用量统计 | 积分统计与 Token 统计合并展示：官方请求用量总览、近 30 天趋势、模型分类、账号消耗与请求明细；Token 总览与趋势、构成占比、活跃热力图、项目/模型 Top 10 与会话排行 |
| API 代理 | 本地 OpenAI 兼容中转服务：账号库一键导入为上游 Key 池，子 API Key 分发与鉴权，专一/临期/轮询/会话亲和四种调用模式，429 冷却与风控自动切换，请求日志与 Token/积分统计 |
| CodeBuddy CLI | 与 WorkBuddy 复用同一账号库，默认账号独立；切换后立即生效，无需重启 CLI |
| CodeBuddy IDE | 支持切换 CodeBuddy IDE 桌面客户端账号，并可在弹窗中勾选复制会话，与 CodeBuddy CLI 相互独立 |
| VS Code CodeBuddy 插件 | 支持切换 VS Code 内的 CodeBuddy 插件账号；VS Code 运行时可自动关闭并在写入后重新打开 |
| JetBrains IDE 插件 | 支持切换 IntelliJ IDEA / PyCharm 内的 CodeBuddy 插件账号，一次切换写入所有装了插件的 IDE；IDE 运行时可自动关闭并在写入后重新打开 |
| 插件会话复制 | 切换插件账号时，可把当前插件账号的会话复制给目标账号（加法，源账号不变） |
| 自动轮换 | 后台把积分最紧迫的账号设为 CodeBuddy CLI 后续启动账号；检测到 CLI 会话运行时会跳过 |
| 自动更新 | 从 GitHub Releases 检查新版本，整包更新经签名校验 |
| 会话悬浮窗 | 桌面版内置 Agent Companion 悬浮栏，在桌面集中显示 Codex / WorkBuddy / CodeBuddy / Codeg 会话的运行中 / 待确认 / 已完成状态；悬停查看详情，支持跳转时点击回到原会话，托盘可临时隐藏 |

## 支持的工具

| 工具 | 账号切换 | 会话复制 | 自动关闭重开 | 自动轮换 | 悬浮窗监听 |
| --- | :---: | :---: | :---: | :---: | :---: |
| WorkBuddy | ✅ | ✅ | ✅ | — | ✅ |
| CodeBuddy IDE | ✅ | ✅ | ✅ | — | ✅ |
| CodeBuddy CLI | ✅ | — | — | ✅ | — |
| VS Code CodeBuddy 插件 | ✅ | ✅ | ✅ | — | ✅ |
| JetBrains IDE 插件（IDEA / PyCharm） | ✅ | — | ✅ | — | — |

✅ 表示支持，— 表示不支持。设置 →「支持工具」可按客户端逐个开启 / 关闭入口；关闭后该端入口与状态轮询一并隐藏，不影响账号库与其它端；JetBrains 端默认关闭，可在设置中随时打开。

CodeBuddy CLI 切换时会先关闭正在运行的 CLI，当前会话会中断且不会自动重开；其余各端可在客户端运行时自动完成切换。

### 会话悬浮窗（Agent Companion）

桌面版内置 Agent Companion 悬浮栏：把各 AI Agent 的任务状态集中到桌面，一眼看出谁还在运行、谁需要你确认，支持跳转时点击即可回到原会话；悬浮栏可拖动调整位置，托盘可随时显示 / 隐藏。

| 监听来源 | 跳转到指定会话 | 点击后的行为 |
| --- | :---: | --- |
| Codex（Desktop / CLI） | ✅ | 打开 Codex Desktop 中的指定任务 |
| WorkBuddy（国内版 / 国际版） | ✅ | 打开对应版本中的指定对话 |
| CodeBuddy IDE（国内版 / 国际版） | — | 有工程路径时打开工程，否则只唤起 CodeBuddy |
| CodeBuddy VS Code 插件 | — | 尝试打开会话所属的 VS Code 工程，无法确定时只唤起 VS Code |
| Codeg | ✅ | 打开 Codeg 中的指定聊天会话 |

各来源都会显示运行中 / 待确认 / 已完成状态；CodeBuddy CLI 与 JetBrains 插件不在监听范围内。开启方式：左下角悬浮窗图标，或设置 → Agent Companion；首次使用在「悬浮窗设置」中完成接入（依赖对应客户端的 Hooks / Webhook），监听来源与外观样式也在那里调整。

![Agent Companion 悬浮栏演示：已完成与失败两种状态各自弹出信息卡](docs/images/agent-companion-demo-rail.png)

## 使用

1. **添加与导出账号**：账号页 →「OAuth 扫码登录」「导入备份」；「导出」可将勾选账号备份为 JSON
2. **切换账号与账号信息**：账号卡片 →「切换」，可勾选复制当前会话；「账号信息」可给账号添加备注，并选择卡片上显示账号名 / 手机号 / 备注
3. **查看积分与统计**：账号页自动查询各账号积分到期情况，点「刷新积分」手动更新；侧栏进入「用量统计」查看积分与 Token 用量明细
4. **切换各客户端账号**：CodeBuddy CLI、CodeBuddy IDE、VS Code CodeBuddy 插件均可在账号卡片一键切换；CodeBuddy IDE 与 VS Code 插件支持在弹窗中勾选复制当前账号的会话。CodeBuddy IDE 首次使用前需先手动打开并登录一次
5. **管理关联会话**：侧栏「关联会话」按客户端查看同一会话在各账号中的副本状态，把新增内容增量同步到目标账号、处理内容分歧；「新增关联会话」可把会话复制到新账号并建立关联
6. **开关各端入口**：设置 →「支持工具」可按客户端逐个开启 / 关闭入口；关闭后该端在账号页隐藏、不再轮询状态，不影响账号库。JetBrains 端默认关闭
7. **自动轮换**：设置 → CodeBuddy CLI 自动轮换，开启后按积分紧迫程度自动设置默认账号
8. **更新**：应用会自动检查公开 GitHub Releases；发现新版本后可直接在应用内升级，也可从 Release 页面手动下载

## 界面预览

### 管理 WorkBuddy 与 CodeBuddy 账号

账号卡片集中展示登录状态、积分余额和到期资源，临期积分直接标注在对应卡片内，并按紧迫程度优先排列。

![账号管理页面（账号信息已脱敏）](docs/images/accounts-overview.png)

### 关联会话

复制到其他账号的会话会自动建立关联：按客户端（WorkBuddy / CodeBuddy IDE / CodeBuddy 插件）集中展示同一会话在各账号中的副本状态，可把来源账号的新增内容增量同步到目标账号；出现内容分歧时选择要保留的一份，也可把会话复制到新账号并建立关联。

![关联会话页面](docs/images/session-links.png)

打开任一关联组可查看「会话关联图」：同一会话在各账号中的副本以分支图呈现，内容分歧时标出共同旧版与各自的独立更新，选定要保留的一份即可统一到其他账号。

![关联会话详情：内容分歧时的分支图](docs/images/session-links-branches.png)

### 用量统计

用量统计页把积分统计与 Token 统计合并展示：官方请求用量、每日趋势、模型分布、账号消耗和请求明细，以及 Token 总览与趋势、构成占比、活跃热力图、项目/模型 Top 10 与会话排行。

![积分统计页面](docs/images/credit-statistics.png)

![Token 统计页面](docs/images/token-statistics.png)

## macOS 权限说明

切换账号需要写入 WorkBuddy 认证文件，macOS 要求授权「App 管理」（或「完全磁盘访问」）：

1. 首次切换报「无权限」时，点「打开系统设置」
2. 优先在 **App 管理** 里打开 CodeBuddy 开关；若没有，则去 **完全磁盘访问** 把 CodeBuddy 拖进带箭头的框
3. 授权后重启本应用生效；若仍提示无权限，请重新执行切换操作验证

## 致谢

本项目整合自以下开源项目，感谢原作者的工作：

- [changexbc/workbuddy-switch](https://github.com/changexbc/workbuddy-switch)：WorkBuddy / CodeBuddy 账号切换、积分到期监控、积分统计与 Token 统计、Agent 状态悬浮窗（MIT）
- [hailinzhao/antigravity-tools](https://github.com/hailinzhao/antigravity-tools)：WorkBuddy / CodeBuddy 批量签到与 API Key 代理

## 许可

[MIT](./LICENSE)
