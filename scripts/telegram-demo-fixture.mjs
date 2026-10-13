import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { psql } from '../tests/support/foundation-docker.js';
import { AUTHZ_ID, staffPoolOptions } from '../tests/support/staff-authorization.js';
import { saveCandidateProfile } from '../src/lib/candidate-profile-operations.js';
import { createTelegramDraft, registerTelegramWorker } from '../src/lib/telegram-intake-operations.js';

// Only called by the disposable staff preview, never by the application.
export async function seedTelegramDemo(db, password, { liveExtraction = false } = {}) {
    const pool = new pg.Pool(staffPoolOptions(db, password, 2));
    const org = AUTHZ_ID.ORG_B, user = AUTHZ_ID.USER_ADMIN2;
    const args = [pool, { provider: 'google', issuer: 'https://accounts.google.com', subject: '1002' }, org];
    try {
        await saveCandidateProfile(...args, { candidateId: randomUUID(), expectedVersion: null, operationId: randomUUID(), fields: {
            fullName: 'Maya Chen', email: 'maya@example.test', headline: 'Software engineer', location: 'Madrid', professionalSummary: 'Builds backend services.',
        } });
        let fresh, update;
        if (!liveExtraction) {
        fresh = await createTelegramDraft(...args, { sourceTitle: 'Engineering community', fields: {
            firstName: 'Alex', lastName: 'Rivera', primaryEmail: 'alex@example.test', headline: 'Senior Solidity engineer', location: 'Barcelona',
            professionalSummary: 'Five years building Ethereum applications. Open to remote roles.',
        } });
        update = await createTelegramDraft(...args, { sourceTitle: 'Talent network', fields: {
            firstName: 'Maya', lastName: 'Chen', primaryEmail: 'maya@example.test', headline: 'Senior backend engineer', location: 'Lisbon',
            professionalSummary: 'Now leads a backend team and is interested in remote opportunities.',
        } });
        await createTelegramDraft(...args, { sourceTitle: 'Engineering community', fields: {
            firstName: 'Sam', lastName: 'Taylor', headline: 'Product designer', professionalSummary: 'Available for contract work.',
        } });
        }
        const worker = await registerTelegramWorker(...args, 'Local demo');
        const publicKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
        const connection = randomUUID(), account = randomUUID();
        const chats = ['Engineering community', 'Talent network', 'Web3 jobs', 'Product designers', 'Remote work', 'Barcelona tech'];
        const chatIds = chats.map(() => randomUUID());
        psql(db, `insert into app.telegram_connector_workers(id,organization_id,owner_user_id,public_key_spki) values('${worker.id}','${org}','${user}','${publicKey}');
            insert into app.telegram_connections(id,organization_id,owner_user_id,worker_id,status,auth_expires_at,profile) values('${connection}','${org}','${user}','${worker.id}','connected',now()+interval '1 hour','{"telegramUserId":"123","username":"local_demo","displayName":"Local demo"}');
            insert into app.telegram_history_limits(organization_id,owner_user_id,stored_chats) values('${org}','${user}',${chats.length});
            insert into app.telegram_history_accounts(id,organization_id,owner_user_id,connection_id,account_user_id) values('${account}','${org}','${user}','${connection}','123');
            ${chats.map((title, i) => `insert into app.telegram_history_chats(id,organization_id,owner_user_id,account_id,peer_kind,peer_id,title,last_message_at) values('${chatIds[i]}','${org}','${user}','${account}','chat','${i+1}','${title}',now()-interval '${i} hours');`).join('\n')}
            ${[0,1].map(folder => `insert into app.telegram_history_jobs(organization_id,owner_user_id,account_id,kind,folder,connection_generation,status,cursor) values('${org}','${user}','${account}','dialogs',${folder},1,'completed','{}');`).join('\n')}`);
        if (liveExtraction) {
            const texts = [
                'I am Alex Rivera. My email is alex@example.test. I am a Senior Solidity engineer in Barcelona. I have five years of Ethereum experience and I am open to remote roles.',
                'I am Maya Chen. My email is maya@example.test. I moved to Lisbon. I am now a Senior backend engineer and lead a backend team. I am interested in remote opportunities.',
                'I am Sam Taylor. I am a Product designer. I am available for contract work.',
            ];
            const messages = texts.map((text, index) => ({ messageId: '1', kind: 'message', sentAt: new Date().toISOString(), editedAt: null,
                sender: { peer: { kind: 'user', id: String(900 + index) }, username: null, displayName: ['Alex Rivera','Maya Chen','Sam Taylor'][index] },
                replyToMessageId: null, forwardedFrom: null, text, attachments: [] }));
            for (const [index, message] of messages.entries()) {
                const body = JSON.stringify(message).replace(/'/g, "''");
                psql(db, `insert into app.telegram_history_messages(organization_id,owner_user_id,chat_id,message_id,body,stored_bytes) values('${org}','${user}','${chatIds[index]}',1,'${body}',octet_length('${body}'::jsonb::text));`);
            }
            psql(db, `update app.telegram_history_limits set stored_messages=(select count(*) from app.telegram_history_messages where organization_id='${org}' and owner_user_id='${user}'),stored_bytes=(select sum(stored_bytes) from app.telegram_history_messages where organization_id='${org}' and owner_user_id='${user}') where organization_id='${org}' and owner_user_id='${user}';`);
        } else {
        for (const [index, draft] of [fresh, update].entries()) {
            const job = randomUUID(), evidence = randomUUID();
            const text = index === 0 ? 'Alex Rivera: I am a senior Solidity engineer in Barcelona. I have five years of Ethereum experience and I am open to remote roles.'
                : 'Maya Chen: I moved to Lisbon and now lead a backend team. I am interested in remote opportunities.';
            // This is fixed synthetic text; no external data enters these statements.
            psql(db, `insert into app.telegram_extraction_jobs(id,organization_id,owner_user_id,chat_id,source,source_digest,message_count,status,receipt,completed_at) values('${job}','${org}','${user}','${chatIds[index]}','{"chat":{},"messages":[]}',sha256(convert_to('demo','UTF8')),1,'completed','{"draftIds":["${draft.id}"]}',now());
                insert into app.telegram_evidence(id,organization_id,owner_user_id,source_key,text,sender_name,sent_at) values('${evidence}','${org}','${user}','extraction:${job}:1:demo','${text}','${draft.fields.firstName}',now());
                insert into app.telegram_draft_evidence(organization_id,owner_user_id,draft_id,evidence_id) values('${org}','${user}','${draft.id}','${evidence}');`);
        }
        }
        return { workerToken: worker.token };
    } finally { await pool.end(); }
}
