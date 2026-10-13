import { createHash, generateKeyPairSync, randomBytes, createCipheriv, createDecipheriv, privateDecrypt, constants } from 'node:crypto';
import * as filesystem from 'node:fs';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, lstatSync, chmodSync, openSync, closeSync, rmSync, fstatSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function privateDirectory(path) {
  if (!existsSync(path)) {
    const parent = dirname(resolve(path));
    if (!existsSync(parent)) privateDirectory(parent);
    mkdirSync(path, { mode: 0o700 });
    syncDirectory(dirname(resolve(path)));
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw new Error('UNSAFE_LOCAL_DIRECTORY');
  chmodSync(path, 0o700);
}
export function readPrivateFile(path, maxBytes = 65536) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) throw new Error('UNSAFE_LOCAL_FILE');
  if (stat.size > maxBytes) throw new Error('LOCAL_FILE_TOO_LARGE');
  if (stat.nlink !== 1) throw new Error('UNSAFE_LOCAL_FILE');
  const fd = openSync(path, filesystem.constants.O_RDONLY | filesystem.constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.nlink !== 1) throw new Error('UNSAFE_LOCAL_FILE');
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}
function syncDirectory(path, fs = filesystem) {
  const descriptor = fs.openSync(path, fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}
// The old record stays intact until the replacement is fully flushed. A rename
// followed by directory fsync makes a returned success durable across restart.
export function atomicWrite(path, value, fs = filesystem) {
  const parent = dirname(path);
  const stat = fs.lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('UNSAFE_LOCAL_DIRECTORY');
  if (fs.existsSync(path)) {
    const target = fs.lstatSync(path);
    if (!target.isFile() || target.isSymbolicLink() || target.uid !== process.getuid() || (target.mode & 0o077) || target.nlink !== 1) throw new Error('UNSAFE_LOCAL_FILE');
  }
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(descriptor, value);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = undefined;
    fs.renameSync(temporary, path);
    syncDirectory(parent, fs);
  } finally {
    try { if (descriptor !== undefined) fs.closeSync(descriptor); }
    finally {
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
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
    saveCvChunk(connectionId, accountId, jobId, index, bytes) {
      if (!idPattern.test(jobId) || !Number.isInteger(index) || index < 0 || index > 7 || !Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 524288) throw new Error('INVALID_CV_CHUNK');
      const key = `cv:${jobId}:chunk:${index}`;
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
      cipher.setAAD(Buffer.from(`${scope}:cv:${connectionId}:${accountId}:${key}`));
      const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
      atomicWrite(historyFile(connectionId, accountId, key, true), JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }));
    },
    loadCvChunk(connectionId, accountId, jobId, index) {
      if (!idPattern.test(jobId) || !Number.isInteger(index) || index < 0 || index > 7) throw new Error('INVALID_CV_CHUNK');
      const key = `cv:${jobId}:chunk:${index}`;
      const record = JSON.parse(readPrivateFile(historyFile(connectionId, accountId, key), 750000));
      const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(record.iv, 'base64'));
      decipher.setAAD(Buffer.from(`${scope}:cv:${connectionId}:${accountId}:${key}`));
      decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
      const bytes = Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64')), decipher.final()]);
      if (!bytes.length || bytes.length > 524288) throw new Error('INVALID_CV_CHUNK');
      return bytes;
    },
    removeCvChunks(connectionId, accountId, jobId) {
      if (!idPattern.test(jobId)) throw new Error('INVALID_CV_CHUNK');
      let parent;
      for (let index = 0; index < 8; index++) {
        parent = dirname(historyFile(connectionId, accountId, `cv:${jobId}:chunk:${index}`));
        if (existsSync(parent)) privateDirectory(parent);
        try { unlinkSync(historyFile(connectionId, accountId, `cv:${jobId}:chunk:${index}`)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (existsSync(parent)) { privateDirectory(parent); syncDirectory(parent); }
    },
    saveHistory(connectionId, accountId, key, record) {
      const json = JSON.stringify(record);
      if (Buffer.byteLength(json) > (key === 'pending-native-update' ? 2097152 : 524288)) throw new Error('HISTORY_CACHE_TOO_LARGE');
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
      cipher.setAAD(Buffer.from(`${scope}:history:${connectionId}:${accountId}:${key}`));
      const ciphertext = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
      atomicWrite(historyFile(connectionId, accountId, key, true), JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }));
    },
    loadHistory(connectionId, accountId, key) {
      const path = historyFile(connectionId, accountId, key);
      if (!existsSync(path)) return null;
      const record = JSON.parse(readPrivateFile(path, key === 'pending-native-update' ? 3000000 : 750000));
      const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(record.iv, 'base64'));
      decipher.setAAD(Buffer.from(`${scope}:history:${connectionId}:${accountId}:${key}`));
      decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
    },
    removeHistoryRecord(connectionId, accountId, key) {
      const path = historyFile(connectionId, accountId, key);
      if (existsSync(dirname(path))) privateDirectory(dirname(path));
      try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (existsSync(dirname(path))) syncDirectory(dirname(path));
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
