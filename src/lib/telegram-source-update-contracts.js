import { ClientJobContractError } from './client-job-contracts.js';
import { assertUuid } from './candidate-profile-contracts.js';
import { historyProof, historyWorkerInput } from './telegram-history-contracts.js';
const keys = ['connectionId','generation','connectionLeaseToken','accountUserId'];
export function sourceUpdateInput(action, input) {
  const proof = historyProof(input);
  const allowed = action === 'claim' ? keys : action === 'complete' ? [...keys,'jobId','jobLeaseToken','pageId','records'] : [...keys,'jobId','jobLeaseToken','code','retryAfterSeconds'];
  if (!['claim','complete','defer'].includes(action) || Object.keys(input).some(k => !allowed.includes(k))) throw new ClientJobContractError({ input: 'Invalid source update request.' });
  if (action === 'claim') return { proof };
  const jobId = assertUuid(input.jobId,'jobId'); const jobLeaseToken = assertUuid(input.jobLeaseToken,'jobLeaseToken');
  if (action === 'defer') return { ...historyWorkerInput('defer',input), retryAfterSeconds: input.code === 'FLOOD_WAIT' ? input.retryAfterSeconds : 60 };
  // Reuse the strict history record contract, without inventing a history cursor.
  if (!Array.isArray(input.records) || !input.records.length || input.records.length > 20) throw new ClientJobContractError({ records: 'Invalid source records.' });
  const parsed = historyWorkerInput('complete',{ ...proof,jobId,jobLeaseToken,pageId:input.pageId,fromCursor:{beforeMessageId:null,upperMessageId:null},nextCursor:{beforeMessageId:'1',upperMessageId:'1'},done:false,records:input.records });
  return { proof,jobId,jobLeaseToken,payload:{pageId:parsed.payload.pageId,records:parsed.payload.records} };
}
