# InMoment · 灵感现场

**想到什么，先说下来。把灵感和它发生时的情境一起留下。**

[English](README.en.md) · [使用指南](docs/USER_GUIDE.md) · [版本记录](CHANGELOG.md) · [产品设计](docs/product/PRODUCT_STORY.md)

InMoment 是一个本地优先的 Windows 桌面灵感记录工具。浏览网页、阅读资料或看设计作品时，长按右键，说出自己的联想；之后可以回听原声、查看来源截图，再用 AI 总结、建议分组，或按大概意思找回记录。

![InMoment 的记录与分组界面](docs/assets/inbox.png)

*界面使用合成示例资料，摘要和分组提前准备。演示展示操作，不代表真实 AI 效果评测。*

## 从记录到找回

- **先留下想法。** 首次长按右键开始录音，松开暂停；再点“继续录音”，便可免按住继续说，点“暂停”才暂停。所有片段属于同一份草稿，最后选择完成或丢弃。
- **保留当时的情境。** 原声、语音文本、来源窗口信息与单窗口截图放在一起；截图取不到时会显示提示。
- **有空再整理。** 修改标题、给记录分组，或请 AI 总结。批量整理先看当前页面的记录，再给出共享分组建议，确认后应用。
- **只记得大概也能找。** 关键词搜索在本机完成；AI 查找结合本地候选和云端排序。灵感云可以浏览内容相近的想法。
- **接着想下去。** 从旧记录开始新的关联记录，两次表达与现场分别保留。

![打开记录并切换原文与摘要](docs/assets/workflow.gif)

[查看无音轨演示视频](docs/assets/inmoment-demo-silent.mp4) · [查看详细操作](docs/USER_GUIDE.md)

## 下载与开始使用

当前应用版本为 **0.10.0**，目标平台是 **Windows 11 x64**。请在 [0.10.0 Release](https://github.com/lenqi777/InMoment/releases/tag/v0.10.0) 中选择完整便携包；本项目暂未提供正式安装程序。

1. 下载 `InMoment-0.10.0-win-x64-full.zip`，将整个压缩包解压到普通本地目录。
2. 首次运行 `Install-InMoment.cmd`。它会检查系统运行库；缺少时先征求同意，再从微软下载并打开原厂安装向导。完成后运行 `InMoment.exe`，保留同目录下的运行组件和模型文件。
3. 按系统提示允许麦克风访问。长按右键录下第一条想法，松开暂停，点击“完成”保存。
4. 需要云端 AI 时，在设置中填写**自己的 DeepSeek API Key**，阅读发送范围并开启需要的功能。截图参与 AI 整理需要单独授权，服务费用由自己的账户承担。

完整包随附程序运行时、离线语音转写和本地语义模型，普通使用无需安装 Node.js、pnpm 或自行下载模型。GitHub 自动生成的 **Source code** 压缩包供开发使用，运行方式见[开发指南](docs/DEVELOPMENT.md)。

当前完整包与校验文件见 [0.10.0 Release](https://github.com/lenqi777/InMoment/releases/tag/v0.10.0)，11 个历史归档包见[历史二进制归档](https://github.com/lenqi777/InMoment/releases/tag/history-binaries)。具体附件、哈希与验证状态以相应 Release 说明为准；当前仍待全新 Windows 环境验收和真实云端端到端联调，不能承诺所有设备与服务账户已经验证通过。

发布准备已更新图像依赖以处理高危公告；仍有一项暂无官方修复的间接依赖中危，触发面和限制见[依赖检查](docs/releases/DEPENDENCY_REVIEW.md)。

## 哪些功能需要联网

| 功能 | 运行位置 | 用户需要准备 |
| --- | --- | --- |
| 录音、回听、查看截图、修改与手动分组 | 本机 | 麦克风和相应系统权限 |
| 中文语音转写 | 本机 whisper.cpp / Whisper base | 完整包已包含组件 |
| 关键词查找、灵感云、本地语义候选 | 本机；语义部分使用 E5 模型 | 完整包已包含模型 |
| AI 总结、批量归类、AI 查找、可选自动命名 | DeepSeek 云端 | 自己的 API Key、联网和功能授权 |

云端功能默认关闭。关闭云端功能后，仍可使用本地录音、资料管理、转写、关键词查找和灵感云；AI 查找的云端排序需要开启对应功能。实际转写与语义质量随内容和设备而变。

## 资料与隐私

资料库、录音、截图和索引保存在当前 Windows 用户的应用数据目录。未完成的草稿保持本地暂存，丢弃会撤销异步回写并清理本次资料。

云端 AI 按授权发送所选记录的文字与来源线索，截图单独授权；原始录音不会随这些功能上传。API Key 使用 Windows DPAPI 保护，记录库与媒体附件没有整体加密。详情见[数据说明](PRIVACY.md)与[安全说明](SECURITY.md)。

## 选择版本

推荐先使用当前版本。[历史二进制归档](https://github.com/lenqi777/InMoment/releases/tag/history-binaries)中的过去版本，其功能、附件完整性和分发状态见[版本清单](docs/releases/VERSIONS.md)。旧版本保留其当时的能力与限制，下载前阅读对应说明；切换旧版前备份资料，不让不同版本同时写入同一资料目录。

## 项目与验证

InMoment 从作者自己的记录习惯出发。作者负责需求、交互、AI 功能方案与验收迭代，实现和自动化测试借助 AI 编程工具完成。[产品设计与证据边界](docs/product/PRODUCT_STORY.md)记录了场景、取舍和评测计划。

自动化测试使用模拟模型响应与合成资料，验证保存、取消、授权、请求范围和结果应用等行为。既有版本的测试证据见[验证记录](docs/validation.md)。真实中文识别质量、摘要质量、分类质量、搜索召回和使用效率仍待系统评测，目前没有外部用户增长或节省时长结论。

开发环境：Windows 11 x64、Node.js 24+、pnpm 11.25.0。

```powershell
pnpm install --frozen-lockfile
pnpm native:build
pnpm check
pnpm test
pnpm start
```

模型准备、隔离测试和打包见[开发指南](docs/DEVELOPMENT.md)。开发与测试遵循 [AGENTS.md](AGENTS.md)，真实模型或 API 调用需要单独明确批准。

源码采用 [MIT 许可证](LICENSE)，随附组件的许可见[第三方说明](THIRD_PARTY_NOTICES.md)。
