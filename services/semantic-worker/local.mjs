import { CHUNKER_VERSION, INDEX_VERSION, MODEL, SemanticWorkerError } from './constants.mjs';
import { readToken } from '../telegram-extraction-worker/config.mjs';
import { requestJson } from './transport.mjs';

export const embeddingBody = (texts, inputType) => ({ model: MODEL, input: texts, input_type: inputType, encoding_format: 'float' });
export function createLocalClient({ embeddingUrl, embeddingTokenFile, fetchImpl = fetch }) {
  async function request(path, body, options, maxRequestBytes = 131072) {
    return requestJson(`${embeddingUrl}${path}`, await readToken(embeddingTokenFile), body, { ...options, fetchImpl, timeoutMs: 60000, maxRequestBytes });
  }
  return {
    plan: ({ text, chunkerVersion = CHUNKER_VERSION }, options) => request('/v1/chunk-plan', { model: MODEL, chunker_version: chunkerVersion, text }, options, 1048576),
    async embed({ texts, inputType }, options) {
      const embeddings = [];
      for (let offset = 0; offset < texts.length;) {
        const batch = [];
        while (offset + batch.length < texts.length && batch.length < 8) {
          const next = texts[offset + batch.length];
          if (Buffer.byteLength(JSON.stringify(embeddingBody([...batch, next], inputType))) > 131072) break;
          batch.push(next);
        }
        if (!batch.length) throw new SemanticWorkerError('INVALID_RESULT');
        const result = await request('/v1/embeddings', embeddingBody(batch, inputType), options);
        if (result?.model !== MODEL || result?.index_version !== INDEX_VERSION || !Array.isArray(result.data) || result.data.length !== batch.length || result.data.some((item, i) => item.index !== i || !Array.isArray(item.embedding))) throw new SemanticWorkerError('INVALID_RESULT');
        embeddings.push(...result.data.map(item => item.embedding));
        offset += batch.length;
      }
      return { indexVersion: INDEX_VERSION, embeddings };
    },
  };
}
