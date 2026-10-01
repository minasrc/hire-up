// Compile-only SDK boundary audit. No code here is invoked or sent to Telegram.
import { TelegramClient, Api } from 'teleproto';
import { StringSession } from 'teleproto/sessions';
import { Logger, LogLevel } from 'teleproto/extensions/Logger.js';
import bigInt from 'big-integer';
import { computeCheck } from 'teleproto/Password.js';
export async function verifySdkContract(client: TelegramClient, info: Api.account.Password) {
  new TelegramClient(new StringSession(''), 1, 'synthetic', { connectionRetries: 1, requestRetries: 1, floodSleepThreshold: 0, autoReconnect: false, baseLogger: new Logger(LogLevel.NONE) });
  await client.connect();
  await client._switchDC(2);
  await client.invoke(new Api.auth.ExportLoginToken({ apiId: 1, apiHash: 'synthetic', exceptIds: [] }));
  await client.invoke(new Api.auth.ImportLoginToken({ token: Buffer.from('synthetic') }));
  await client.invoke(new Api.account.GetPassword());
  await client.invoke(new Api.auth.CheckPassword({ password: await computeCheck(info, 'synthetic') }));
  await client.invoke(new Api.auth.LogOut());
  await client.invoke(new Api.messages.GetDialogs({ folderId: 0, offsetId: 0, offsetDate: 0, offsetPeer: new Api.InputPeerEmpty(), excludePinned: false, limit: 100, hash: bigInt.zero }), undefined, { timeout: 10000, maxRetryCount: 0, floodSleepThreshold: 0, abortSignal: new AbortController().signal });
  await client.invoke(new Api.messages.GetHistory({ peer: new Api.InputPeerChat({ chatId: bigInt(123) }), offsetId: 0, offsetDate: 0, addOffset: 0, minId: 0, maxId: 0, limit: 100, hash: bigInt.zero }));
  await client.getMe();
  client.session.save();
  await client.destroy();
}
