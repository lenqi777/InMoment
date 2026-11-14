# 版本下载说明

当前源码为 0.14.31，已发布的便携包及 SHA-256 见 [GitHub Releases](https://github.com/lenqi777/InMoment/releases)。[0.10.0 完整包](https://github.com/lenqi777/InMoment/releases/tag/v0.10.0)和 [0.1.0–0.9.0 历史下载](https://github.com/lenqi777/InMoment/releases/tag/history-binaries)继续可用。下方 0.11–0.14.30 为本地构建记录。

普通用户下载对应版本的 Windows 完整包或历史归档附件。GitHub 自动生成的 **Source code** 是源码快照，不能直接作为可运行的 Windows 软件使用。

## 推荐版本

**0.14.31：`InMoment-0.14.31-win-x64-full.zip`**，目标为 Windows 11 x64。包含本地 SenseVoiceSmall 转写组件、语义模型、图像 OCR 及生产依赖。解压整个 ZIP 后运行 `Install-InMoment.cmd` 检查依赖，再打开 `InMoment.exe`。安装、AI 服务配置和更新资料见[使用指南](../USER_GUIDE.md)。

本地基础功能无需 API Key；可选云端 AI 使用下载者自己的 DeepSeek、OpenAI（GPT）或 Gemini Key，并按服务商实际用量计费。具体服务、授权与截图发送范围见 [AI 服务设置](../AI_PROVIDER_SETUP.md)。

## 0.11—0.14.30 本地构建记录

下列构建均包含本地转写和语义组件。0.11.0—0.13.2 使用当时的 Whisper.cpp base；0.13.3 选取较晚的 SenseVoiceSmall 构建，此后的 0.14 系列也使用 SenseVoiceSmall。组件信息来自保留包内的配置，历史功能按各版[更新记录](../../CHANGELOG.md)理解。

| 版本 | 主要变化 | 归档附件 |
| --- | --- | --- |
| 0.11.0 | 录音与文本统一布局 | InMoment-0.11.0-win-x64-archive.zip |
| 0.11.1 | 轻量界面与图标交互 | InMoment-0.11.1-win-x64-archive.zip |
| 0.12.0 | 统一筛选与界面动效 | InMoment-0.12.0-win-x64-archive.zip |
| 0.12.1 | 记录侧栏操作归位 | InMoment-0.12.1-win-x64-archive.zip |
| 0.13.0 | 多 AI 服务选择 | InMoment-0.13.0-win-x64-archive.zip |
| 0.13.1 | 选择交互与视觉对齐 | InMoment-0.13.1-win-x64-archive.zip |
| 0.13.2 | 按钮状态与帮助入口 | InMoment-0.13.2-win-x64-archive.zip |
| 0.13.3 | 静态品牌、分组栏间距及转写组件更新 | InMoment-0.13.3-win-x64-archive.zip |
| 0.14.0 | 临时聊天与灵感互通 | InMoment-0.14.0-win-x64-archive.zip |
| 0.14.1 | 聊天输入与附件操作 | InMoment-0.14.1-win-x64-archive.zip |
| 0.14.2 | 录音胶囊与滚动布局 | InMoment-0.14.2-win-x64-archive.zip |
| 0.14.3 | 品牌一致与长文本输入 | InMoment-0.14.3-win-x64-archive.zip |
| 0.14.4 | 紧凑录音面板效果预览 | InMoment-0.14.4-win-x64-archive.zip |
| 0.14.5 | 模态标题栏与录音细节 | InMoment-0.14.5-win-x64-archive.zip |
| 0.14.6 | 品牌录音控制与连续形变 | InMoment-0.14.6-win-x64-archive.zip |
| 0.14.7 | 录音面板留白与位置修正 | InMoment-0.14.7-win-x64-archive.zip |
| 0.14.8 | 胶囊展开聊天与安静输入 | InMoment-0.14.8-win-x64-archive.zip |
| 0.14.9 | 聊天布局、主动语音与返回入口 | InMoment-0.14.9-win-x64-archive.zip |
| 0.14.10 | 输入区保持、会话恢复与原位编辑 | InMoment-0.14.10-win-x64-archive.zip |
| 0.14.11 | 截图标注与固定录音工具栏 | InMoment-0.14.11-win-x64-archive.zip |
| 0.14.12 | 回放波形与紧凑聊天控制 | InMoment-0.14.12-win-x64-archive.zip |
| 0.14.13 | 剪刀图标视觉尺寸 | InMoment-0.14.13-win-x64-archive.zip |
| 0.14.14 | 聊天欢迎页、历史与分组列表 | InMoment-0.14.14-win-x64-archive.zip |
| 0.14.15 | 截图任务栏重复显示修正 | InMoment-0.14.15-win-x64-archive.zip |
| 0.14.16 | 聊天保存、引用附件与系统验收 | InMoment-0.14.16-win-x64-full.zip |
| 0.14.17 | 数学公式与聊天滚动导航 | InMoment-0.14.17-win-x64-archive.zip |
| 0.14.18 | 聊天混合附件与处理进度 | InMoment-0.14.18-win-x64-archive.zip |
| 0.14.19 | 笔记列、选段与截图交互 | InMoment-0.14.19-win-x64-archive.zip |
| 0.14.20 | 笔记主题树与导出 | InMoment-0.14.20-win-x64-archive.zip |
| 0.14.21 | 统一窗口外壳与设置 | InMoment-0.14.21-win-x64-archive.zip |
| 0.14.22 | 笔记布局与按钮状态 | InMoment-0.14.22-win-x64-archive.zip |
| 0.14.23 | 对齐导航列与胶囊按钮 | InMoment-0.14.23-win-x64-archive.zip |
| 0.14.24 | 最近编辑与圆角矩形按钮 | InMoment-0.14.24-win-x64-archive.zip |
| 0.14.25 | 灰色按钮三态 | InMoment-0.14.25-win-x64-archive.zip |
| 0.14.26 | 持续选中图标与笔记列展开 | InMoment-0.14.26-win-x64-archive.zip |
| 0.14.27 | 笔记列标签与多选文案 | InMoment-0.14.27-win-x64-archive.zip |
| 0.14.28 | 聊天短线导航 | InMoment-0.14.28-win-x64-archive.zip |
| 0.14.29 | 分组栏开合图标 | InMoment-0.14.29-win-x64-archive.zip |
| 0.14.30 | 聊天导航居中与跟读 | InMoment-0.14.30-win-x64-archive.zip |

同版本有多次构建时，选择较晚且通过检查的一次。原始构建保留在开发工作区，交付目录每个版本提供一个下载入口。新增归档保留程序、依赖和模型，并附归档说明及文件校验清单。0.14.19、0.14.20 的变化概述来自对应构建中的应用文件差异。

## 0.1—0.10 早期版本

这 12 个 ZIP 已于 2026-10-17 发布。0.10.0 为当时的完整便携包；0.1.0—0.9.0 保留归档包及其 `ARCHIVE-NOTICE.txt`。

| 版本 | 主要阶段 | 下载附件 | 语音 / 语义模型 |
| --- | --- | --- | --- |
| 0.1.0 | 首个记录原型 | InMoment-0.1.0-win-x64-archive.zip | 已附 / 当时尚无该组件 |
| 0.2.0 | 长按反馈与自动命名 | InMoment-0.2.0-win-x64-archive.zip | 已附 / 当时尚无该组件 |
| 0.3.0 | 原图查看与设置保护 | InMoment-0.3.0-win-x64-archive.zip | 已附 / 当时尚无该组件 |
| 0.4.0 | 主题、检索与关联 | InMoment-0.4.0-win-x64-archive.zip | 已附 / 当时尚无该组件 |
| 0.4.1 | 统一弹窗和取消保护 | InMoment-0.4.1-win-x64-archive.zip | 已附 / 当时尚无该组件 |
| 0.5.0 | 组织浏览与布局 | InMoment-0.5.0-win-x64-archive.zip | 已附 / 当时尚无该组件 |
| 0.6.0 | 单条灵感与分组阅读 | InMoment-0.6.0-win-x64-archive.zip | 已附 / 当时尚无该组件 |
| 0.7.0 | 本地语义与灵感云 | InMoment-0.7.0-win-x64-archive.zip | 已附 / 已附 |
| 0.7.1 | 详情操作简化 | InMoment-0.7.1-win-x64-archive.zip | 已附 / 已附 |
| 0.8.0 | 多选与按组查看建议 | InMoment-0.8.0-win-x64-archive.zip | 已附 / 已附 |
| 0.9.0 | 简洁列表和就地操作 | InMoment-0.9.0-win-x64-archive.zip | 已附 / 已附 |
| 0.10.0 | 多选管理分组与整批归类 | InMoment-0.10.0-win-x64-full.zip | 已附 / 已附 |

历史包保留当时的功能和依赖。早期包依赖系统 VC++ x64 Runtime，可先用当前包检查依赖。第三方许可及对应源码获取方式见各包的许可资料和交付目录的补充说明。

## 安全切换版本

各版本默认使用同一个 Windows 用户资料目录。切换前先从托盘完全退出应用，备份 `%APPDATA%\InMoment`。试用旧版时为每个版本使用独立空目录：

```powershell
$env:INMOMENT_DATA_DIR = Join-Path $env:LOCALAPPDATA 'InMoment-archive-v0.14.30'
& '.\InMoment.exe'
```

在新的 PowerShell 会话中设置该变量，再从对应旧版解压目录运行。新旧版本不能同时写入同一资料库；旧版不提供新版资料格式的降级迁移保证。换机器后重新填写自己的 Key。

## 历史来源与验证

保留的构建是真实二进制资产，包内含当时应用代码快照。原项目没有 `.git` 历史，这些资产不能还原完整旧版开发仓库。历史下载标签应明确对应归档资产，不声称 GitHub 自动生成的 Source code 就是完整旧版可重建源码，也不回填提交时间。

本轮对 14 个新增历史 ZIP 校验 CRC、SHA-256、模型文件与隐私风险。验证范围及最终附件校验值见交付目录；历史包未逐版运行实机或真实云端模型。
