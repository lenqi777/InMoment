# 生产依赖检查

检查日期：2026-10-17。核对 npm 公告和当前锁文件，不调用任何模型或发送用户资料。

## 本轮修复

初始 `pnpm audit --prod` 报告3项高危、1项中危。3项高危均来自 `sharp` 0.34.5 的图像库：

- [libvips 公告 GHSA-f88m-g3jw-g9cj](https://github.com/advisories/GHSA-f88m-g3jw-g9cj)
- [libheif 公告 GHSA-rgj7-g3m4-5g8c](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c)
- [librsvg 公告 GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w)

通过 `pnpm-workspace.yaml` 将 `sharp` 明确覆盖为0.35.5并更新锁文件，ASR/E5模型及Transformers/ONNX版本未变。重新安装、模拟回归与隔离的生产运行库导入通过，没有用模型推理代替验证。对应新版本的原许可、图像库来源和构建配方单独准备；历史包仍保留旧依赖，不能宣称已得到这次修复。

升级后同日公开公告查询结果：**高危0、严重0、中危1**。这只是当次公告数据库与锁文件的匹配结果，不能承诺没有其他问题。

## 仍未修复的间接依赖

[`sprintf-js` <=1.1.3 / GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) 是格式化精度未限定导致异常/拒绝服务的中危公告，查阅时没有官方修复版本。依赖路径为 Transformers → onnxruntime-node → global-agent → roarr → sprintf-js。

静态检查在 onnxruntime-node 1.21.0 的 `script/install.js` 找到 global-agent 导入；其正常 `dist/` 推理入口不导入它。项目明确禁用 onnxruntime-node 安装脚本，下载包已经带好CPU运行库，应用也没有把用户输入交给这一格式化接口。这说明当前应用的触发面受限，不等于漏洞已经修复；仍保留该公告，不将它隐藏为“全部依赖零漏洞”。

后续可在上游提供修复、移除安装用依赖或经过独立验证的最小运行闭包之后再处理。不要在未验证的情况下随意替换底层推理运行库。正式发布时重新核对公告；公开介绍保留这一事实和未完成的真实模型/全新系统验收边界。
