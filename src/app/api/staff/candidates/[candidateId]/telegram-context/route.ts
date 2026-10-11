import { staffApiContext,staffGateResponse } from '@/lib/staff-api.server';
import { telegramCandidateContext } from '@/lib/telegram-candidate-context-operations';
import { telegramErrorResponse,telegramFeatureResponse,telegramJson } from '@/lib/telegram-intake-http';
export const runtime='nodejs';
export async function GET(request:Request,{params}:{params:Promise<{candidateId:string}>}) {
 const disabled=telegramFeatureResponse();if(disabled)return disabled;
 try {
  const context=await staffApiContext();const denied=staffGateResponse(context);if(denied){denied.headers.set('cache-control','private, no-store');return denied;}
  const query=new URL(request.url).searchParams;
  if([...query.keys()].some(k=>k!=='after')||query.getAll('after').length>1)return telegramJson({error:'Invalid provenance request.'},400);
  const {candidateId}=await params;
  return telegramJson(await telegramCandidateContext(context.pool,context.identity,context.organizationId,candidateId,query.get('after')));
 } catch(error){return telegramErrorResponse(error);}
}
