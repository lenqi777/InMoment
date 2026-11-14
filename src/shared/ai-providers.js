'use strict';
((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.InMomentAIProviders = api.PROVIDERS;
})(typeof window === 'object' ? window : globalThis, () => {
  const DEFAULT_PROVIDER = 'deepseek';
  const PROVIDERS = Object.freeze(Object.fromEntries([
    { id:'deepseek', label:'DeepSeek', defaultModel:'deepseek-flash', models:['deepseek-flash','deepseek-v4-pro'] },
    { id:'openai', label:'OpenAI（GPT）', defaultModel:'gpt-5.4-mini', models:[
      'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna',
      'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.2',
    ] },
    { id:'gemini', label:'Google Gemini', defaultModel:'gemini-3.8-flash', models:['gemini-3.8-flash','gemini-3.1-flash-lite','gemini-4-argon'] },
  ].map(provider => [provider.id, Object.freeze({ ...provider, models:Object.freeze(provider.models) })])));
  function getProvider(id = DEFAULT_PROVIDER) { if (!Object.hasOwn(PROVIDERS, id)) throw new Error('请选择受支持的 AI 服务。'); return PROVIDERS[id]; }
  function validateModel(model) { if (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u.test(model.trim())) throw new Error('模型名称应为 1–100 个字母、数字或 . _ : -。'); return model.trim(); }
  function supportsImages(provider, model) {
    getProvider(provider);
    if (provider === 'deepseek') return model === 'deepseek-flash';
    if (provider === 'openai') return /^(?:ft:)?gpt-(?:4o|4\.1|5|6)(?:[.:-]|$)/u.test(model);
    return /^gemini-(?:[3-9](?:[.-]|$)|2\.5(?:[.-]|$))/u.test(model) && !/tts|live|audio/u.test(model);
  }
  function openAIReasoningEffort(model, effort = 'fast') {
    if (!/^gpt-(?:5\.[2456]|6(?:\.1)?)(?:[.-]|$)/u.test(model) || /-pro(?:-|$)/u.test(model)) return undefined;
    if (effort === 'deep') return 'high';
    if (effort === 'standard') return 'medium';
    return /^gpt-(?:6-astra|6\.1-sol)(?:-|$)/u.test(model) ? 'low' : 'none';
  }
  return { DEFAULT_PROVIDER, PROVIDERS, getProvider, validateModel, supportsImages, openAIReasoningEffort };
});
