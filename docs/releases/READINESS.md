# 发布准备状态

应用版本：**0.14.31** · [GitHub Releases、下载与校验文件](https://github.com/lenqi777/InMoment/releases)

## 本轮交付内容

- 完整 Windows 11 x64 便携包：程序运行时、原生助手、离线转写、语义模型、图片 OCR、安装入口及第三方许可。
- 独立的公开源码副本、中英文 README、用户指南、开发说明和 [0.14.31 更新说明](0.14.31.md)。
- 0.14.31 实际界面截图：全部笔记、笔记详情、聊天及 AI 服务设置。示例资料为合成内容，AI 展示结果预先准备，见[素材记录](../assets/releases/v0.14.31/PROVENANCE.json)。
- 当前版的发布材料包括 SHA-256、第三方许可和对应源码，均随 [Windows 安装版](https://github.com/lenqi777/InMoment/releases/tag/v0.14.31-installer)提供。历史构建见[版本清单](VERSIONS.md)。

## 验证与运行条件

本地发布复核记录 1,047 项自动测试通过、2 项原生输入检查跳过。构建校验了离线转写、语义模型、OCR 组件和 56 个生产依赖。历次行为测试见[验证记录](../validation.md)。本机混合附件耗时采用模拟服务；自动测试使用合成资料与隔离目录。

完整包已附本地模型。缺少 VC++ x64 Runtime 时，首次安装需要同意下载微软原厂安装文件，可能还需管理员权限。程序目前未代码签名。GPT 与 DeepSeek 的 MP4 抽帧路径另需 FFmpeg 和 ffprobe，配置见[使用指南](../USER_GUIDE.md#随手问-ai)。

全新 Windows 设备上的安装与跨应用操作、真实语音识别和各云端服务的效果仍待对应环境验收。

2026-11-14 的生产依赖公告检查匹配到 0 项已知漏洞，范围和历史结果见[依赖检查](DEPENDENCY_REVIEW.md)。OCR 组件中的 OpenCV wheel 保留原始许可证，DLL 的对应源码、固定构建配方和替换说明见[第三方源码说明](../../THIRD_PARTY_SOURCE_OFFER.md#offline-ocr-and-opencvs-ffmpeg-library)。
