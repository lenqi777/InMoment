'use strict';

const CAPABILITY_INFO = Object.freeze({
  cloudEnabled: { version: 'cloudConsentVersion', label: '云端 AI 总开关', description: '发送聊天时，会向 DeepSeek 提供本轮与相关历史的文字、附件和来源线索，包括引用笔记的正文和图片。笔记全文总结使用标题、正文和来源线索，选段总结与改写使用所选文字，改写另附你的要求。分组整理根据所选范围的文字推荐分组。开启设置时不会发送内容。' },
  aiSearchEnabled: { version: 'aiSearchConsentVersion', label: 'AI 描述搜索', description: '发送搜索描述，以及范围内少量候选记录的原话片段、摘要、任务与来源线索，帮助你凭印象查找。一次搜索最多两次请求，输入时不会自动调用。' },
  duplicateAnalysisEnabled: { version: 'duplicateAnalysisConsentVersion', label: 'AI 重复分析', description: '发送选定范围内候选记录的原话片段、摘要、任务与来源线索，比较是否为同一想法。按批处理，只有你确认聚合才建立记录组，原始资料保留。' },
  screenshotAnalysisEnabled: { version: 'screenshotAnalysisConsentVersion', label: '截图辅助理解', description: '允许笔记全文总结和整理把已保存的来源截图发送给 DeepSeek，提取可见应用、页面内容和网址线索。具备图片能力的模型会在全文总结时收到对应截图。截图可能包含个人信息，模糊或截断的网址无法可靠恢复。' },
  noteSelectionContextEnabled: { version: 'noteSelectionContextConsentVersion', label: '选段 AI 使用相邻正文', description: '主动使用笔记的选段总结或改写时，允许把紧邻选区的前文和后文各最多 900 个字符一同发送给 DeepSeek，帮助理解选段和检查改写衔接。此功能的发送范围为所选文字、相邻正文，以及改写时的修改要求。' },
  directAIEnabled: { version: 'directAIConsentVersion', label: '点击即发送', description: '之后每次主动点击批量整理、AI 查找或重复分析，即授权发送该次范围所需的文字与来源线索，不再逐次弹出费用确认。若已单独开启截图辅助理解，批量整理还会发送相应记录已保存的截图。批量最多 100 条，逐条总结后统一归类，最多记录数加一次请求。搜索最多两次请求。使用自己的 DeepSeek 密钥，按输入和输出 tokens 计费，取消无法撤回已发送的内容或费用。可随时关闭。' },
});

function hasDirectConsent(settings) { return settings.directAIEnabled === true && settings.directAIConsentVersion === 1; }
function hasSelectionContextConsent(settings) { return settings.noteSelectionContextEnabled === true && settings.noteSelectionContextConsentVersion === 1; }

function pendingCapabilities(current, fields) {
  const providerChanged = fields.aiProvider !== undefined && fields.aiProvider !== (current.aiProvider || 'deepseek');
  return Object.entries(CAPABILITY_INFO).filter(([key, info]) => (fields[key] ?? (providerChanged ? current[key] : false)) === true && (providerChanged || !(current[key] && (key === 'cloudEnabled' || current[info.version] === 1)))).map(([key]) => key);
}
function assertCapability(settings, key, { networkDisabled = process.env.INMOMENT_DISABLE_NETWORK === '1' } = {}) {
  if (networkDisabled) throw new Error('测试模式已禁用全部真实模型请求。');
  if (!settings.cloudEnabled) throw new Error('请先在设置中确认并开启云端 AI 总开关。');
  const info = CAPABILITY_INFO[key];
  if (!info || !settings[key] || (key !== 'cloudEnabled' && settings[info.version] !== 1)) throw new Error(`请先在设置中确认并启用${info?.label || '所选 AI 功能'}。`);
  if (!settings.hasApiKey) throw new Error('请先在设置中填写当前 AI 服务的 API Key。');
}
function normalizeFilters(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('筛选范围无效。');
  const filters = {};
  for (const key of ['from', 'to']) if (input[key] !== undefined && input[key] !== null && input[key] !== '') {
    const value = Number(input[key]); if (!Number.isSafeInteger(value) || value < 0 || value > 8640000000000000) throw new Error('请选择有效的日期范围。'); filters[key] = value;
  }
  if (filters.from !== undefined && filters.to !== undefined && filters.from >= filters.to) throw new Error('结束日期必须晚于开始日期。');
  if (input.topicIds !== undefined) {
    if (!Array.isArray(input.topicIds) || input.topicIds.length > 30 || input.topicIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(id))) throw new Error('主题筛选无效。');
    filters.topicIds = [...new Set(input.topicIds)];
  }
  for (const key of ['uncategorized', 'unclassified']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new Error('未分类筛选无效。');
  if (input.uncategorized !== undefined && input.unclassified !== undefined && input.uncategorized !== input.unclassified) throw new Error('未分类筛选条件冲突。');
  filters.uncategorized = input.uncategorized === true || input.unclassified === true;
  return filters;
}

module.exports = { CAPABILITY_INFO, pendingCapabilities, assertCapability, normalizeFilters, hasDirectConsent, hasSelectionContextConsent };
