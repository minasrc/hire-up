import { constants, lstatSync, fstatSync, mkdirSync, openSync, closeSync, readFileSync,
  writeFileSync, fsyncSync, linkSync, unlinkSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, parse } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { serviceOrigin } from './http.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function privateDirectory(path) {
  const target = resolve(path), root = parse(target).root;
  let current = root;
  for (const segment of target.slice(root.length).split('/')) {
    current = join(current, segment);
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 });
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('UNSAFE_LOCAL_DIRECTORY');
  }
  const stat = lstatSync(target);
  if (stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('UNSAFE_LOCAL_DIRECTORY');
  return target;
}
export function readPrivateJson(path) {
  let stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()
    || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 65536) throw new Error('UNSAFE_LOCAL_FILE');
  if (stat.nlink === 2) {
    // Recover the one publication crash window; never repair arbitrary links.
    privateDirectory(dirname(path));
    const matches = readdirSync(dirname(path)).filter(name => /^\.new-[a-f0-9]{32}$/.test(name)).filter(name => {
      const other = lstatSync(join(dirname(path), name));
      return other.isFile() && !other.isSymbolicLink() && other.uid === process.getuid()
        && !(other.mode & 0o077) && other.dev === stat.dev && other.ino === stat.ino;
    });
    if (matches.length !== 1) throw new Error('UNSAFE_LOCAL_FILE');
    unlinkSync(join(dirname(path), matches[0]));
    const directory = openSync(dirname(path), constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
    stat = lstatSync(path);
  }
  if (stat.nlink !== 1) throw new Error('UNSAFE_LOCAL_FILE');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.nlink !== 1) throw new Error('UNSAFE_LOCAL_FILE');
    return JSON.parse(readFileSync(fd, 'utf8'));
  }
  catch { throw new Error('INVALID_LOCAL_CONFIG'); } finally { closeSync(fd); }
}
// Publish once. A lost registration response must recover this exact credential.
function writeNewJson(path, value) {
  privateDirectory(dirname(path));
  const temporary = join(dirname(path), `.new-${randomBytes(16).toString('hex')}`);
  let fd;
  try {
    fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); closeSync(fd); fd = undefined;
    linkSync(temporary, path); unlinkSync(temporary);
    const directory = openSync(dirname(path), constants.O_RDONLY); try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch { /* Preserved target remains authoritative. */ }
  }
}
export function validateRequest(item) {
  if (!item || ![item.requestId, item.organizationId, item.ownerUserId].every(value => UUID.test(value ?? ''))
    || (item.workerId !== null && !UUID.test(item.workerId ?? ''))
    || (item.tokenSha256 !== null && !/^[a-f0-9]{64}$/.test(item.tokenSha256 ?? ''))
    || !['pending', 'registered', 'stopped'].includes(item.state) || typeof item.canRun !== 'boolean') throw new Error('INVALID_HOST_RESPONSE');
  if (item.state === 'registered' && (!item.workerId || !item.tokenSha256)) throw new Error('INVALID_HOST_RESPONSE');
  return item;
}
export function createServiceStore(config) {
  const root = privateDirectory(config.stateDirectory);
  const workers = privateDirectory(join(root, 'workers'));
  const scope = { server: serviceOrigin(config.server), serviceId: config.serviceId };
  if (!UUID.test(scope.serviceId ?? '')) throw new Error('INVALID_SERVICE_ID');
  const scopePath = join(root, 'service.json');
  if (!existsSync(scopePath)) writeNewJson(scopePath, { version: 1, ...scope });
  const savedScope = readPrivateJson(scopePath);
  if (savedScope.version !== 1 || savedScope.server !== scope.server || savedScope.serviceId !== scope.serviceId) throw new Error('LOCAL_SCOPE_CONFLICT');
  return {
    root,
    prepare(item, api) {
      validateRequest(item);
      const directory = privateDirectory(join(workers, item.requestId));
      const recordPath = join(directory, 'credential.json');
      if (!existsSync(recordPath)) {
        // If the database already registered this request, missing local keys are
        // a recovery error. Never pretend a fresh token restores its old session.
        if (item.workerId || item.state !== 'pending') throw new Error('LOCAL_CREDENTIAL_MISSING');
        writeNewJson(recordPath, { version: 1, ...scope, requestId: item.requestId,
          organizationId: item.organizationId, ownerUserId: item.ownerUserId,
          workerId: randomUUID(), token: randomBytes(48).toString('base64url') });
      }
      const record = readPrivateJson(recordPath);
      if (record.version !== 1 || record.server !== scope.server || record.serviceId !== scope.serviceId
        || ['requestId', 'organizationId', 'ownerUserId'].some(key => record[key] !== item[key])
        || !UUID.test(record.workerId ?? '') || !/^[A-Za-z0-9_-]{64}$/.test(record.token ?? '')) throw new Error('LOCAL_SCOPE_CONFLICT');
      const tokenSha256 = createHash('sha256').update(record.token).digest('hex');
      if ((item.workerId && record.workerId !== item.workerId)
        || (item.tokenSha256 && tokenSha256 !== item.tokenSha256)) throw new Error('LOCAL_SCOPE_CONFLICT');
      const stateDirectory = privateDirectory(join(directory, 'state'));
      const configPath = join(directory, 'connector.json');
      const childConfig = { server: record.server, workerId: record.workerId, token: record.token,
        apiId: api.apiId, apiHash: api.apiHash, stateDirectory };
      if (!existsSync(configPath)) writeNewJson(configPath, childConfig);
      const saved = readPrivateJson(configPath);
      if (Object.keys(childConfig).some(key => saved[key] !== childConfig[key])) throw new Error('LOCAL_CONFIG_CONFLICT');
      return { requestId: item.requestId, workerId: record.workerId, tokenSha256, configPath, stateDirectory };
    },
    listLocal() { return readdirSync(workers).filter(name => UUID.test(name)); },
  };
}
