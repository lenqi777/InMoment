'use strict';
const { parentPort, workerData } = require('node:worker_threads');
let extractor;
let queue = Promise.resolve();
async function embed(texts) {
  if (!extractor) {
    const { env, pipeline } = await import('@huggingface/transformers');
    env.allowRemoteModels = false; env.allowLocalModels = true; env.useFSCache = false;
    extractor = await pipeline('feature-extraction', workerData.modelDirectory, { local_files_only: true, dtype: 'q8', device: 'cpu' });
  }
  const output = await extractor(texts, { pooling: 'mean', normalize: true, truncation: true, max_length: 512 });
  return output.tolist();
}
parentPort.on('message', message => {
  queue = queue.then(async () => {
    try { parentPort.postMessage({ id: message.id, vectors: await embed(message.texts) }); }
    catch { parentPort.postMessage({ id: message.id, error: '本地语义模型未能加载或推理，请检查模型组件或重新安装。' }); }
  });
});
