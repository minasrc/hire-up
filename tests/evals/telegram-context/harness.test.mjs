import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fixtures} from './fixtures.mjs';
import {loadImplementation,defaultRoot,offlineReport,assess,validatePolicy} from './harness.mjs';
const root=process.env.TELEGRAM_CONTEXT_EVAL_IMPLEMENTATION_ROOT??defaultRoot;
const contracts=await loadImplementation(root);
test('nine adversarial fixtures and declared structural versus semantic probes validate offline',()=>{
 const report=offlineReport(contracts);assert.equal(report.fixtureCount,9);assert.equal(report.modelQuality,'not_measured');
 const negation=report.cases.find(c=>c.id==='negated-primary-values').probes[0];assert.equal(negation.contractAccepted,true);assert.equal(negation.checks.unsupportedValue,1);
 const ambiguity=report.cases.find(c=>c.id==='reply-identity-ambiguity').probes[0];assert.equal(ambiguity.contractAccepted,true);assert.equal(ambiguity.checks.identityAttribution,1);
});
test('empty model result cannot hide missing explicit primary facts',()=>{
 const f=fixtures.find(f=>f.id==='explicit-primary-own-facts');const score=assess(f,{subjects:[]},contracts);
 assert.equal(score.contractAccepted,true);assert.equal(score.checks.missingExpectedFacts,10);assert.equal(score.checks.valueChecked,0);
});
test('context-only citations and forged sender identity are measured independently',()=>{
 const f=fixtures.find(f=>f.id==='context-prompt-injection');const score=assess(f,f.probes[0].result,contracts);
 assert.equal(score.contractAccepted,false);assert.ok(score.checks.invalidReference>=2);assert.ok(score.checks.unsupportedValue>=2);assert.equal(score.checks.identityAttribution,1);
});
test('nonproduction matching synthetic policy is required before configured provider token reads',()=>{
 const config={providerBaseUrl:'https://synthetic-provider.test/v1',providerModel:'synthetic-model'};
 const policy={environment:'nonproduction',permittedData:['synthetic'],...config,maxProviderCalls:9};assert.doesNotThrow(()=>validatePolicy(policy,config,{}));
 for(const bad of [{...policy,environment:'production'},{...policy,permittedData:['real_private']},{...policy,providerBaseUrl:'https://other.test'},{...policy,maxProviderCalls:10},{...policy,extra:'ignored'}])assert.throws(()=>validatePolicy(bad,config,{}),{code:'NONPRODUCTION_POLICY_REQUIRED'});
 assert.throws(()=>validatePolicy(policy,config,{NODE_ENV:'production'}),{code:'NONPRODUCTION_POLICY_REQUIRED'});
});
test('offline mode ignores configured credentials and never invokes fetch',async()=>{
 const previous=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('unexpected network');};
 try{offlineReport(await loadImplementation(root));assert.equal(calls,0);}finally{globalThis.fetch=previous;}
});
test('CLI rejects incomplete opt-in without printing credential-looking values',()=>{
 const sentinel='SYNTHETIC_SECRET_DO_NOT_LOG';const result=spawnSync(process.execPath,['tests/evals/telegram-context/run.mjs','--provider'],{cwd:defaultRoot,env:{...process.env,TELEGRAM_EXTRACTION_PROVIDER_TOKEN_FILE:sentinel},encoding:'utf8'});
 assert.equal(result.status,1);assert.equal((result.stdout+result.stderr).includes(sentinel),false);assert.match(result.stderr,/INVALID_EVALUATION_ARGUMENTS/);
});

test('identity provenance still needs the explicit self-description quotation',()=>{
 const f=fixtures.find(f=>f.id==='explicit-primary-own-facts');const result=structuredClone(f.expected);result.subjects[0].identity.quote='Madrid';const assessment=assess(f,result,contracts);assert.equal(assessment.contractAccepted,true);assert.equal(assessment.checks.identityAttribution,1);
});
