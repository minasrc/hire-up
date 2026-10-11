import { fixtures } from './fixtures.mjs';
import { resolve } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
const asciiFold=v=>v.replace(/[A-Z]/g,c=>c.toLowerCase());
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&asciiFold(a)===asciiFold(b);
const bounded=(v,max)=>Array.isArray(v)?v.slice(0,max):[];
export const defaultRoot=fileURLToPath(new URL('../../../',import.meta.url));
export async function loadImplementation(root=defaultRoot){
 const contracts=await import(pathToFileURL(resolve(root,'src/lib/telegram-extraction-contracts.js')).href);
 if(contracts.EXTRACTION_CONTEXT_SCHEMA_VERSION!=='candidate-extraction-v2'||typeof contracts.literalPrimaryValue!=='function')throw Object.assign(new Error(),{code:'V2_CHECKPOINT_REQUIRED'});
 return contracts;
}
// Exact-reference checks and curated oracle checks are deliberately separate.
// Literal references cannot establish negation, truth, or candidate authorship.
export function assess(fixture,result,contracts){
 const primary=new Map(fixture.source.messages.map(m=>[m.messageId,m]));
 const checks={referenceChecked:0,invalidReference:0,valueChecked:0,unsupportedLiteralValue:0,unsupportedValue:0,identityChecked:0,identityAttribution:0,missingExpectedFacts:0};
 const observed=[];let scoringTruncated=false;
 const reference=e=>{checks.referenceChecked++;const m=primary.get(e?.messageId);const valid=m&&typeof e?.quote==='string'&&e.quote.trim()&&e.quote.length<=2000&&m.text.includes(e.quote);if(!valid)checks.invalidReference++;return Boolean(valid);};
 const subjects=bounded(result?.subjects,12);if(!Array.isArray(result?.subjects)||result.subjects.length>12)scoringTruncated=true;
 for(const subject of subjects){
  if(!Array.isArray(subject?.facts)||subject.facts.length>12)scoringTruncated=true;
  for(const f of bounded(subject?.facts,12)){
   const evidence=bounded(f?.evidence,3);if(!Array.isArray(f?.evidence)||f.evidence.length>3)scoringTruncated=true;
   const validEvidence=evidence.filter(reference);
   const values=Array.isArray(f?.value)?bounded(f.value,9):[f?.value];if(Array.isArray(f?.value)&&f.value.length>9)scoringTruncated=true;
   for(const value of values){
    checks.valueChecked++;
    if(typeof value!=='string'||!validEvidence.some(e=>contracts.literalPrimaryValue(e.quote,value)))checks.unsupportedLiteralValue++;
    if(!bounded(fixture.oracle.allowedValues[f?.field],12).some(v=>same(v,value)))checks.unsupportedValue++;
    observed.push({field:f?.field,value});
   }
  }
  const identity=subject?.identity;
  if(identity!==null){
   checks.identityChecked++;let valid=false;
   if(identity?.kind==='telegram_sender'){
    reference(identity);const m=primary.get(identity.messageId);
    valid=fixture.oracle.senderMessages.includes(identity.messageId)&&m?.sender?.peer?.kind==='user'&&m.forwardedFrom===null&&typeof identity.quote==='string'&&m.text.includes(identity.quote)&&identity.quote.includes(fixture.oracle.senderDescriptions[identity.messageId]);
   }else if(identity?.kind==='email')valid=fixture.oracle.emails.some(email=>same(email,identity.email));
   if(!valid)checks.identityAttribution++;
  }
  if(!Array.isArray(subject?.attachments)||subject.attachments.length>8)scoringTruncated=true;
  for(const a of bounded(subject?.attachments,8)){checks.referenceChecked++;const m=primary.get(a?.messageId);if(!m||!Number.isInteger(a?.attachmentIndex)||a.attachmentIndex<0||!m.attachments[a.attachmentIndex])checks.invalidReference++;}
 }
 for(const required of fixture.oracle.requiredFacts)if(!observed.some(f=>f.field===required.field&&same(f.value,required.value)))checks.missingExpectedFacts++;
 let contractAccepted=false;let reviewableResult=null;try{reviewableResult=contracts.validateExtractionResult(result,fixture.source);contractAccepted=true;}catch{}
 // Only structurally accepted, primary-quoted synthetic values are reportable.
 // Rejected raw output and provider error bodies never enter reports.
 return {contractAccepted,scoringTruncated,checks,reviewableResult,humanReview:fixture.humanReview};
}
export function validateFixtures(contracts){
 if(fixtures.length!==9||new Set(fixtures.map(f=>f.id)).size!==fixtures.length)throw Object.assign(new Error(),{code:'INVALID_FIXTURE'});
 return fixtures.map(f=>{
  if(f.source.messages.length<1||f.source.messages.length>40||f.source.contextOnly.length>8||Buffer.byteLength(JSON.stringify(f.source.contextOnly))>8192||Buffer.byteLength(JSON.stringify(f.source))>49152)throw Object.assign(new Error(),{code:'INVALID_FIXTURE'});
  const ids=[...f.source.messages,...f.source.contextOnly].map(m=>m.messageId);if(new Set(ids).size!==ids.length)throw Object.assign(new Error(),{code:'INVALID_FIXTURE'});
  const expected=assess(f,f.expected,contracts);
  if(!expected.contractAccepted||expected.checks.invalidReference||expected.checks.unsupportedLiteralValue||expected.checks.unsupportedValue||expected.checks.identityAttribution||expected.checks.missingExpectedFacts)throw Object.assign(new Error(),{code:'INVALID_FIXTURE_ORACLE'});
  const probes=f.probes.map(p=>{const assessment=assess(f,p.result,contracts);if(assessment.contractAccepted!==(p.contract==='accept')||p.flags.some(flag=>assessment.checks[flag]<1))throw Object.assign(new Error(),{code:'INVALID_PROBE'});return{name:p.name,expectedContract:p.contract,...assessment};});
  return {id:f.id,expectedContractAccepted:true,probes,humanReview:f.humanReview};
 });
}
export function offlineReport(contracts){return{mode:'offline_fixture_validation',schemaVersion:'candidate-extraction-v2',modelQuality:'not_measured',fixtureCount:fixtures.length,cases:validateFixtures(contracts)};}
export function validatePolicy(policy,config,environment=process.env){
 const keys=['environment','permittedData','providerBaseUrl','providerModel','maxProviderCalls'];
 if(environment.NODE_ENV==='production'||!policy||Object.keys(policy).length!==keys.length||keys.some(k=>!Object.hasOwn(policy,k))||policy.environment!=='nonproduction'||!Array.isArray(policy.permittedData)||policy.permittedData.length!==1||policy.permittedData[0]!=='synthetic'||policy.providerBaseUrl!==config.providerBaseUrl||policy.providerModel!==config.providerModel||policy.maxProviderCalls!==fixtures.length)throw Object.assign(new Error(),{code:'NONPRODUCTION_POLICY_REQUIRED'});
}
export async function providerReport({implementationRoot=defaultRoot,workerConfig,dataPolicy,environment=process.env}){
 const contracts=await loadImplementation(implementationRoot);validateFixtures(contracts);
 const configModule=await import(pathToFileURL(resolve(implementationRoot,'services/telegram-extraction-worker/config.mjs')).href);
 const providerModule=await import(pathToFileURL(resolve(implementationRoot,'services/telegram-extraction-worker/provider.mjs')).href);
 const {requestJson}=await import(pathToFileURL(resolve(implementationRoot,'services/telegram-extraction-worker/transport.mjs')).href);
 // Existing configured provider, private token-file reader and bounded production
 // transport. No hosted worker endpoint, Telegram RPC, database or import occurs.
 const config=await configModule.loadConfig(workerConfig,environment);
 let policy;try{policy=JSON.parse(await configModule.readPrivateFile(resolve(dataPolicy)));}catch{throw Object.assign(new Error(),{code:'NONPRODUCTION_POLICY_REQUIRED'});}
 validatePolicy(policy,config,environment);
 const token=await configModule.readToken(config.providerTokenFile);
 const cases=[];
 for(const fixture of fixtures){
  try{
   const request=providerModule.extractionRequest(config.providerModel,fixture.source,'candidate-extraction-v2');
   const response=await requestJson(`${config.providerBaseUrl}/chat/completions`,token,request,{timeoutMs:60000,maxRequestBytes:131072,maxResponseBytes:262144});
   const choice=response?.choices?.[0];const message=choice?.message;
   if(!Array.isArray(response?.choices)||response.choices.length!==1||choice.finish_reason!=='stop'||message?.refusal||message?.function_call||(message?.tool_calls!=null&&(!Array.isArray(message.tool_calls)||message.tool_calls.length))||typeof message?.content!=='string')throw Object.assign(new Error(),{code:'INVALID_RESPONSE'});
   let result;try{result=JSON.parse(message.content);}catch{throw Object.assign(new Error(),{code:'INVALID_RESPONSE'});}
   cases.push({id:fixture.id,status:'measured',...assess(fixture,result,contracts)});
  }catch(error){cases.push({id:fixture.id,status:'not_measured',errorCode:['HTTP_UNAVAILABLE','INVALID_RESPONSE','INVALID_PAYLOAD','STOPPED'].includes(error.code)?error.code:'PROVIDER_UNAVAILABLE',checks:null,humanReview:fixture.humanReview});}
 }
 const totals={measuredCases:0,failedCalls:0,contractAcceptedCases:0,referenceChecked:0,invalidReference:0,valueChecked:0,unsupportedLiteralValue:0,unsupportedValue:0,identityChecked:0,identityAttribution:0,missingExpectedFacts:0};
 for(const c of cases){if(!c.checks){totals.failedCalls++;continue;}totals.measuredCases++;if(c.contractAccepted)totals.contractAcceptedCases++;for(const k of Object.keys(c.checks))totals[k]+=c.checks[k];}
 return{mode:'opt_in_provider_evaluation',schemaVersion:'candidate-extraction-v2',promptVersion:'candidate-extraction-prompt-v2',configuredModel:config.providerModel,fixtureCount:fixtures.length,providerCalls:fixtures.length,modelQuality:'requires_human_acceptance',totals,cases};
}
