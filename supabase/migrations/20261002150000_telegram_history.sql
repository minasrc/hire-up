begin;
set local lock_timeout='2s';
set local statement_timeout='30s';
set local role app_owner;
create table app.telegram_history_limits (
 organization_id uuid not null, owner_user_id uuid not null,
 max_messages bigint not null default 200000 check(max_messages between 1 and 2000000),
 max_bytes bigint not null default 268435456 check(max_bytes between 1 and 2147483648),
 max_chats integer not null default 20000 check(max_chats between 1 and 100000),
 stored_messages bigint not null default 0 check(stored_messages>=0), stored_bytes bigint not null default 0 check(stored_bytes>=0), stored_chats integer not null default 0 check(stored_chats>=0),
 primary key(organization_id,owner_user_id), foreign key(organization_id,owner_user_id) references app.organization_memberships(organization_id,user_id)
);
create table app.telegram_history_accounts (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, owner_user_id uuid not null,
 connection_id uuid not null references app.telegram_connections(id), account_user_id text not null check(account_user_id ~ '^[1-9][0-9]{0,29}$'),
 cooldown_until timestamptz, updated_at timestamptz not null default now(),
 unique(organization_id,owner_user_id,id), unique(organization_id,owner_user_id,connection_id,account_user_id),
 foreign key(organization_id,owner_user_id) references app.organization_memberships(organization_id,user_id)
);
create table app.telegram_history_chats (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, owner_user_id uuid not null, account_id uuid not null,
 peer_kind text not null check(peer_kind in ('user','chat','channel')), peer_id text not null check(peer_id ~ '^[1-9][0-9]{0,29}$'),
 title text not null check(char_length(title) between 1 and 200), username text check(username ~ '^[A-Za-z0-9_]{1,32}$'), last_message_at timestamptz,
 selected boolean not null default false, version bigint not null default 1 check(version>0),
 unique(organization_id,owner_user_id,id), unique(account_id,peer_kind,peer_id),
 foreign key(organization_id,owner_user_id,account_id) references app.telegram_history_accounts(organization_id,owner_user_id,id)
);
create index telegram_history_chats_page_idx on app.telegram_history_chats(organization_id,owner_user_id,account_id,id);
create table app.telegram_history_jobs (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, owner_user_id uuid not null, account_id uuid not null, chat_id uuid,
 kind text not null check(kind in ('dialogs','history')), folder integer,
 connection_generation bigint not null check(connection_generation>0),
 status text not null default 'queued' check(status in ('queued','leased','waiting','paused','capacity_paused','failed','cancelled','completed')),
 cursor jsonb not null, run_id uuid not null default gen_random_uuid(), page_number integer not null default 0 check(page_number>=0),
 lease_token uuid, lease_expires_at timestamptz, attempts integer not null default 0 check(attempts between 0 and 5),
 retry_at timestamptz, error_code text, served_at timestamptz not null default 'epoch',
 imported_messages bigint not null default 0 check(imported_messages>=0), imported_bytes bigint not null default 0 check(imported_bytes>=0),
 check((kind='dialogs' and folder is not null and folder in (0,1) and chat_id is null) or (kind='history' and folder is null and chat_id is not null)),
 unique(organization_id,owner_user_id,id),
 foreign key(organization_id,owner_user_id,account_id) references app.telegram_history_accounts(organization_id,owner_user_id,id),
 foreign key(organization_id,owner_user_id,chat_id) references app.telegram_history_chats(organization_id,owner_user_id,id)
);
create unique index telegram_history_dialog_job_idx on app.telegram_history_jobs(account_id,folder) where kind='dialogs';
create unique index telegram_history_chat_job_idx on app.telegram_history_jobs(chat_id) where kind='history';
create index telegram_history_jobs_claim_idx on app.telegram_history_jobs(organization_id,owner_user_id,account_id,connection_generation,status,served_at,id);
create table app.telegram_history_pages (
 organization_id uuid not null, owner_user_id uuid not null, job_id uuid not null, run_id uuid not null, page_id uuid not null,
 generation bigint not null, cursor_digest bytea not null check(octet_length(cursor_digest)=32), digest bytea not null check(octet_length(digest)=32), result jsonb not null,
 primary key(job_id,page_id), foreign key(organization_id,owner_user_id,job_id) references app.telegram_history_jobs(organization_id,owner_user_id,id)
);
create index telegram_history_pages_cursor_idx on app.telegram_history_pages(job_id,run_id,cursor_digest);
create table app.telegram_history_messages (
 organization_id uuid not null, owner_user_id uuid not null, chat_id uuid not null, message_id bigint not null check(message_id between 1 and 2147483647),
 body jsonb not null check(jsonb_typeof(body)='object' and octet_length(body::text)<=307200), stored_bytes integer not null check(stored_bytes between 1 and 307200),
 primary key(chat_id,message_id), foreign key(organization_id,owner_user_id,chat_id) references app.telegram_history_chats(organization_id,owner_user_id,id)
);
do $$ declare t text; begin
 foreach t in array array['telegram_history_limits','telegram_history_accounts','telegram_history_chats','telegram_history_jobs','telegram_history_pages','telegram_history_messages'] loop
 execute format('alter table app.%I enable row level security',t); execute format('alter table app.%I force row level security',t);
 execute format('grant select,insert,update,delete on app.%I to app_executor',t);
 execute format('create policy telegram_history_owner on app.%I for all to app_executor using(organization_id=app.context_uuid_v1(''app.organization_id'') and owner_user_id=app.context_uuid_v1(''app.actor_id'')) with check(organization_id=app.context_uuid_v1(''app.organization_id'') and owner_user_id=app.context_uuid_v1(''app.actor_id''))',t);
 end loop;
end $$;
grant create on schema app to app_executor;
reset role;
set local role app_executor;
create function app.telegram_history_keys_v1(v jsonb, keys text[]) returns boolean language sql immutable set search_path=pg_catalog,app,pg_temp as $$
 select jsonb_typeof(v)='object' and not exists(select 1 from jsonb_object_keys(v) k where not(k=any(keys)));
$$;
create function app.telegram_history_peer_v1(v jsonb) returns boolean language sql immutable set search_path=pg_catalog,app,pg_temp as $$
 select coalesce(app.telegram_history_keys_v1(v,array['kind','id']) and v->>'kind' in ('user','chat','channel') and jsonb_typeof(v->'id')='string' and v->>'id' ~ '^[1-9][0-9]{0,29}$',false);
$$;
create function app.telegram_history_cursor_v1(v jsonb,kind text) returns boolean language plpgsql immutable set search_path=pg_catalog,app,pg_temp as $$ begin
 if kind='dialogs' then return coalesce(app.telegram_history_keys_v1(v,array['folder','offsetDate','offsetId','offsetPeer','excludePinned']) and v->>'folder' in ('0','1') and jsonb_typeof(v->'folder')='number' and jsonb_typeof(v->'offsetDate')='number' and v->>'offsetDate' ~ '^[0-9]+$' and (v->>'offsetDate')::numeric between 0 and 4102444800 and jsonb_typeof(v->'offsetId')='string' and v->>'offsetId' ~ '^[0-9]{1,10}$' and (v->>'offsetId')::numeric between 0 and 2147483647 and jsonb_typeof(v->'excludePinned')='boolean' and (v->'offsetPeer'='null'::jsonb or app.telegram_history_peer_v1(v->'offsetPeer')),false); end if;
 return coalesce(app.telegram_history_keys_v1(v,array['beforeMessageId','upperMessageId']) and ((v->'beforeMessageId'='null'::jsonb and v->'upperMessageId'='null'::jsonb) or (jsonb_typeof(v->'beforeMessageId')='string' and jsonb_typeof(v->'upperMessageId')='string' and v->>'beforeMessageId' ~ '^[1-9][0-9]{0,9}$' and v->>'upperMessageId' ~ '^[1-9][0-9]{0,9}$' and (v->>'beforeMessageId')::numeric between 1 and 2147483647 and (v->>'upperMessageId')::numeric between (v->>'beforeMessageId')::numeric and 2147483647)),false);
end $$;
create function app.telegram_history_record_v1(v jsonb,kind text) returns boolean language plpgsql immutable set search_path=pg_catalog,app,pg_temp as $$ declare a jsonb; s jsonb; begin
 if kind='dialogs' then return coalesce(app.telegram_history_keys_v1(v,array['peer','title','username','lastMessageAt']) and app.telegram_history_peer_v1(v->'peer') and jsonb_typeof(v->'title')='string' and char_length(v->>'title') between 1 and 200 and (v->'username'='null'::jsonb or (jsonb_typeof(v->'username')='string' and v->>'username' ~ '^[A-Za-z0-9_]{1,32}$')) and (v->'lastMessageAt'='null'::jsonb or jsonb_typeof(v->'lastMessageAt')='string'),false); end if;
 if not coalesce(app.telegram_history_keys_v1(v,array['messageId','kind','sentAt','editedAt','sender','replyToMessageId','forwardedFrom','text','attachments']) and jsonb_typeof(v->'messageId')='string' and v->>'messageId' ~ '^[1-9][0-9]{0,9}$' and (v->>'messageId')::numeric between 1 and 2147483647 and v->>'kind' in ('message','service','unavailable') and (jsonb_typeof(v->'sentAt')='string' or (v->>'kind'='unavailable' and v->'sentAt'='null'::jsonb)) and (v->'editedAt'='null'::jsonb or jsonb_typeof(v->'editedAt')='string') and jsonb_typeof(v->'text')='string' and octet_length(v->>'text')<=32768 and jsonb_typeof(v->'attachments')='array' and jsonb_array_length(v->'attachments')<=16 and octet_length(v::text)<=307200,false) then return false; end if;
 if v->>'kind'='unavailable' and not coalesce(v->'sentAt'='null'::jsonb and v->'editedAt'='null'::jsonb and v->'sender'='null'::jsonb and v->'replyToMessageId'='null'::jsonb and v->'forwardedFrom'='null'::jsonb and v->>'text'='' and jsonb_array_length(v->'attachments')=0,false) then return false; end if;
 perform (v->>'sentAt')::timestamptz; perform (v->>'editedAt')::timestamptz;
 if v->'replyToMessageId'<>'null'::jsonb and not coalesce(jsonb_typeof(v->'replyToMessageId')='string' and v->>'replyToMessageId' ~ '^[1-9][0-9]{0,9}$' and (v->>'replyToMessageId')::numeric between 1 and 2147483647,false) then return false; end if;
 s:=v->'sender'; if s<>'null'::jsonb and not coalesce(app.telegram_history_keys_v1(s,array['peer','username','displayName']) and app.telegram_history_peer_v1(s->'peer') and (s->'username'='null'::jsonb or s->>'username' ~ '^[A-Za-z0-9_]{1,32}$') and (s->'displayName'='null'::jsonb or (jsonb_typeof(s->'displayName')='string' and char_length(s->>'displayName')<=200)),false) then return false; end if;
 s:=v->'forwardedFrom'; if s<>'null'::jsonb and not coalesce(app.telegram_history_keys_v1(s,array['peer','displayName']) and (s->'peer'='null'::jsonb or app.telegram_history_peer_v1(s->'peer')) and (s->'displayName'='null'::jsonb or (jsonb_typeof(s->'displayName')='string' and char_length(s->>'displayName')<=200)),false) then return false; end if;
 for a in select value from jsonb_array_elements(v->'attachments') loop
 if not coalesce(app.telegram_history_keys_v1(a,array['id','kind','filename','mimeType','sizeBytes']) and a->>'kind' in ('document','photo','other') and (a->'id'='null'::jsonb or (jsonb_typeof(a->'id')='string' and a->>'id' ~ '^[1-9][0-9]{0,29}$')) and (a->'filename'='null'::jsonb or (jsonb_typeof(a->'filename')='string' and char_length(a->>'filename')<=200)) and (a->'mimeType'='null'::jsonb or (jsonb_typeof(a->'mimeType')='string' and char_length(a->>'mimeType')<=100)) and (a->'sizeBytes'='null'::jsonb or (jsonb_typeof(a->'sizeBytes')='number' and a->>'sizeBytes' ~ '^[0-9]+$' and (a->>'sizeBytes')::numeric between 0 and 9007199254740991)),false) then return false; end if;
 end loop; return true;
end $$;
create function app.telegram_history_connected_v1() returns app.telegram_connections language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$ declare c app.telegram_connections; begin
 perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
 select * into c from app.telegram_connections where status='connected' for share;
 if not found then raise exception 'Telegram connection required' using errcode='40001'; end if; return c;
end $$;
create function app.telegram_history_worker_v1(p_token text,p_connection uuid,p_generation bigint,p_lease uuid,p_user text) returns app.telegram_history_accounts language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$ declare w uuid; c app.telegram_connections; a app.telegram_history_accounts; begin
 w:=app.telegram_worker_context_v1(p_token);
 select * into c from app.telegram_connections where id=p_connection and worker_id=w for share;
 if not found or c.status<>'connected' or c.generation is distinct from p_generation or c.lease_token is null or c.lease_token is distinct from p_lease or c.lease_expires_at is null or c.lease_expires_at<=clock_timestamp() or (c.profile->>'telegramUserId') is distinct from p_user then raise exception 'Connection changed' using errcode='40001'; end if;
 select * into a from app.telegram_history_accounts where connection_id=c.id and account_user_id=p_user for update; return a;
end $$;
create function app.telegram_history_action_v1(p_input jsonb) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$ declare c app.telegram_connections; a app.telegram_history_accounts; ch app.telegram_history_chats; item jsonb; items jsonb; action text; v_selected boolean; f integer; begin
 c:=app.telegram_history_connected_v1(); action:=p_input->>'action';
 if action='discover' then
 insert into app.telegram_history_limits(organization_id,owner_user_id) values(c.organization_id,c.owner_user_id) on conflict do nothing;
 insert into app.telegram_history_accounts(organization_id,owner_user_id,connection_id,account_user_id) values(c.organization_id,c.owner_user_id,c.id,c.profile->>'telegramUserId') on conflict(organization_id,owner_user_id,connection_id,account_user_id) do update set updated_at=clock_timestamp() returning * into a;
 for f in 0..1 loop
 delete from app.telegram_history_pages p using app.telegram_history_jobs j where p.job_id=j.id and j.account_id=a.id and j.kind='dialogs' and j.folder=f and (j.status not in ('queued','leased','waiting') or j.connection_generation<>c.generation);
 insert into app.telegram_history_jobs(organization_id,owner_user_id,account_id,kind,folder,connection_generation,cursor) values(c.organization_id,c.owner_user_id,a.id,'dialogs',f,c.generation,jsonb_build_object('folder',f,'offsetDate',0,'offsetId','0','offsetPeer',null,'excludePinned',false))
 on conflict(account_id,folder) where kind='dialogs' do update set status='queued',connection_generation=c.generation,cursor=excluded.cursor,run_id=gen_random_uuid(),page_number=0,attempts=0,lease_token=null,lease_expires_at=null,error_code=null,retry_at=null
 where telegram_history_jobs.status not in ('queued','leased','waiting') or telegram_history_jobs.connection_generation<>c.generation;
 end loop; return jsonb_build_object('ok',true); end if;
 select * into a from app.telegram_history_accounts where connection_id=c.id and account_user_id=c.profile->>'telegramUserId' for update;
 if not found then raise exception 'Discover chats first' using errcode='40001'; end if;
 if action not in ('select','selectMany','pause','resume','cancel') or action is null then raise exception 'Invalid history action' using errcode='22023'; end if;
 items:=case when action='selectMany' then p_input->'chats' else jsonb_build_array(p_input) end;
 if jsonb_typeof(items)<>'array' or jsonb_array_length(items) not between 1 and 50 or (select count(distinct x->>'chatId') from jsonb_array_elements(items) x)<>jsonb_array_length(items) then raise exception 'Invalid chat selection' using errcode='22023'; end if;
 for item in select value from jsonb_array_elements(items) order by value->>'chatId' loop
 select * into ch from app.telegram_history_chats where id=(item->>'chatId')::uuid and account_id=a.id for update;
 if not found or ch.version is distinct from (item->>'expectedVersion')::bigint then raise exception 'Chat changed' using errcode='40001'; end if;
 v_selected:=case when action in ('select','selectMany') then (p_input->>'selected')::boolean when action='cancel' then false else true end;
 if v_selected is null then raise exception 'Invalid selection' using errcode='22023'; end if;
 update app.telegram_history_chats set selected=v_selected,version=version+1 where id=ch.id;
 insert into app.telegram_history_jobs(organization_id,owner_user_id,account_id,chat_id,kind,connection_generation,cursor,status) values(c.organization_id,c.owner_user_id,a.id,ch.id,'history',c.generation,'{"beforeMessageId":null,"upperMessageId":null}',case when not v_selected then 'cancelled' when action='pause' then 'paused' else 'queued' end)
 on conflict(chat_id) where kind='history' do update set connection_generation=c.generation,status=case when telegram_history_jobs.status='completed' then 'completed' else excluded.status end,attempts=0,lease_token=null,lease_expires_at=null,retry_at=null,error_code=null;
 end loop; return jsonb_build_object('ok',true);
end $$;
create function app.telegram_history_status_v1(p_view text,p_q text,p_after uuid) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$ declare c app.telegram_connections; a app.telegram_history_accounts; limits app.telegram_history_limits; chats jsonb; total bigint; selected_total bigint; discovery jsonb; next_cursor uuid; begin
 perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
 if p_view not in ('all','selected','active','paused') or char_length(p_q)>100 then raise exception 'Invalid history filter' using errcode='22023'; end if;
 select * into c from app.telegram_connections;
 select * into a from app.telegram_history_accounts where connection_id=c.id and (c.status<>'connected' or account_user_id=c.profile->>'telegramUserId') order by updated_at desc limit 1;
 select * into limits from app.telegram_history_limits;
 select count(*),count(*) filter(where selected) into total,selected_total from app.telegram_history_chats where account_id=a.id;
 with records as (
 select ch.id,jsonb_build_object('id',ch.id,'peer',jsonb_build_object('kind',ch.peer_kind,'id',ch.peer_id),'title',ch.title,'username',ch.username,'selected',ch.selected,'version',ch.version,'import',case when j.id is null then null else jsonb_build_object('jobId',j.id,'status',case when j.connection_generation<>c.generation and j.status<>'completed' then 'paused' else j.status end,'importedMessages',j.imported_messages,'importedBytes',j.imported_bytes,'errorCode',case when j.connection_generation<>c.generation and j.status<>'completed' then 'CONNECTION_CHANGED' else j.error_code end,'retryAt',j.retry_at) end) value
 from app.telegram_history_chats ch left join app.telegram_history_jobs j on j.chat_id=ch.id where ch.account_id=a.id and (p_after is null or ch.id>p_after) and (p_q='' or ch.title ilike '%'||p_q||'%' or ch.username ilike '%'||p_q||'%') and (p_view='all' or (p_view='selected' and ch.selected) or (p_view='active' and j.status in ('queued','leased','waiting') and j.connection_generation=c.generation) or (p_view='paused' and (j.status in ('paused','capacity_paused','failed') or (j.connection_generation<>c.generation and j.status<>'completed')))) order by ch.id limit 51
 ), numbered as(select *,row_number() over(order by id) n from records)
 select coalesce(jsonb_agg(value order by id) filter(where n<=50),'[]'::jsonb),case when count(*)>50 then (array_agg(id order by id))[50] end into chats,next_cursor from numbered;
 select jsonb_build_object('status',case when count(*)=0 then 'idle' when bool_and(status='completed') then 'completed' when bool_or(status in ('queued','leased','waiting') and connection_generation=c.generation) then 'active' else 'paused' end,'jobs',coalesce(jsonb_agg(jsonb_build_object('id',id,'status',status,'errorCode',error_code,'retryAt',retry_at) order by folder),'[]'::jsonb)) into discovery from app.telegram_history_jobs where account_id=a.id and kind='dialogs';
 return jsonb_build_object('connection',case when c.id is null then null else jsonb_build_object('id',c.id,'generation',c.generation,'status',c.status,'accountUserId',c.profile->>'telegramUserId') end,'account',case when a.id is null then null else jsonb_build_object('id',a.id,'accountUserId',a.account_user_id) end,'canImport',coalesce(c.status='connected',false),'blockedReason',case when c.status is distinct from 'connected' then 'NOT_CONNECTED' end,'discovery',discovery,'totals',jsonb_build_object('chats',total,'selected',selected_total,'messages',coalesce(limits.stored_messages,0),'bytes',coalesce(limits.stored_bytes,0),'maxMessages',coalesce(limits.max_messages,200000),'maxBytes',coalesce(limits.max_bytes,268435456)),'chats',chats,'nextCursor',next_cursor);
end $$;
create function app.telegram_history_claim_v1(p_token text,p_connection uuid,p_generation bigint,p_connection_lease uuid,p_user text) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$ declare a app.telegram_history_accounts; j app.telegram_history_jobs; peer jsonb; begin
 a:=app.telegram_history_worker_v1(p_token,p_connection,p_generation,p_connection_lease,p_user);
 if a.id is null or a.cooldown_until>clock_timestamp() then return jsonb_build_object('job',null); end if;
 select * into j from app.telegram_history_jobs where account_id=a.id and connection_generation=p_generation and status='leased' and lease_expires_at>clock_timestamp() order by served_at,id limit 1;
 if not found then
 update app.telegram_history_jobs set status='failed',error_code='ATTEMPTS_EXHAUSTED',lease_token=null,lease_expires_at=null where account_id=a.id and connection_generation=p_generation and status='leased' and lease_expires_at<=clock_timestamp() and attempts>=5;
 select * into j from app.telegram_history_jobs where account_id=a.id and connection_generation=p_generation and attempts<5 and (status='queued' or (status='waiting' and retry_at<=clock_timestamp()) or (status='leased' and lease_expires_at<=clock_timestamp())) order by served_at,id limit 1 for update;
 if not found then return jsonb_build_object('job',null); end if;
 update app.telegram_history_jobs set status='leased',lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '120 seconds',attempts=attempts+1,served_at=clock_timestamp(),error_code=null where id=j.id returning * into j;
 end if;
 if j.chat_id is not null then select jsonb_build_object('kind',peer_kind,'id',peer_id) into peer from app.telegram_history_chats where id=j.chat_id; end if;
 return jsonb_build_object('job',jsonb_build_object('id',j.id,'kind',j.kind,'accountId',a.id,'accountUserId',a.account_user_id,'connectionId',p_connection,'generation',p_generation,'leaseToken',j.lease_token,'leaseExpiresAt',j.lease_expires_at,'cursor',j.cursor,'pageNumber',j.page_number,'peer',peer));
end $$;
create function app.telegram_history_complete_v1(p_token text,p_connection uuid,p_generation bigint,p_connection_lease uuid,p_user text,p_job uuid,p_job_lease uuid,p_page jsonb) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare a app.telegram_history_accounts; j app.telegram_history_jobs; quota app.telegram_history_limits; receipt app.telegram_history_pages; page_digest bytea; v_page_id uuid; records jsonb; r jsonb; n integer; added bigint; added_bytes bigint; min_id bigint; max_id bigint; result jsonb; next_cursor jsonb; done boolean; begin
 a:=app.telegram_history_worker_v1(p_token,p_connection,p_generation,p_connection_lease,p_user);
 if a.id is null then raise exception 'History unavailable' using errcode='40001'; end if;
 select * into j from app.telegram_history_jobs where id=p_job and account_id=a.id for update;
 if not found or j.connection_generation<>p_generation then raise exception 'History job changed' using errcode='40001'; end if;
 if not coalesce(app.telegram_history_keys_v1(p_page,array['pageId','fromCursor','nextCursor','done','records']),false) or octet_length(p_page::text)>307200 then raise exception 'Invalid history page' using errcode='22023'; end if;
 v_page_id:=(p_page->>'pageId')::uuid; page_digest:=sha256(convert_to(p_page::text,'UTF8'));
 select * into receipt from app.telegram_history_pages where job_id=j.id and telegram_history_pages.page_id=v_page_id;
 if found then
 if receipt.digest<>page_digest or receipt.run_id<>j.run_id or receipt.generation<>p_generation then raise exception 'Page receipt changed' using errcode='40001'; end if;
 return receipt.result||jsonb_build_object('replayed',true); end if;
 if j.status<>'leased' or j.lease_token is null or j.lease_token is distinct from p_job_lease or j.lease_expires_at is null or j.lease_expires_at<=clock_timestamp() then raise exception 'History lease changed' using errcode='40001'; end if;
 if p_page->'fromCursor' is distinct from j.cursor then raise exception 'History cursor changed' using errcode='40001'; end if;
 records:=p_page->'records'; next_cursor:=p_page->'nextCursor'; done:=(p_page->>'done')::boolean;
 if jsonb_typeof(records) is distinct from 'array' or jsonb_array_length(records)>100 or jsonb_typeof(p_page->'done') is distinct from 'boolean' or not app.telegram_history_cursor_v1(next_cursor,j.kind) then raise exception 'Invalid history records' using errcode='22023'; end if;
 n:=jsonb_array_length(records);
 if done is distinct from (n=0) or (done and next_cursor is distinct from j.cursor) or (not done and next_cursor=j.cursor) then raise exception 'Invalid history progress' using errcode='22023'; end if;
 for r in select value from jsonb_array_elements(records) loop
 if not app.telegram_history_record_v1(r,j.kind) then raise exception 'Invalid history record' using errcode='22023'; end if;
 end loop;
 if not done and exists(select 1 from app.telegram_history_pages p where p.job_id=j.id and p.run_id=j.run_id and p.result->>'status'<>'capacity_paused' and p.cursor_digest=sha256(convert_to(next_cursor::text,'UTF8'))) then raise exception 'Repeated history cursor' using errcode='22023'; end if;
 if j.kind='dialogs' then
 if next_cursor->>'folder' is distinct from j.cursor->>'folder' or (not done and next_cursor->>'excludePinned'<>'true') or (select count(distinct (x->'peer')::text) from jsonb_array_elements(records) x)<>n then raise exception 'Invalid dialog cursor' using errcode='22023'; end if;
 select count(*) into added from jsonb_array_elements(records) x where not exists(select 1 from app.telegram_history_chats ch where ch.account_id=a.id and ch.peer_kind=x->'peer'->>'kind' and ch.peer_id=x->'peer'->>'id'); added_bytes:=0;
 else
 select count(distinct (x->>'messageId')::bigint),min((x->>'messageId')::bigint),max((x->>'messageId')::bigint) into added,min_id,max_id from jsonb_array_elements(records) x;
 if added<>n or (n>0 and ((j.cursor->>'beforeMessageId' is not null and max_id>=(j.cursor->>'beforeMessageId')::bigint) or (next_cursor->>'beforeMessageId')::bigint<>min_id or (next_cursor->>'upperMessageId')::bigint<>coalesce((j.cursor->>'upperMessageId')::bigint,max_id))) then raise exception 'Invalid message cursor' using errcode='22023'; end if;
 select count(*),coalesce(sum(octet_length(x::text)),0) into added,added_bytes from jsonb_array_elements(records) x where not exists(select 1 from app.telegram_history_messages m where m.chat_id=j.chat_id and m.message_id=(x->>'messageId')::bigint);
 end if;
 select * into quota from app.telegram_history_limits for update;
 if (j.kind='dialogs' and quota.stored_chats+added>quota.max_chats) or (j.kind='history' and (quota.stored_messages+added>quota.max_messages or quota.stored_bytes+added_bytes>quota.max_bytes)) then
 update app.telegram_history_jobs set status='capacity_paused',error_code='CAPACITY_LIMIT',lease_token=null,lease_expires_at=null where id=j.id;
 result:=jsonb_build_object('ok',true,'status','capacity_paused','replayed',false);
 else
 if j.kind='dialogs' then
 insert into app.telegram_history_chats(organization_id,owner_user_id,account_id,peer_kind,peer_id,title,username,last_message_at)
 select a.organization_id,a.owner_user_id,a.id,x->'peer'->>'kind',x->'peer'->>'id',x->>'title',x->>'username',(x->>'lastMessageAt')::timestamptz from jsonb_array_elements(records) x
 on conflict(account_id,peer_kind,peer_id) do update set title=excluded.title,username=excluded.username,last_message_at=excluded.last_message_at;
 update app.telegram_history_limits set stored_chats=stored_chats+added;
 else
 insert into app.telegram_history_messages(organization_id,owner_user_id,chat_id,message_id,body,stored_bytes)
 select a.organization_id,a.owner_user_id,j.chat_id,(x->>'messageId')::bigint,x,octet_length(x::text) from jsonb_array_elements(records) x on conflict do nothing;
 update app.telegram_history_limits set stored_messages=stored_messages+added,stored_bytes=stored_bytes+added_bytes;
 end if;
 update app.telegram_history_jobs set cursor=next_cursor,status=case when done then 'completed' else 'queued' end,page_number=page_number+1,lease_token=null,lease_expires_at=null,attempts=0,retry_at=null,error_code=null,imported_messages=imported_messages+case when kind='history' then added else 0 end,imported_bytes=imported_bytes+added_bytes where id=j.id;
 result:=jsonb_build_object('ok',true,'status',case when done then 'completed' else 'queued' end,'replayed',false);
 end if;
 insert into app.telegram_history_pages(organization_id,owner_user_id,job_id,run_id,page_id,generation,cursor_digest,digest,result) values(a.organization_id,a.owner_user_id,j.id,j.run_id,v_page_id,p_generation,sha256(convert_to(j.cursor::text,'UTF8')),page_digest,result);
 return result;
end $$;
create function app.telegram_history_defer_v1(p_token text,p_connection uuid,p_generation bigint,p_connection_lease uuid,p_user text,p_job uuid,p_job_lease uuid,p_code text,p_retry integer) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$ declare a app.telegram_history_accounts; j app.telegram_history_jobs; retry timestamptz; begin
 a:=app.telegram_history_worker_v1(p_token,p_connection,p_generation,p_connection_lease,p_user);
 select * into j from app.telegram_history_jobs where id=p_job and account_id=a.id for update;
 if not found or j.connection_generation<>p_generation or j.status<>'leased' or j.lease_token is null or j.lease_token is distinct from p_job_lease or j.lease_expires_at<=clock_timestamp() then raise exception 'History lease changed' using errcode='40001'; end if;
 if p_code is null or p_code not in ('FLOOD_WAIT','TELEGRAM_UNAVAILABLE','PEER_UNAVAILABLE','PEER_CACHE_MISSING','MESSAGE_TOO_LARGE') or (p_code='FLOOD_WAIT' and (p_retry is null or p_retry not between 1 and 604800)) then raise exception 'Invalid history retry' using errcode='22023'; end if;
 retry:=clock_timestamp()+make_interval(secs=>case when p_code='FLOOD_WAIT' then p_retry else least(300,power(2,j.attempts)::integer) end);
 if p_code='FLOOD_WAIT' then update app.telegram_history_accounts set cooldown_until=retry where id=a.id; end if;
 update app.telegram_history_jobs set status=case when p_code='FLOOD_WAIT' or (p_code='TELEGRAM_UNAVAILABLE' and attempts<5) then 'waiting' else 'failed' end,attempts=case when p_code='FLOOD_WAIT' then greatest(0,attempts-1) else attempts end,retry_at=retry,error_code=p_code,lease_token=null,lease_expires_at=null where id=j.id;
 return jsonb_build_object('ok',true);
end $$;
do $$ declare f record; begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app' and p.proname like 'telegram_history_%' loop execute format('revoke all on function %s from public',f.signature); end loop;
end $$;
grant execute on function app.telegram_history_status_v1(text,text,uuid),app.telegram_history_action_v1(jsonb) to app_staff;
grant execute on function app.telegram_history_claim_v1(text,uuid,bigint,uuid,text),app.telegram_history_complete_v1(text,uuid,bigint,uuid,text,uuid,uuid,jsonb),app.telegram_history_defer_v1(text,uuid,bigint,uuid,text,uuid,uuid,text,integer) to app_telegram_worker;
reset role;
set local role app_owner;
revoke create on schema app from app_executor;
commit;
