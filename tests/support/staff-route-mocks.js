import { registerHooks } from 'node:module';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

const stubs = new Map();
let installed = false;

const resolveAliased = (specifier) => {
    const base = join(repoRoot, 'src', specifier.slice(2));
    for (const suffix of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '']) {
        const candidate = `${base}${suffix}`;
        if (existsSync(candidate) && statSync(candidate).isFile()) {
            return pathToFileURL(candidate).href;
        }
    }
    return null;
};

export function stubModule(specifier, members) {
    const lines = [];
    for (const [name, member] of Object.entries(members)) {
        if (member === 'fn') {
            lines.push(
                `export const ${name} = (...args) => globalThis.__routeStub(`
                    + `${JSON.stringify(specifier)}, ${JSON.stringify(name)}, args);`,
            );
        } else if (typeof member === 'object' && member !== null && 'value' in member) {
            lines.push(`export const ${name} = ${JSON.stringify(member.value)};`);
        } else if (typeof member === 'object' && member !== null && 'reexport' in member) {
            lines.push(
                `export { ${name} } from ${JSON.stringify(member.reexport)};`);
        }
    }
    stubs.set(specifier, lines.join('\n'));
}

export function setRouteStub(handler) {
    globalThis.__routeStub = handler;
}

export function installRouteMocks() {
    if (installed) return;
    installed = true;
    stubModule('server-only', {});
    registerHooks({
        resolve(specifier, context, next) {
            if (stubs.has(specifier)) {
                return {
                    url: `route-stub:${encodeURIComponent(specifier)}`,
                    shortCircuit: true,
                };
            }
            if (specifier.startsWith('@/')) {
                const resolved = resolveAliased(specifier);
                if (resolved) return { url: resolved, shortCircuit: true };
            }
            return next(specifier, context);
        },
        load(url, context, next) {
            if (url.startsWith('route-stub:')) {
                const specifier = decodeURIComponent(url.slice('route-stub:'.length));
                const source = stubs.get(specifier) ?? '';
                return { format: 'module', source, shortCircuit: true };
            }
            return next(url, context);
        },
    });
}
