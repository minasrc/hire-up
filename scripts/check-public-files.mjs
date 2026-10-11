import { execFileSync } from 'node:child_process';

const files = execFileSync('git', ['ls-files', '-z'], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
}).split('\0').filter(Boolean);

const forbidden = files.filter((file) => file.split('/').some((part) =>
    (part === '.env' || part.startsWith('.env.')) && part !== '.env.example'
    || part === '.next' || part === '.runtime' || part === 'credential.json'
    || /\.session(?:-journal)?$/.test(part)));

if (forbidden.length) {
    console.error('Remove local secrets or generated runtime files from the commit:');
    for (const file of forbidden) console.error(file);
    process.exitCode = 1;
} else {
    console.log('Tracked files contain no prohibited environment or runtime files.');
}
