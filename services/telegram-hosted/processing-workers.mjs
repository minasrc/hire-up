import { join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { privateDirectory, readPrivateJson } from './store.mjs';
import { loadConfig as loadExtraction } from '../telegram-extraction-worker/config.mjs';
import { loadConfig as loadCv } from '../cv-analysis-worker/config.mjs';
import { loadConfig as loadSemantic } from '../semantic-worker/config.mjs';
import { requestJson as extractionRequest } from '../telegram-extraction-worker/transport.mjs';
import { requestJson as cvRequest, createContentReader } from '../cv-analysis-worker/transport.mjs';
import { requestJson as semanticRequest } from '../semantic-worker/transport.mjs';
import { createExtractionWorker } from '../telegram-extraction-worker/worker.mjs';
import { createProvider } from '../telegram-extraction-worker/provider.mjs';
import { createPendingStore as extractionStore } from '../telegram-extraction-worker/store.mjs';
import { createCvAnalysisWorker } from '../cv-analysis-worker/worker.mjs';
import { createCvAnalysisProvider } from '../cv-analysis-worker/provider.mjs';
import { createPendingStore as cvStore } from '../cv-analysis-worker/vault.mjs';
import { runIsolatedParser } from '../cv-analysis-worker/sandbox.mjs';
import { createSemanticWorker } from '../semantic-worker/worker.mjs';
import { createLocalClient } from '../semantic-worker/local.mjs';
import { createPendingStore as semanticStore } from '../semantic-worker/store.mjs';

export async function createProcessingWorkers(config) {
  for (const key of ['extractionConfigFile', 'cvAnalysisConfigFile', 'semanticConfigFile']) if (!isAbsolute(config[key] ?? '')) throw new Error('INVALID_LOCAL_CONFIG');
  // Templates describe shared providers only. Their legacy account credential
  // is not read or used; each task authenticates with its registered scope.
  const [extraction, cv, semantic] = await Promise.all([
    loadExtraction(config.extractionConfigFile, {}), loadCv(config.cvAnalysisConfigFile, {}), loadSemantic(config.semanticConfigFile, {}),
  ]);
  if ([extraction, cv, semantic].some(settings => settings.serverUrl !== config.server)) throw new Error('LOCAL_SCOPE_CONFLICT');
  return async record => {
    const initial = readPrivateJson(record.credentialPath);
    const workerToken = initial.token;
    const checkToken = async () => {
      const current = readPrivateJson(record.credentialPath);
      if (current.server !== config.server || current.workerId !== record.workerId
        || current.requestId !== record.requestId || current.organizationId !== record.organizationId
        || current.ownerUserId !== record.ownerUserId || current.token !== workerToken
        || createHash('sha256').update(workerToken).digest('hex') !== record.tokenSha256) {
        const error = new Error('CREDENTIAL_UNAVAILABLE'); error.code = error.message; error.status = 401; throw error;
      }
    };
    await checkToken();
    const state = kind => privateDirectory(join(record.stateDirectory, `processing-${kind}`));
    const host = (path, request, options) => async (action, body, { signal } = {}) => {
      await checkToken();
      return request(`${config.server}${path}/${action}`, workerToken, body, { ...options(action, body), signal });
    };
    return {
      extraction: createExtractionWorker({ host: host('/api/telegram-extraction/worker', extractionRequest, action => ({ maxRequestBytes: 131072, maxResponseBytes: action === 'claim' ? 524288 : 262144 })),
        provider: createProvider(extraction), pendingStore: extractionStore({ root: state('extraction'), server: config.server, workerToken }) }),
      cv: createCvAnalysisWorker({ host: host('/api/cv-analysis/worker', cvRequest, (action, body) => ({ timeoutMs: 15000, maxRequestBytes: body.stage === 'parse' && action === 'complete' ? 1048576 : 131072, maxResponseBytes: action === 'claim' ? 1048576 : 131072 })),
        readContent: createContentReader({ serverUrl: config.server, workerToken, checkToken }),
        parse: (bytes, options) => runIsolatedParser(bytes, { ...options, image: cv.parserImage }), extract: createCvAnalysisProvider(cv),
        vault: cvStore({ root: state('cv'), server: config.server, workerToken }) }),
      semantic: createSemanticWorker({ host: host('/api/profile-search/worker', semanticRequest, action => ({ timeoutMs: action === 'complete' ? 20000 : 10000 })),
        ...createLocalClient(semantic), vault: semanticStore({ root: state('semantic'), server: config.server, workerToken }) }),
    };
  };
}
