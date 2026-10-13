import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Browser component fixtures execute the same request/navigation helper as the
// app, preserving headers, redirect policy and workspace invalidation behavior.
export const staffWorkspaceClientSource = ts.transpileModule(
    readFileSync(new URL('../../src/lib/staff-workspace-fetch.js', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } },
).outputText;
