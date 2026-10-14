begin;
set local lock_timeout='2s';
set local statement_timeout='30s';
set local role app_owner;
alter table app.telegram_history_limits add column onboarding_completed_at timestamptz;
update app.telegram_history_limits l set onboarding_completed_at=now()
where exists(select 1 from app.telegram_history_jobs j where j.organization_id=l.organization_id and j.owner_user_id=l.owner_user_id and j.kind='history');
grant create on schema app to app_executor;
reset role;
set local role app_executor;
create function app.telegram_onboarding_complete_v1() returns boolean
language plpgsql stable security definer set search_path=pg_catalog,app,pg_temp as $$
begin
 perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
 return exists(select 1 from app.telegram_history_limits where onboarding_completed_at is not null)
 or exists(select 1 from app.telegram_history_jobs where kind='history');
end $$;
revoke all on function app.telegram_onboarding_complete_v1() from public;
grant execute on function app.telegram_onboarding_complete_v1() to app_staff;
create or replace function app.telegram_candidate_start_v1(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare r jsonb; ids jsonb;
begin
 perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
 perform app.telegram_extraction_lock_v1();
 -- Both actions commit together: a failed selection never leaves extraction enabled.
 r:=app.telegram_history_action_v1(p_input||jsonb_build_object('action','selectMany','selected',true));
 select jsonb_agg(value->'chatId') into ids from jsonb_array_elements(p_input->'chats');
 perform app.telegram_extraction_action_v1(jsonb_build_object('action','enqueue','chatIds',ids));
 update app.telegram_history_limits set onboarding_completed_at=coalesce(onboarding_completed_at,now());
 return r;
end $$;

reset role;
set local role app_owner;
revoke create on schema app from app_executor;
commit;
