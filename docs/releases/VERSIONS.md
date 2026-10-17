# 版本下载说明

截至 2026-10-17，项目保留了 12 个应用版本、13 次原始构建。当前完整包与 11 个历史归档包分别见 [0.10.0 Release](https://github.com/lenqi777/InMoment/releases/tag/v0.10.0)和[历史二进制归档](https://github.com/lenqi777/InMoment/releases/tag/history-binaries)。GitHub 自动生成的 Source code 不是可直接运行的 Windows 下载包。

## 推荐版本

**0.10.0：[InMoment-0.10.0-win-x64-full.zip](https://github.com/lenqi777/InMoment/releases/download/v0.10.0/InMoment-0.10.0-win-x64-full.zip)**。含语音、本地语义模型和全部生产依赖，附可见的首次运行库检查入口，见[使用指南](../USER_GUIDE.md)。此为发布准备修订构建，应用功能版本不变；用同一 Release 的 `SHA256SUMS-current.txt` 区分旧本地构建。

## 历史版本

以下 11 个附件集中放在[历史二进制归档 Release](https://github.com/lenqi777/InMoment/releases/tag/history-binaries)，校验文件为 `SHA256SUMS-history.txt`。归档 Release 同时提供第三方许可补充与源码集合。

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

历史包保留当时功能与限制，均附 ARCHIVE-NOTICE.txt；没有把当前功能或依赖修复回填旧版。0.9.0 两次构建选取较晚的一次；旧 0.10.0 本地构建不重复占用同版本下载入口。各版本变化见 [CHANGELOG](../../CHANGELOG.md)。

旧包依赖系统 VC++ x64 Runtime，可能需要先完成当前包的依赖检查。部分历史包第三方许可文件需要结合当前版本的补充说明与对应源码阅读；它们保留原始发布材料，没有伪称完成新系统验收。

## 安全切换版本

各版本默认使用同一个 Windows 用户资料目录。先完全退出应用并备份资料，不能把旧版当成支持降级迁移的程序。试用旧版时为每个版本使用一个空目录：

```powershell
$env:INMOMENT_DATA_DIR = Join-Path $env:LOCALAPPDATA 'InMoment-archive-v0.9.0'
& '.\InMoment.exe'
```

只在上面的新 PowerShell 会话设置该变量，不要覆盖已有资料路径。新旧版本均不能同时写同一资料库；换机器后重新填写自己的 Key。

## 历史来源与验证

原始文件夹没有 .git 历史。历史资产是真实保留的二进制构建，不能由此还原完整历史开发仓库。`history-binaries` 标签用于集中分发这些历史构建；该 Release 自动生成的 Source code 对应当前发布快照，不代表任何历史版本的可重建源码，也不回填历史提交时间。

历史 11 个 ZIP 已检查 CRC、模型哈希、明显私人文件和常见凭据模式。每个实际资产的 SHA-256 以最终 Release 附件与校验文件为准。静态检查不证明真实语音、语义或云端质量，也不证明全新 Windows 兼容性。
