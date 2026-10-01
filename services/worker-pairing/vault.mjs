import { constants, fstatSync, mkdirSync, lstatSync, openSync, closeSync, readFileSync, writeFileSync, fsyncSync, renameSync, unlinkSync, readdirSync, linkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve, join, dirname, parse } from 'node:path';
import { PairingError, credential } from './protocol.mjs';
function stat(path) { try { return lstatSync(path); } catch (e) { if (e.code === 'ENOENT') return null; throw new PairingError('UNSAFE_LOCAL_FILE'); } }
function directories(path, create = false) {
  let part = parse(path).root;
  for (const segment of path.slice(part.length).split('/').filter(Boolean)) {
    part = join(part, segment); let s = stat(part);
    if (!s && create) { mkdirSync(part, { mode: 0o700 }); s = stat(part); }
    if (!s?.isDirectory() || s.isSymbolicLink()) throw new PairingError('UNSAFE_LOCAL_DIRECTORY');
  }
  const s = stat(path);
  if (s.uid !== process.getuid() || (s.mode & 0o077)) throw new PairingError('UNSAFE_LOCAL_DIRECTORY');
}
export function readCredentialFile(path) { return credential(readJson(resolve(path))); }
function readJson(path, parseJson = true, lockLink = false) {
  directories(dirname(path)); let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); const s = fstatSync(fd);
    if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o077) || s.size > 8192 || (s.nlink !== 1 && !(lockLink && s.nlink === 2))) throw new Error();
    const text = readFileSync(fd, 'utf8'); return parseJson ? JSON.parse(text) : text;
  } catch { throw new PairingError('UNSAFE_LOCAL_FILE'); } finally { if (fd !== undefined) closeSync(fd); }
}
export function createPairingStore({ directory }) {
  const root = resolve(directory); directories(root, true);
  const file = key => join(root, key);
  // Our process lock serializes publication. Reap only our private staging files
  // after a crash; they may contain an invitation or verifier.
  function reapStaging() {
    for (const entry of readdirSync(root)) if (/^\.[a-f0-9]{24}\.tmp$/.test(entry)) {
      readJson(file(entry), false); unlinkSync(file(entry));
    }
  }
  function syncDirectory() { const fd = openSync(root, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
  function read(key) { return stat(file(key)) ? readJson(file(key)) : null; }
  function write(key, value, exclusive = false) {
    directories(root); if (stat(file(key))) { readJson(file(key)); if (exclusive) throw new PairingError('LOCAL_STATE_EXISTS'); }
    const temporary = file(`.${randomBytes(12).toString('hex')}.tmp`); let fd;
    try {
      fd = openSync(temporary, 'wx', 0o600); writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); closeSync(fd); fd = undefined;
      if (exclusive && stat(file(key))) throw new PairingError('LOCAL_STATE_EXISTS');
      renameSync(temporary, file(key));
      syncDirectory();
    } catch (e) { if (e instanceof PairingError) throw e; throw new PairingError('LOCAL_WRITE_FAILED'); }
    finally { if (fd !== undefined) closeSync(fd); if (stat(temporary)) unlinkSync(temporary); }
  }
  return {
    credentialPath: file('credential.json'),
    loadPending: () => read('pending.json'),
    loadCredential: () => { const c = read('credential.json'); return c ? credential(c) : null; },
    savePending: state => write('pending.json', state),
    initialize(state) { if (read('credential.json') || read('pending.json')) throw new PairingError('LOCAL_STATE_EXISTS'); write('pending.json', state, true); },
    finalize(value) {
      credential(value); const existing = read('credential.json');
      if (existing && JSON.stringify(existing) !== JSON.stringify(value)) throw new PairingError('LOCAL_STATE_EXISTS');
      if (!existing) write('credential.json', value, true);
      if (stat(file('pending.json'))) { readJson(file('pending.json')); unlinkSync(file('pending.json')); syncDirectory(); }
    },
    lock() {
      directories(root);
      const temporary = file(`.${randomBytes(12).toString('hex')}.tmp`); let fd; let published = false;
      try {
        fd = openSync(temporary, 'wx', 0o600); writeFileSync(fd, JSON.stringify({ pid: process.pid })); fsyncSync(fd); closeSync(fd); fd = undefined;
        // link is atomic and exclusive: a crash exposes a complete PID or no lock.
        // A crash before staging unlink leaves two links; unlock accepts that only
        // for this PID-only lock, never for credential or pending-secret files.
        try { linkSync(temporary, file('pairing.lock')); published = true; } catch (error) { if (error.code === 'EEXIST') throw new PairingError('PAIRING_ALREADY_RUNNING'); throw error; }
        syncDirectory(); unlinkSync(temporary); syncDirectory(); reapStaging();
      } catch (error) {
        if (published) unlinkSync(file('pairing.lock'));
        if (error instanceof PairingError) throw error;
        throw new PairingError('LOCAL_WRITE_FAILED');
      } finally { if (fd !== undefined) closeSync(fd); if (stat(temporary)) unlinkSync(temporary); }
      return () => { unlinkSync(file('pairing.lock')); syncDirectory(); };
    },
    unlock() {
      const lock = stat(file('pairing.lock')) ? readJson(file('pairing.lock'), true, true) : null; if (!lock || !Number.isSafeInteger(lock.pid) || lock.pid < 1) throw new PairingError('INVALID_LOCAL_STATE');
      try { process.kill(lock.pid, 0); } catch (e) { if (e.code === 'ESRCH') { unlinkSync(file('pairing.lock')); return; } throw new PairingError('CANNOT_VERIFY_LOCK'); }
      throw new PairingError('PAIRING_ALREADY_RUNNING');
    },
  };
}
