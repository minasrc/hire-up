import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as jsxRuntime from 'react/jsx-runtime';
import ts from 'typescript';
const code = ts.transpileModule(readFileSync(new URL('../../src/components/staff-ui/profile-links.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const exports = {};
runInNewContext(code, { exports, require(name) {
    if (name === 'react/jsx-runtime') return jsxRuntime;
    if (name === 'lucide-react') return { Globe: 'svg', Link: 'svg' };
    if (name === 'react-icons/fa6') return { FaGithub: 'svg', FaLinkedinIn: 'svg', FaXTwitter: 'svg' };
    throw new Error(`Unexpected profile-link dependency: ${name}`);
} });
export const profileLinksImports = {
    '@/components/staff-ui/profile-links': exports,
    '@/components/staff-ui/client-roles': { ClientRoles: 'ClientRoles' },
};

const overviewCode = ts.transpileModule(readFileSync(new URL('../../src/components/staff-ui/client-overview.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const overviewExports = {};
runInNewContext(overviewCode, { exports: overviewExports, require(name) {
    if (name === 'react/jsx-runtime') return jsxRuntime;
    if (name === 'next/link') return { default: ({ children, ...props }) => jsxRuntime.jsx('a', { ...props, children }) };
    if (name === './profile-links') return exports;
    if (name === '@/lib/staff-workspace-fetch') return { staffWorkspaceUrl: value => value };
    if (name === '@/app/staff/staff-date') return { StaffDate: ({ value }) => value };
    if (name === '@/components/staff-preview/shared') return { InitialsAvatar: () => null };
    const components = {
        './badge': ['Badge'], './button': ['Button'], './card': ['Card', 'CardContent', 'CardHeader', 'CardTitle'],
        './table': ['Table', 'TableBody', 'TableCell', 'TableHead', 'TableHeader', 'TableRow'],
    };
    if (components[name]) return Object.fromEntries(components[name].map(component => [component, ({ children }) => jsxRuntime.jsx('div', { children })]));
    throw new Error(`Unexpected client-overview dependency: ${name}`);
} });
profileLinksImports['@/components/staff-ui/client-overview'] = overviewExports;
profileLinksImports['@/lib/staff-workspace-fetch'] = { staffWorkspaceUrl: value => value, staffWorkspaceFetch: async () => ({ ok: false }) };
profileLinksImports['@/lib/staff-auth-recovery'] = { staffAuthRecovery: { require: () => {} } };
profileLinksImports['@/components/staff-ui/discard-confirmation'] = { useDiscardConfirmation: () => ({ requestDiscard: (_dirty, action) => action(), discardDialog: null }) };
profileLinksImports['@/components/staff-ui/dialog'] = Object.fromEntries(['Dialog','DialogContent','DialogDescription','DialogHeader','DialogTitle'].map(name => [name, ({ children }) => jsxRuntime.jsx('div', { children })]));
