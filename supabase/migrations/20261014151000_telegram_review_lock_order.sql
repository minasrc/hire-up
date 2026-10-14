begin;
set local lock_timeout='2s';
set local statement_timeout='30s';
set local role app_owner;
grant create on schema app to app_executor;
reset role;
set local role app_executor;

-- Inbox reads prepare drafts and their shared source jobs. Take the same owner
-- lock as approvals before any draft row lock, so concurrent refreshes cannot
-- hold a draft while waiting for an approval's extraction lock.
alter function app.telegram_review_prepare_v1(uuid) rename to telegram_review_prepare_before_lock_order_v1;
create function app.telegram_review_prepare_v1(p_id uuid) returns void
language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
begin
 perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
 perform app.telegram_extraction_lock_v1();
 perform app.telegram_review_prepare_before_lock_order_v1(p_id);
end $$;
revoke all on function app.telegram_review_prepare_v1(uuid),app.telegram_review_prepare_before_lock_order_v1(uuid) from public;

reset role;
set local role app_owner;
revoke create on schema app from app_executor;
commit;
