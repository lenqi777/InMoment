# InMoment development rules

- Windows desktop MVP. Preserve the agreed interaction: initial right-button hold records, release pauses; clicking Continue thereafter records hands-free and the Pause button pauses. All segments belong to one draft.
- Never call a real model/API during development or tests without the human user's explicit approval for that call. Reading public documentation and downloading public development dependencies is permitted. Tests use injected mock fetch and synthetic audio only.
- Never copy credentials from chat into source, examples, fixtures, logs, screenshots, or build artifacts. Each app user supplies their own key through local settings. OS-protected key material and all user data must stay outside tracked source.
- Before Complete, keep capture data local and provisional. Discard invalidates callbacks first, then clears screenshots, audio, metadata, and temporary files. Saved/committing records and draft cleanup must not race.
- Do not silently record, take desktop-wide screenshots, download speech models, or upload data. A permission or capability failure must remain visible.
- `pnpm test` and `pnpm check` run locally without API calls. Do not publish a GitHub repository or release without a direct user request.

## UI 设计与验收

- 修改或新增应用 UI 前，读取 `docs/design/UI_GUIDELINES.md`、`docs/design/MOTION_GUIDELINES.md` 和 `docs/design/VISUAL_REVIEW_GUIDELINES.md`；沿用公共样式变量、组件和交互，使用 `docs/design/UI_CHECKLIST.md` 检查完成结果。
- 先确认功能必要性再赋予交互：InMoment 品牌名称保持静态文本，保留标题栏拖动；不添加点击、链接、悬停底块或 Tab 焦点，返回使用已有按钮。文字间距按行框和中心测量，与按钮背景边界的间距分开检查。
- 删除和丢弃动作的文字与图标统一使用危险红 `#B42318`。所有四角星按钮的两态图标及文字统一使用墨绿 `#102719`，有文字时图标放在文字前。
- 录音播放器与语音文本／摘要在白底同一区域以间距组织，保持无大外边框、无音频片段浅灰卡片；来源标签透明，截图独立成组；空内容不产生空区块或重复分割线。
- 可点击功能图标复用 `src/shared/ui-icons.js` 与 `ui-controls.css`，使用官方独立 Regular／Filled 两态。默认线型，悬停、键盘焦点或持续选中时用 180ms 自下而上互补擦换进入面型。按钮持续选中期间保持面型，取消选中且离开焦点与悬停后恢复线型。减少动态效果立即切换，普通不可用控件和非交互装饰保持静态。
- 主窗口和浮窗的发送按钮是图标动效例外。无可发送内容时禁用，在浅绿圆底上显示低强调的墨绿线型四角星。有可发送内容时持续显示面型，移开鼠标或焦点后仍保留，清空最后一项内容后恢复线型。图标随内容双向擦换，减少动态效果时立即切换。按 [聊天发送按钮规则](docs/design/UI_GUIDELINES.md#聊天发送按钮) 验收。
- 筛选统一从一个就近面板收纳时间、关键词和按描述查找，“一键整理”保留在外；分组建议用已有组／新组图标区分，最多直接显示两个，其余进入可搜索浮框。
- 主窗口页面共用外壳，标题栏高度与左侧操作栏宽度一致。两栏同底色，交界无分割线，内侧内容区统一左上圆角。
- 所有改变界面的交互按动效规范匹配过渡，复用 `src/shared/ui-motion.js/css`。记录从来源卡片过渡到详情并可返回；浮层进入与退出成对处理，连续拖动、滚轮、进度和输入即时响应。检查中断、快速反向操作、减少动态效果和最终焦点，视觉动画保持原有录音及数据清理时序。
- 主窗口聊天历史栏、展开的分组列和笔记列共用响应式列宽。分组与笔记列标签使用 18 CSS px 常规字重，标题与搜索框按同一规格对齐。启动时直接显示「全部笔记」，切组在原列更新列表。宽窗口正文占主要空间，窄窗口从正文返回时直接显示笔记列表。标题在列表中使用单行。界面改动用隔离数据检查多条记录、多个分组、长内容、窗口尺寸及缩放，保护已有设置和记录。
- 详情模式的搜索、选择、筛选、整理、加载反馈和分页留在记录列，右侧专注单条详情；窄窗口仍保留记录列入口。主页与详情复用同一份控件，跨列移动时保留搜索焦点与选中文字、关闭旧浮框，保持筛选、多选和未保存编辑的现有语义。
- 记录选择栏常驻总选复选框，点击可进入并全选；“选择”文字进入时选中 0 条，“完成”退出清空。总选表达未选／部分／全选，不另放功能图标或独立全选按钮。
- 布局先统一起线、文字基线、控件中心和 4／8px 间距，再复查图标实际轮廓的光学重心。确有需要的光学位移单轴不超过 1 CSS px，两态共用校正，点击框不变。交付前保存截图叠线测量与人工复查结果，区分几何检查和实际视觉判断。
- 应用绘制的按钮共用圆角矩形与三态反馈。未触发为透明，悬停、按下与实际选中均叠加 4% 按钮基色。悬停随指针离开而消失，实际选中持续保留底色。普通按钮用中性灰 `#191919`，红色动作叠危险红 `#B42318`，绿色动作、四角星和绿金品牌按钮叠操作绿 `#256D49`，截图彩色色样按自身颜色叠色，黑白色样叠中性灰。按下轻缩至 97%，释放按指针位置或当前选择复位。分组收起与展开由箭头方向表达。键盘焦点用底部短线提示。逐状态检查背景直边、圆角、内边距、留白和视觉重心，图文组居中，导航行沿起线对齐。记录列顶留 12px，返回点击框 32px，“选择／完成”最小高 32px、内边距上下 4px／左右 8px。禁用控件悬停不改变背景、边框或图标。
- 同组相邻操作按钮的可见底块边缘间隔至少 8 CSS px，常规文字和图文操作按钮两端内留白各至少 8 CSS px。按原尺寸显出完整底块测量。文字、图文和纯图标按钮底块使用公共 12px 圆角，侧栏量内缩后显出的底块。聊天发送与停止回复共用直径 36px 的浅绿圆形底块，悬停和按下叠加 4% 操作绿。
- 最左栏底部为问号帮助与设置。“录音说明”仅由设置正上方的问号按钮打开，检查鼠标提示、可访问名称与焦点返回。右键长按、截图录音与聊天麦克风各自提供对应的录音入口。
- 公共 UI 规则改变时，同步更新规范、公共样式和验收项，使后续设计与检查沿用同一依据。
