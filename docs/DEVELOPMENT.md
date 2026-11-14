# 开发与打包

当前应用版本为 **0.14.31**，目标为 Windows 11 x64。开发需要 Node.js 24+、pnpm 11.25.0，以及 Windows 自带的 .NET Framework 编译器与 System.Speech 引用程序集。普通下载用户使用完整便携包，无需这些开发工具。

## 安装与隔离启动

```powershell
pnpm install --frozen-lockfile
pnpm native:build
$env:INMOMENT_DATA_DIR = Join-Path $PWD '.local/dev-data'
$env:INMOMENT_DISABLE_NETWORK = '1'
pnpm start
```

以上环境变量须在终端设置，应用不会读取 .env。网络锁还会禁止真实语义推理；普通回归不运行真实模型。真实模型、API、麦克风和外部窗口采集必须先获得本次明确授权，规则见 [AGENTS.md](../AGENTS.md)。

pnpm 11 的 allowBuilds 已明确为布尔值：仅允许 Electron 的开发运行时安装脚本，禁止 onnxruntime-node、protobufjs、sharp 的安装脚本；运行所需的原生组件来自锁定的预编译依赖。旧 ignoredBuiltDependencies 已移除。[pnpm 官方说明](https://github.com/pnpm/pnpm.io/blob/main/docs/settings/build.md)解释了这一配置。

`pnpm-workspace.yaml` 通过 overrides 将间接图像依赖 sharp 固定为 0.35.5，锁文件与配置一同保留。2026-11-14 的生产依赖公告检查匹配到 0 项已知漏洞，报告范围和历史处理见[依赖检查](releases/DEPENDENCY_REVIEW.md)。

## 本地检查

```powershell
pnpm check
pnpm test
```

test 只发现 tests/*.test.cjs，避免重复执行 release 或打包副本中的测试。测试使用注入的 mock fetch、合成音频和临时资料。主进程集成夹具隔离 process.env 并阻断真实网络；默认跳过需要显式桌面输入的测试。受限环境可加 --config.verify-deps-before-run=false，避免 pnpm 预检访问外部全局目录。结果见[验证记录](validation.md)。

## 准备模型（须明确同意下载）

源码不包含模型。完整用户下载包附带已准备的本地模型，安装时不下载模型。开发者需要准备时分别执行：

```powershell
pnpm asr:setup
node scripts/setup-semantic.cjs --status
node scripts/setup-semantic.cjs --approve-download
pnpm ocr:setup
```

ASR 为固定 sherpa-onnx 2.0.1 Windows x64 CPU 原生组件与 SenseVoiceSmall INT8 2024-07-17 模型（模型约 228 MiB），无需系统 Python。语义为固定 revision 的 Xenova/multilingual-e5-small 与分词文件，约 129 MiB。脚本逐文件校验大小与 SHA-256，仅准备文件，不运行模型。来源、运行组件和模型许可证见[第三方说明](../THIRD_PARTY_NOTICES.md)。

`scripts/asr-assets.json` 是离线语音安装与打包的固定清单。`pnpm asr:setup` 会将旧的 `asr.json`、运行组件和模型备份至安装目录的 `backups/`，保留旧文件，再提交 SenseVoice 配置。旧 Whisper 安装需要显式执行这一步；应用不会自动下载、升级或回退。可通过 `-RuntimeArchive` 与 `-ModelArchive` 复用已下载归档，仍执行固定哈希校验。

`pnpm ocr:setup` 按 `scripts/ocr-assets.json` 准备 Windows x64 离线图片识别组件，校验归档后将 CPython、RapidOCR、ONNX Runtime 和 PP-OCRv6 small 模型放入 `.local/offline-ocr/`。再次执行时复验本地组件。准备与使用都无需另装 Python。运行库检查仅加载模型与 CPU 执行环境。

## 构建用户下载包

```powershell
pnpm run package
```

默认完整包要求提前准备离线转写、语义模型和图片 OCR。输出在 `dist/InMoment-版本-win-x64-构建标识/`，`dist/latest.txt` 记录最近一次成功输出目录。精简开发包使用 `pnpm run package:minimal`，可按需传入 `--with-asr`、`--with-semantic` 或 `--with-ocr`。

本版候选附件命名为 `InMoment-0.14.31-win-x64-full.zip`，附 SHA-256 校验文件。ZIP 包含整个便携目录中的程序、`resources`、离线组件、安装脚本及许可；GitHub 自动生成的源码压缩包供开发使用。

脚本按允许清单复制源码、生产依赖闭包、文档和模型，保留许可，重验模型哈希，在源码目录外导入 Transformers 运行库，禁止网络且不执行模型。语音包只包含新 CLI、两个 ONNX Runtime DLL、SenseVoice 模型、词表和许可；不会夹带旧 Whisper 模型、下载缓存、安装备份或测试录音。node scripts/verify-portable.cjs <解压目录> 可以复验完整包；应对最终 ZIP 解压后的目录再次执行。

完整包的 Install-InMoment.cmd 使用包内 PowerShell 安装入口检查 VC++ x64 Runtime。缺少时先询问用户，再从微软固定地址下载，校验 SHA-256、大小和 Microsoft Authenticode 签名，显示原厂许可及安装界面；不静默安装，不捆绑再分发微软安装文件，不自动启动应用。退出失败或需要重启均可见。已有合适运行库时无需下载。Windows 系统权限与设备策略仍由用户控制。

PDF 聊天附件使用随包的 PDF.js，公式排版使用本地 KaTeX。GPT 与 DeepSeek 的 MP4 路径额外依赖 FFmpeg 和 ffprobe；可从 `InMoment.exe` 同级的 `chat-media/bin/`、PATH 或 `INMOMENT_CHAT_FFMPEG_DIR` 指向的目录定位这两个命令行工具。Gemini 原视频路径不需要它们。OCR 的 OpenCV wheel 附带独立的 FFmpeg DLL；发布前核对该二进制的对应源码和构建来源，见[第三方源码说明](../THIRD_PARTY_SOURCE_OFFER.md#offline-ocr-and-opencvs-ffmpeg-library)。

公开演示使用无音轨版本。带音乐的原片留在本地工作区。

## 界面与云端验证

`pnpm ui:audit` 在隔离的 Electron 窗口中检查统一笔记、分组、附件、背景信息与音视频播放。测试使用合成数据和禁网络模式。通过 `INMOMENT_PLAYWRIGHT` 指定本机 Playwright 包，结果写入 `.local/notes-review/run-*/`。`scripts/smoke.cjs` 会使用合成麦克风和测试自身窗口，只在明确授权相应检查时运行。

真实云端联调另行确认样本、发送字段、请求数与预算。客户端支持官方 DeepSeek、OpenAI Responses 和 Gemini 接口。聊天使用对应原生 SSE 流；默认自动选模型，不跨厂家切换，不自动重试。功能使用 mock 请求验证，真实服务联调须明确授权。

聊天模块：`src/main/chat-service.cjs` 管理临时／已保存会话、引用快照和转灵感；`src/shared/chat-view.js/css` 由主窗口和 `src/chat/` 浮窗共用；`src/main/chat-capture.cjs` 负责临时录音所有权、转写候选和清理。主窗口聊天首次发送后自动保存；浮窗聊天在明确保存或转主窗口前不写历史，关闭有内容的未保存会话会询问保存。恢复标记只含草稿 ID，异常退出后只清理仍为草稿的录音，不触碰已保存或正在提交的记录。`voice-activity.cjs` 采用保守 PCM 静音检查，`uncertain` 与失败不等同于没有人声。

`pnpm ui:chat-audit` 使用真实 Electron DOM、模拟录音状态和合成图片，检查麦克风／暂停按钮焦点后的 Tab 采用、输入回写顺序、加号菜单及图片预览。不会开启麦克风、运行语音模型或调用 AI；使用独立资料目录与禁网络环境。输出和截图默认在 `.local/chat-composer-fix-20261108/`，可用 `INMOMENT_CHAT_COMPOSER_AUDIT_OUTPUT` 指定工作区内其他目录；Playwright 路径沿用 `INMOMENT_PLAYWRIGHT`。

## 目录与发布副本

| 目录 | 内容 |
| --- | --- |
| src/main、src/core | 主进程、数据、状态、权限和 AI 工作流 |
| src/renderer、src/overlay、src/recorder | 资料库、录音浮层和音频组件 |
| src/chat、src/shared、src/screenshot | 聊天浮窗、共享界面与截图编辑 |
| native、scripts、tests | Windows 辅助程序、构建和回归 |
| docs/product、docs/portfolio、docs/assets | 产品文档、案例和合成演示 |
| docs/third-party | 许可与第三方来源 |
| .local、build、dist、test-results、release、release-preparation | 本地数据、依赖准备、产物与交接，排除出 Git |

node scripts/prepare-publication.cjs <新目录> 按允许清单生成独立源码副本与哈希，不执行 GitHub 操作。历史便携资产没有可验证的历史 Git 提交，不能伪造历史源码和提交日期。发布前见[发布状态](releases/READINESS.md)与[版本清单](releases/VERSIONS.md)。

开发目录、旧交接副本和已经打包的应用相互独立。修改源码或文档后，重新生成当前发布副本与完整包；`release-preparation` 和桌面旧副本不会自动同步。每个公开版本保留独立 Release 和附件，当前版本更新不覆盖旧包。
