import { validateCleanup } from './cleanup.mjs';
const lanes = ['history', 'cv', 'source'];
const nativeLanes = ['nativeAccount', 'nativeChannels'];
export function validRunnable(value, native = false) {
  const keys = native ? [...lanes, ...nativeLanes] : lanes;
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => typeof value[key] === 'boolean');
}
export function validWake(value) {
  return typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n;
}
// Exact, bounded IPC. Legacy grants remain accepted during deployment rollout.
export function validGrant(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
  const keys = Object.keys(message);
  if (keys.some(key => !['type', 'leaseToken', 'deadline', 'wakeEpoch', 'runnable'].includes(key))) return false;
  return (!Object.hasOwn(message, 'wakeEpoch') && !Object.hasOwn(message, 'runnable'))
    || (validWake(message.wakeEpoch) && validRunnable(message.runnable));
}
export function validatePoll(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)
    || ![4, 5].includes(Object.keys(response).length) || Object.keys(response).some(key => !['protocolVersion', 'connection', 'plan', 'nextPollAfterSeconds', 'cleanup'].includes(key)) || response.protocolVersion !== 1
    || !Object.hasOwn(response, 'connection') || !validRunnable(response.plan, true)
    || ![5, 60].includes(response.nextPollAfterSeconds)) throw new Error('INVALID_HOST_RESPONSE');
  if (Object.hasOwn(response, 'cleanup')) validateCleanup({ cleanup: response.cleanup });
  return response;
}
