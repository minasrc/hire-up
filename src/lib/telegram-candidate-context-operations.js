import { withStaffTransaction } from './staff-authorization.js';
import { assertUuid } from './candidate-profile-contracts.js';
export function telegramCandidateContext(pool,identity,org,candidateId,after=null) {
 const id=assertUuid(candidateId,'candidateId'); const cursor=after==null?null:assertUuid(after,'after');
 return withStaffTransaction(pool,identity,org,['candidates.read'],async({client})=>(await client.query('select app.telegram_candidate_context_v1($1::uuid,$2::uuid) as result',[id,cursor])).rows[0].result);
}
