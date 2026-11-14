'use strict';

const { DEFAULT_PROVIDER, getProvider } = require('./ai-providers.cjs');

const carefulTask = /(?:深入|严谨|完整|逐步)(?:地)?(?:分析|推理|推导|论证|证明)|根因分析|逐条核对|多步推理|(?:证明|推导).{0,24}(?:定理|公式|结论|不等式)|\b(?:rigorous (?:proof|analysis)|step[- ]by[- ]step (?:proof|derivation|reasoning)|root cause analysis)\b/iu;
const evidenceTask = /比较|对比|核对|交叉验证|相互印证|是否一致|是否吻合|矛盾|\b(?:compare|cross[- ]check|reconcile|contradictions?)\b/iu;

function isComplexChat({ userQuestion, sourceCount = 0 } = {}) {
  if (typeof userQuestion !== 'string') return false;
  const question = userQuestion.replace(/(?:不必|不用|无需|不要)\s*(?:深入|严谨|完整|逐步)(?:地)?(?:分析|推理|推导|论证|证明)/gu, '');
  return carefulTask.test(question) || (sourceCount >= 2 && evidenceTask.test(question));
}

function selectChatRoute(provider = DEFAULT_PROVIDER, options = {}) {
  const info = getProvider(provider);
  const complex = isComplexChat(options);
  if (provider === 'deepseek') {
    return { model: complex && !options.hasImages ? 'deepseek-v4-pro' : info.defaultModel, complex };
  }
  if (provider === 'openai') {
    return { model: complex ? 'gpt-5.4' : info.defaultModel, complex };
  }
  if (options.preferFreeModel !== false) {
    return { model: complex ? 'gemini-3.8-flash' : 'gemini-3.1-flash-lite', complex };
  }
  return { model: complex ? 'gemini-4-argon' : info.defaultModel, complex };
}

module.exports = { selectChatRoute, isComplexChat };
