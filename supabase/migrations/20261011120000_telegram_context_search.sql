-- Search stays on retained source rows: deletion/retention automatically removes index entries.
begin;
set local lock_timeout='2s';
set local statement_timeout='30s';
set local role app_owner;
alter table app.telegram_history_messages add column context_document tsvector generated always as (to_tsvector('simple'::regconfig, coalesce(body->>'text',''))) stored;
alter table app.telegram_history_messages add column context_sent_at timestamptz;
-- The migration operator must bypass FORCE RLS for the global backfill.
-- app_owner has no owner-scoped runtime context and would silently update zero rows.
reset role;
set local row_security=off;
update app.telegram_history_messages set context_sent_at=(body->>'sentAt')::timestamptz;
set local row_security=on;
set local role app_owner;
create index telegram_context_document_gin on app.telegram_history_messages using gin(context_document);
create index telegram_context_order_idx on app.telegram_history_messages(organization_id,owner_user_id,context_sent_at desc,chat_id desc,message_id desc);
create index telegram_context_chat_title_idx on app.telegram_history_chats(organization_id,owner_user_id,title,id);
grant create on schema app to app_executor;
reset role;
set local role app_executor;
create function app.telegram_context_timestamp_v1() returns trigger language plpgsql set search_path=pg_catalog,app,pg_temp as $$ begin
 new.context_sent_at := (new.body->>'sentAt')::timestamptz; return new;
end $$;
reset role;
set local role app_owner;
create trigger telegram_context_timestamp before insert or update of body on app.telegram_history_messages for each row execute function app.telegram_context_timestamp_v1();
reset role;
set local role app_executor;
create function app.telegram_context_validate_v1(p jsonb,mode text) returns void language plpgsql set search_path=pg_catalog,app,pg_temp as $$
declare k text; allowed text[]; v text; c jsonb:=p->'after';
begin
 allowed:=case mode when 'search' then array['action','query','chatId','sender','from','to','attachmentsOnly','after'] when 'chats' then array['action','query','after'] when 'view' then array['chatId','anchor','before','after'] else null end;
 if allowed is null or jsonb_typeof(p) is distinct from 'object' then raise exception using errcode='22023',message='invalid request'; end if;
 if exists(select 1 from jsonb_object_keys(p) x where not(x=any(allowed))) then raise exception using errcode='22023',message='invalid request'; end if;
 if mode<>'view' then
  if jsonb_typeof(p->'action') is distinct from 'string' or jsonb_typeof(p->'query') is distinct from 'string' or length(p->>'query')>(case when mode='chats' then 100 else 500 end) or p->>'query' ~ '[[:cntrl:]]' then raise exception using errcode='22023',message='invalid request'; end if;
 end if;
 if mode='view' and jsonb_typeof(p->'chatId') is distinct from 'string' then raise exception using errcode='22023',message='invalid chat'; end if;
 if p->>'chatId' is not null then
  if jsonb_typeof(p->'chatId')<>'string' or p->>'chatId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception using errcode='22023',message='invalid chat'; end if;
 end if;
 if mode='search' then
  if p->>'sender' is not null and (jsonb_typeof(p->'sender')<>'string' or p->>'sender' !~ '^[a-z0-9_]{1,32}$') then raise exception using errcode='22023',message='invalid sender'; end if;
  if p->>'attachmentsOnly' is not null and jsonb_typeof(p->'attachmentsOnly')<>'boolean' then raise exception using errcode='22023',message='invalid filter'; end if;
  foreach k in array array['from','to'] loop
   v:=p->>k;
   if v is not null and (jsonb_typeof(p->k)<>'string' or v !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or v<'0001-01-01' or to_char(v::date,'YYYY-MM-DD')<>v) then raise exception using errcode='22023',message='invalid date'; end if;
  end loop;
 end if;
 if mode='view' then
  foreach k in array array['anchor','before','after'] loop
   v:=p->>k;
   if v is not null and (jsonb_typeof(p->k)<>'string' or v !~ '^[1-9][0-9]{0,9}$' or v::bigint>2147483647) then raise exception using errcode='22023',message='invalid message id'; end if;
  end loop;
 elsif c is not null and c<>'null'::jsonb then
  allowed:=case mode when 'chats' then array['digest','title','id'] else array['digest','sentAt','chatId','messageId'] end;
  if jsonb_typeof(c)<>'object' or (select count(*) from jsonb_object_keys(c))<>cardinality(allowed) or exists(select 1 from jsonb_object_keys(c) x where not(x=any(allowed)) or jsonb_typeof(c->x)<>'string') or c->>'digest' !~ '^[a-f0-9]{64}$' then raise exception using errcode='22023',message='invalid cursor'; end if;
  if mode='chats' then
   if length(c->>'title') not between 1 and 200 or c->>'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception using errcode='22023',message='invalid cursor'; end if;
  else
   if c->>'chatId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or c->>'messageId' !~ '^[1-9][0-9]{0,9}$' or (c->>'messageId')::bigint>2147483647 or c->>'sentAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' then raise exception using errcode='22023',message='invalid cursor'; end if;
   perform (c->>'sentAt')::timestamptz;
  end if;
 end if;
exception when invalid_text_representation or datetime_field_overflow or invalid_datetime_format or numeric_value_out_of_range then raise exception using errcode='22023',message='invalid request';
end $$;
create function app.telegram_context_search_v1(p jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,app,pg_temp as $$
declare result jsonb; digest text; cursor jsonb:=p->'after'; term tsquery; action text:=p->>'action'; query text:=p->>'query';
begin
 perform app.recruitment_actor_v1(array['candidates.read'],null,null,false);
 perform app.telegram_context_validate_v1(p,action);
 if action not in ('search','chats') or query is null or length(query)>(case when action='chats' then 100 else 500 end) then raise exception using errcode='22023',message='invalid search request'; end if;
 digest:=encode(sha256(convert_to((p-'after')::text || app.context_uuid_v1('app.organization_id')::text || app.context_uuid_v1('app.actor_id')::text,'UTF8')),'hex');
 if cursor is not null and cursor<>'null'::jsonb and cursor->>'digest' is distinct from digest then raise exception using errcode='22023',message='invalid cursor'; end if;
 if action='chats' then
  if cursor is not null and cursor<>'null'::jsonb and (cursor->>'title' is null or cursor->>'id' is null) then raise exception using errcode='22023',message='invalid cursor'; end if;
  with page as materialized (
   select c.id,c.title,c.username,a.account_user_id from app.telegram_history_chats c join app.telegram_history_accounts a on a.id=c.account_id
   where (query='' or strpos(lower(c.title),lower(query))>0 or strpos(lower(coalesce(c.username,'')),lower(query))>0)
   and (cursor is null or cursor='null'::jsonb or (c.title,c.id)>(cursor->>'title',(cursor->>'id')::uuid))
   order by c.title,c.id limit 51
  ), shown as (select * from page order by title,id limit 50)
  select jsonb_build_object('chats',coalesce((select jsonb_agg(jsonb_build_object('id',id,'title',title,'username',username,'accountUserId',account_user_id) order by title,id) from shown),'[]'::jsonb),
   'nextAfter',case when (select count(*) from page)>50 then (select jsonb_build_object('digest',digest,'title',title,'id',id) from shown order by title desc,id desc limit 1) else null end) into result;
  return result;
 end if;
 if length(query)=0 then raise exception using errcode='22023',message='positive search term required'; end if;
 term:=websearch_to_tsquery('simple'::regconfig,query);
 if querytree(term) in ('','T') then raise exception using errcode='22023',message='positive search term required'; end if;
 if (p->>'from')::date > (p->>'to')::date then raise exception using errcode='22023',message='invalid date range'; end if;
 if cursor is not null and cursor<>'null'::jsonb and (cursor->>'sentAt' is null or cursor->>'chatId' is null or cursor->>'messageId' is null) then raise exception using errcode='22023',message='invalid cursor'; end if;
 with page as materialized (
  select m.*,c.title from app.telegram_history_messages m join app.telegram_history_chats c on c.id=m.chat_id
  where m.context_document @@ term and m.context_sent_at is not null
  and (p->>'chatId' is null or m.chat_id=(p->>'chatId')::uuid)
  and (p->>'sender' is null or lower(m.body->'sender'->>'username')=p->>'sender')
  and (p->>'from' is null or m.context_sent_at>=((p->>'from')::date::timestamp at time zone 'UTC'))
  and (p->>'to' is null or m.context_sent_at<(((p->>'to')::date+1)::timestamp at time zone 'UTC'))
  and (not coalesce((p->>'attachmentsOnly')::boolean,false) or jsonb_array_length(m.body->'attachments')>0)
  and (cursor is null or cursor='null'::jsonb or (m.context_sent_at,m.chat_id,m.message_id)<((cursor->>'sentAt')::timestamptz,(cursor->>'chatId')::uuid,(cursor->>'messageId')::bigint))
  order by m.context_sent_at desc,m.chat_id desc,m.message_id desc limit 26
 ), shown as (select * from page order by context_sent_at desc,chat_id desc,message_id desc limit 25)
 select jsonb_build_object('results',coalesce((select jsonb_agg(body || jsonb_build_object('chatId',chat_id,'chatTitle',title) order by context_sent_at desc,chat_id desc,message_id desc) from shown),'[]'::jsonb),
 'nextAfter',case when (select count(*) from page)>25 then (select jsonb_build_object('digest',digest,'sentAt',context_sent_at,'chatId',chat_id,'messageId',message_id::text) from shown order by context_sent_at,chat_id,message_id limit 1) else null end,
 'query',query,'coverage',jsonb_build_object('retainedMessages',coalesce((select stored_messages from app.telegram_history_limits),(select count(*) from app.telegram_history_messages)))) into result;
 return result;
end $$;
create function app.telegram_context_view_v1(p jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,app,pg_temp as $$
declare chat jsonb; result jsonb; anchor bigint; before_id bigint; after_id bigint; v_chat_id uuid;
begin
 perform app.recruitment_actor_v1(array['candidates.read'],null,null,false);
 perform app.telegram_context_validate_v1(p,'view');
 v_chat_id:=(p->>'chatId')::uuid; anchor:=(p->>'anchor')::bigint; before_id:=(p->>'before')::bigint; after_id:=(p->>'after')::bigint;
 if num_nonnulls(anchor,before_id,after_id)>1 or coalesce(anchor,before_id,after_id,1) not between 1 and 2147483647 then raise exception using errcode='22023',message='invalid context request'; end if;
 select jsonb_build_object('id',c.id,'title',c.title,'username',c.username,'accountUserId',a.account_user_id) into chat from app.telegram_history_chats c join app.telegram_history_accounts a on a.id=c.account_id where c.id=v_chat_id;
 if chat is null then raise exception using errcode='P0002',message='chat not found'; end if;
 with selected as materialized (
  (select m.message_id,m.body from app.telegram_history_messages m where m.chat_id=v_chat_id and anchor is not null and m.message_id<anchor order by m.message_id desc limit 20)
  union all
  (select m.message_id,m.body from app.telegram_history_messages m where m.chat_id=v_chat_id and anchor is not null and m.message_id>=anchor order by m.message_id limit 21)
  union all
  (select m.message_id,m.body from app.telegram_history_messages m where m.chat_id=v_chat_id and anchor is null and after_id is null and (before_id is null or m.message_id<before_id) order by m.message_id desc limit 50)
  union all
  (select m.message_id,m.body from app.telegram_history_messages m where m.chat_id=v_chat_id and anchor is null and after_id is not null and m.message_id>after_id order by m.message_id limit 50)
 ), bounds as (select min(message_id) lo,max(message_id) hi from selected)
 select jsonb_build_object('chat',chat,'messages',coalesce((select jsonb_agg(body || jsonb_build_object('chatId',v_chat_id) order by message_id) from selected),'[]'::jsonb),
 'anchorUnavailable',anchor is not null and not exists(select 1 from app.telegram_history_messages m where m.chat_id=v_chat_id and m.message_id=anchor and m.body->>'kind'<>'unavailable'),
 'olderBefore',case when exists(select 1 from app.telegram_history_messages m,bounds b where m.chat_id=v_chat_id and m.message_id<b.lo) then (select lo::text from bounds) else null end,
 'newerAfter',case when exists(select 1 from app.telegram_history_messages m,bounds b where m.chat_id=v_chat_id and m.message_id>b.hi) then (select hi::text from bounds) else null end) into result;
 return result;
end $$;
revoke all on function app.telegram_context_validate_v1(jsonb,text),app.telegram_context_timestamp_v1(),app.telegram_context_search_v1(jsonb),app.telegram_context_view_v1(jsonb) from public;
grant execute on function app.telegram_context_search_v1(jsonb),app.telegram_context_view_v1(jsonb) to app_staff;
reset role;
set local role app_owner;
revoke create on schema app from app_executor;
commit;
