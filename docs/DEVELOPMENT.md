# 开发与打包

当前应用版本为 0.10.0，目标为 Windows 11 x64。开发需要 Node.js 24+、pnpm 11.25.0，以及 Windows 自带的 .NET Framework 编译器与 System.Speech 引用程序集。普通下载用户不需要这些开发工具。

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

发布准备通过overrides将间接图像依赖sharp固定为0.35.5，锁文件必须一同保留。此更新消除当次3项高危公告；剩余无官方修复的中危及触发面见[依赖检查](releases/DEPENDENCY_REVIEW.md)。语音和语义模型未升级。

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
```

ASR 为 whisper.cpp Windows CPU 组件和约 142 MiB 的多语言 Whisper base；语义为固定 revision 的 Xenova/multilingual-e5-small 与分词文件，约 129 MiB。脚本校验版本和哈希，仅准备文件，不运行模型。来源与许可见[第三方说明](../THIRD_PARTY_NOTICES.md)。

## 构建用户下载包

```powershell
pnpm run package
```

默认完整包必须已有 ASR 与语义模型，缺少时明确失败，不启动下载。输出在 dist/InMoment-版本-win-x64-构建标识/。兼容旧参数 --with-asr --with-semantic。精简开发包须明确运行 pnpm run package:minimal；不能以它宣传全部本地功能可用。

脚本按允许清单复制源码、生产依赖闭包、文档和模型，保留许可，重验模型哈希，在源码目录外导入 Transformers 运行库，禁止网络且不执行模型。node scripts/verify-portable.cjs <解压目录> 可以复验完整包；应对最终 ZIP 解压后的目录再次执行。

完整包的 Install-InMoment.cmd 使用包内 PowerShell 安装入口检查 VC++ x64 Runtime。缺少时先询问用户，再从微软固定地址下载，校验 SHA-256、大小和 Microsoft Authenticode 签名，显示原厂许可及安装界面；不静默安装，不捆绑再分发微软安装文件，不自动启动应用。退出失败或需要重启均可见。已有合适运行库时无需下载。Windows 系统权限与设备策略仍由用户控制。

公开下载使用无音轨演示。带音乐的原片只留在作者工作区；不因“作者提供”而推断音乐再分发许可。

## 界面与云端验证

scripts/ux-smoke.cjs 使用独立合成库、测试窗口和禁网络模式检查布局、分组与阅读，不运行模型或录音。需将 INMOMENT_PLAYWRIGHT 指向本机 Playwright 包；成品检查另设置 INMOMENT_SMOKE_EXECUTABLE。scripts/smoke.cjs 会使用合成麦克风和测试自身窗口，只在明确授权相应检查时运行。

真实云端联调另行确认样本、发送字段、请求数与预算。默认客户端仅支持官方 DeepSeek 服务。功能已接入并通过 mock 请求验证，公共文档核对不等于真实服务联调。

## 目录与发布副本

| 目录 | 内容 |
| --- | --- |
| src/main、src/core | 主进程、数据、状态、权限和 AI 工作流 |
| src/renderer、src/overlay、src/recorder | 资料库、录音浮层和音频组件 |
| native、scripts、tests | Windows 辅助程序、构建和回归 |
| docs/product、docs/portfolio、docs/assets | 产品文档、案例和合成演示 |
| docs/third-party | 许可与第三方来源 |
| .local、build、dist、test-results、release、release-preparation | 本地数据、依赖准备、产物与交接，排除出 Git |

node scripts/prepare-publication.cjs <新目录> 按允许清单生成独立源码副本与哈希，不执行 GitHub 操作。历史便携资产没有可验证的历史 Git 提交，不能伪造历史源码和提交日期。发布前见[发布状态](releases/READINESS.md)与[版本清单](releases/VERSIONS.md)。
