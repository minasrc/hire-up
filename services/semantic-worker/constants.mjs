export const MODEL = 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2';
export const INDEX_VERSION = `${MODEL}@e8f8c211226b894fcb81acc59f3b34ba3efd5f42:mean-pool:l2:384:v1`;
export const PROJECTION_VERSION = 'candidate-profile-v1';
export const CV_PROJECTION_VERSION = 'candidate-reviewed-cv-v1';
export const MODEL_CAPABILITY = 'minilm-v1';
export const CV_CAPABILITY = 'approved-cv-v1';
export const CHUNKER_VERSION = 'minilm-utf8-128-v1';
export const CV_CHUNKER_VERSION = 'minilm-cv-lines-128-v1';
export const DIMENSIONS = 384;
export class SemanticWorkerError extends Error {
  constructor(code, status = 0) { super(code); this.code = code; this.status = status; }
}
