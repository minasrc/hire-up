import { createHash, generateKeyPairSync, randomBytes, createCipheriv, createDecipheriv, privateDecrypt, constants } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, lstatSync, chmodSync, openSync, closeSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error('UNSAFE_LOCAL_DIRECTORY');
  chmodSync(path, 0o700);
}
export function readPrivateFile(path, maxBytes = 65536) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) throw new Error('UNSAFE_LOCAL_FILE');
  if (stat.size > maxBytes) throw new Error('LOCAL_FILE_TOO_LARGE');
  return readFileSync(path, 'utf8');
}
function atomicWrite(path, value) {
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  writeFileSync(temporary, value, { flag: 'wx', mode: 0o600 });
  renameSync(temporary, path);
}
export function acquireLock(root) {
  privateDirectory(root);
  const path = join(root, 'connector.lock');
  let descriptor;
  try { descriptor = openSync(path, 'wx', 0o600); } catch { throw new Error('CONNECTOR_ALREADY_LOCKED'); }
  writeFileSync(descriptor, JSON.stringify({ pid: process.pid }));
  closeSync(descriptor);
  return () => { try { unlinkSync(path); } catch { /* Already removed during shutdown. */ } };
}
export function unlockStoppedProcess(root) {
  const path = join(root, 'connector.lock');
  const { pid } = JSON.parse(readPrivateFile(path));
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('INVALID_LOCK');
  try { process.kill(pid, 0); } catch (error) {
    if (error.code === 'ESRCH') { unlinkSync(path); return; }
    throw new Error('CANNOT_VERIFY_LOCK');
  }
  throw new Error('CONNECTOR_STILL_RUNNING');
}
export function createVault({ root, server, workerId }) {
  if (!idPattern.test(workerId)) throw new Error('INVALID_WORKER_ID');
  const scope = `${new URL(server).origin}:${workerId}`;
  privateDirectory(resolve(root));
  const directory = join(resolve(root), createHash('sha256').update(scope).digest('hex'));
  privateDirectory(directory);
  const identityPath = join(directory, 'identity.json');
  if (!existsSync(identityPath)) {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 });
    atomicWrite(identityPath, JSON.stringify({
      privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      publicKeySpki: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      encryptionKey: randomBytes(32).toString('base64'),
    }));
  }
  const identity = JSON.parse(readPrivateFile(identityPath));
  const encryptionKey = Buffer.from(identity.encryptionKey, 'base64');
  const file = (id) => { if (!idPattern.test(id)) throw new Error('INVALID_CONNECTION_ID'); return join(directory, `${id}.json`); };
  const historyFile = (connectionId, accountId, key, create = false) => {
    if (!idPattern.test(connectionId) || !/^[1-9][0-9]{0,29}$/.test(accountId) || !/^[a-zA-Z0-9:_-]{1,200}$/.test(key)) throw new Error('INVALID_HISTORY_SCOPE');
    const connectionDirectory = join(directory, 'history', connectionId);
    const accountDirectory = join(connectionDirectory, createHash('sha256').update(accountId).digest('hex'));
    if (create) { privateDirectory(join(directory, 'history')); privateDirectory(connectionDirectory); privateDirectory(accountDirectory); }
    return join(accountDirectory, `${createHash('sha256').update(key).digest('hex')}.json`);
  };
  return {
    publicKeySpki: identity.publicKeySpki,
    saveHistory(connectionId, accountId, key, record) {
      const json = JSON.stringify(record);
      if (Buffer.byteLength(json) > 524288) throw new Error('HISTORY_CACHE_TOO_LARGE');
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
      cipher.setAAD(Buffer.from(`${scope}:history:${connectionId}:${accountId}:${key}`));
      const ciphertext = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
      atomicWrite(historyFile(connectionId, accountId, key, true), JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }));
    },
    loadHistory(connectionId, accountId, key) {
      const path = historyFile(connectionId, accountId, key);
      if (!existsSync(path)) return null;
      const record = JSON.parse(readPrivateFile(path, 750000));
      const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(record.iv, 'base64'));
      decipher.setAAD(Buffer.from(`${scope}:history:${connectionId}:${accountId}:${key}`));
      decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
    },
    removeHistoryRecord(connectionId, accountId, key) {
      try { unlinkSync(historyFile(connectionId, accountId, key)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    },
    removeHistory(connectionId) {
      if (!idPattern.test(connectionId)) throw new Error('INVALID_CONNECTION_ID');
      rmSync(join(directory, 'history', connectionId), { recursive: true, force: true });
    },
    save(id, record) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
      cipher.setAAD(Buffer.from(`${scope}:${id}`));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(record), 'utf8'), cipher.final()]);
      atomicWrite(file(id), JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }));
    },
    load(id) {
      if (!existsSync(file(id))) return null;
      const saved = JSON.parse(readPrivateFile(file(id)));
      const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(saved.iv, 'base64'));
      decipher.setAAD(Buffer.from(`${scope}:${id}`));
      decipher.setAuthTag(Buffer.from(saved.tag, 'base64'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(saved.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
    },
    remove(id) { try { unlinkSync(file(id)); } catch (error) { if (error.code !== 'ENOENT') throw error; } },
    decryptPassword(task) {
      if (!/^[A-Za-z0-9+/]{342}==$/.test(task.passwordCiphertext ?? '')) throw new Error('PASSWORD_INVALID');
      const clear = privateDecrypt({ key: identity.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256', oaepLabel: Buffer.from(`agora-telegram:${task.id}:${task.generation}:${task.challengeId}`) }, Buffer.from(task.passwordCiphertext, 'base64'));
      if (clear.length < 1 || clear.length > 128) { clear.fill(0); throw new Error('PASSWORD_INVALID'); }
      return clear;
    },
  };
}
