export const MODEL = 'intfloat/multilingual-e5-small';
export const INDEX_VERSION = `${MODEL}@614241f622f53c4eeff9890bdc4f31cfecc418b3:e5-prefix:l2:384:v1`;
export const PROJECTION_VERSION = 'candidate-profile-v1';
export const CV_PROJECTION_VERSION = 'candidate-reviewed-cv-v1';
export const CV_CAPABILITY = 'approved-cv-v1';
export const CHUNKER_VERSION = 'e5-utf8-448-v1';
export const DIMENSIONS = 384;
export class SemanticWorkerError extends Error {
  constructor(code, status = 0) { super(code); this.code = code; this.status = status; }
}
