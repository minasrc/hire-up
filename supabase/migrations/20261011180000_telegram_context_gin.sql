-- Native @@ is not leakproof. Put it inside this non-bypass role's RLS
-- predicate so PostgreSQL can use GIN without weakening the owner boundary.
begin;
set local lock_timeout='2s'; set local statement_timeout='30s';
create role app_telegram_context_indexer nologin noinherit nosuperuser nocreatedb nocreaterole nobypassrls;
do $$ begin
 if not (select rolsuper from pg_roles where rolname=session_user) then
  execute format('grant app_telegram_context_indexer to %I with inherit false,set true',session_user);
 end if;
end $$;
set local role app_owner;
grant usage on schema app to app_telegram_context_indexer;
grant execute on function app.context_uuid_v1(text) to app_telegram_context_indexer;
grant select on app.telegram_history_messages to app_telegram_context_indexer;
create policy telegram_context_index_owner on app.telegram_history_messages for select to app_telegram_context_indexer
 using(organization_id=app.context_uuid_v1('app.organization_id') and owner_user_id=app.context_uuid_v1('app.actor_id')
 and context_document @@ nullif(current_setting('app.telegram_context_tsquery',true),'')::tsquery);
grant create on schema app to app_telegram_context_indexer,app_executor;
reset role; set local role app_executor;
grant execute on function app.telegram_context_validate_v1(jsonb,text) to app_telegram_context_indexer;
reset role; set local role app_telegram_context_indexer;
create function app.telegram_context_index_page_v1(p jsonb)
returns table(chat_id uuid,message_id bigint,body jsonb,context_sent_at timestamptz)
language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp set statement_timeout='10s' as $$
declare term tsquery; cursor jsonb:=p->'after'; digest text; prior_query text:=current_setting('app.telegram_context_tsquery',true);
begin
 if app.context_uuid_v1('app.organization_id') is null or app.context_uuid_v1('app.actor_id') is null then raise exception 'Staff scope required' using errcode='42501'; end if;
 perform app.telegram_context_validate_v1(p,'search');
 if p->>'action' is distinct from 'search' or octet_length(p::text)>8192 then raise exception 'Invalid search request' using errcode='22023'; end if;
 term:=websearch_to_tsquery('simple'::regconfig,p->>'query');
 if querytree(term) in ('','T') then raise exception 'positive search term required' using errcode='22023'; end if;
 if (p->>'from')::date>(p->>'to')::date then raise exception 'Invalid date range' using errcode='22023'; end if;
 digest:=encode(sha256(convert_to((p-'after')::text||app.context_uuid_v1('app.organization_id')::text||app.context_uuid_v1('app.actor_id')::text,'UTF8')),'hex');
 if cursor is not null and cursor<>'null'::jsonb and cursor->>'digest' is distinct from digest then raise exception 'Invalid cursor' using errcode='22023'; end if;
 perform set_config('app.telegram_context_tsquery',term::text,true);
 return query select m.chat_id,m.message_id,m.body,m.context_sent_at from app.telegram_history_messages m
 where m.context_sent_at is not null
 and (p->>'chatId' is null or m.chat_id=(p->>'chatId')::uuid)
 and (p->>'sender' is null or lower(m.body->'sender'->>'username')=p->>'sender')
 and (p->>'from' is null or m.context_sent_at>=((p->>'from')::date::timestamp at time zone 'UTC'))
 and (p->>'to' is null or m.context_sent_at<(((p->>'to')::date+1)::timestamp at time zone 'UTC'))
 and (not coalesce((p->>'attachmentsOnly')::boolean,false) or jsonb_array_length(m.body->'attachments')>0)
 and (cursor is null or cursor='null'::jsonb or (m.context_sent_at,m.chat_id,m.message_id)<((cursor->>'sentAt')::timestamptz,(cursor->>'chatId')::uuid,(cursor->>'messageId')::bigint))
 order by m.context_sent_at desc,m.chat_id desc,m.message_id desc limit 26;
 perform set_config('app.telegram_context_tsquery',coalesce(prior_query,''),true);
exception when others then
 perform set_config('app.telegram_context_tsquery',coalesce(prior_query,''),true);
 raise;
end $$;
revoke all on function app.telegram_context_index_page_v1(jsonb) from public;
grant execute on function app.telegram_context_index_page_v1(jsonb) to app_executor;
reset role; set local role app_executor;
create or replace function app.telegram_context_search_v1(p jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,app,pg_temp set statement_timeout='10s' as $$
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
 with indexed_page as materialized (select * from app.telegram_context_index_page_v1(p)), page as materialized (
  select m.*,c.title from indexed_page m join app.telegram_history_chats c on c.id=m.chat_id
 ), shown as (select * from page order by context_sent_at desc,chat_id desc,message_id desc limit 25)
 select jsonb_build_object('results',coalesce((select jsonb_agg(body || jsonb_build_object('chatId',chat_id,'chatTitle',title) order by context_sent_at desc,chat_id desc,message_id desc) from shown),'[]'::jsonb),
 'nextAfter',case when (select count(*) from page)>25 then (select jsonb_build_object('digest',digest,'sentAt',context_sent_at,'chatId',chat_id,'messageId',message_id::text) from shown order by context_sent_at,chat_id,message_id limit 1) else null end,
 'query',query,'coverage',jsonb_build_object('retainedMessages',coalesce((select stored_messages from app.telegram_history_limits),(select count(*) from app.telegram_history_messages)))) into result;
 return result;
end $$;
reset role; set local role app_owner;
revoke create on schema app from app_telegram_context_indexer,app_executor;
reset role;
do $$ begin
 if not (select rolsuper from pg_roles where rolname=session_user) then
  -- PostgreSQL 17 keeps the creator's ADMIN-only membership; remove temporary SET.
  execute format('revoke app_telegram_context_indexer from %I',session_user);
 end if;
end $$;
commit;
