#!/usr/bin/env node
import {isAbsolute} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {loadImplementation,offlineReport,providerReport} from './harness.mjs';
const help=`Node22 Telegram context evaluation (synthetic fixtures only)
Default: node tests/evals/telegram-context/run.mjs
Options: --implementation-root /checkout --output /new/private/report.json
Provider opt-in: --provider --worker-config /private/extraction.json --data-policy /private/evaluation-policy.json
Provider mode makes at most nine serial requests to the existing configured extraction provider. It requires a matching nonproduction synthetic-data policy. No hosted worker, Telegram, database or import calls occur.`;
try{
 const options={};const args=process.argv.slice(2);
 for(let i=0;i<args.length;i++){
  const key=args[i];if(key==='--help'){process.stdout.write(help+'\n');process.exit(0);}
  if(key==='--provider'){if(options.provider)throw new Error();options.provider=true;continue;}
  if(!['--implementation-root','--output','--worker-config','--data-policy'].includes(key)||Object.hasOwn(options,key)||!args[i+1]||!isAbsolute(args[i+1]))throw new Error();options[key]=args[++i];
 }
 if(!options.provider&&(options['--worker-config']||options['--data-policy']))throw new Error();
 if(options.provider&&(!options['--worker-config']||!options['--data-policy']))throw new Error();
 const root=options['--implementation-root'];
 const report=options.provider?await providerReport({implementationRoot:root,workerConfig:options['--worker-config'],dataPolicy:options['--data-policy']}):offlineReport(await loadImplementation(root));
 const json=JSON.stringify(report,null,2)+'\n';
 if(options['--output'])await writeFile(options['--output'],json,{flag:'wx',mode:0o600});
 process.stdout.write(json);
}catch(error){const code=/^[A-Z_]{1,60}$/.test(error.code??'')?error.code:'INVALID_EVALUATION_ARGUMENTS';process.stderr.write(`Evaluation stopped: ${code}. No secrets or provider error bodies are logged. Use --help.\n`);process.exitCode=1;}
