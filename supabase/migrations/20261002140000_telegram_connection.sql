begin;
set local lock_timeout='2s';
set local statement_timeout='30s';
set local role app_owner;
alter table app.telegram_workers add constraint telegram_workers_owner_identity unique(organization_id,owner_user_id,id);
create table app.telegram_connector_workers (
    id uuid primary key,
    organization_id uuid not null,
    owner_user_id uuid not null,
    public_key_spki text not null check(char_length(public_key_spki)=392 and public_key_spki ~ '^[A-Za-z0-9+/]+={0,2}$'),
    last_seen_at timestamptz not null default now(),
    foreign key(organization_id,owner_user_id,id) references app.telegram_workers(organization_id,owner_user_id,id)
);
create table app.telegram_connections (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null,
    owner_user_id uuid not null,
    worker_id uuid not null references app.telegram_connector_workers(id),
    generation bigint not null default 1 check(generation>0),
    status text not null check(status in ('requested','qr_pending','awaiting_password','connected','disconnecting','disconnected','failed')),
    challenge_id uuid not null default gen_random_uuid(),
    auth_expires_at timestamptz not null,
    qr_login_url text check(qr_login_url is null or (char_length(qr_login_url)<=528 and qr_login_url ~ '^tg://login\?token=[A-Za-z0-9_-]+$')),
    qr_expires_at timestamptz,
    password_hint text check(password_hint is null or char_length(password_hint)<=100),
    password_ciphertext text check(password_ciphertext is null or (char_length(password_ciphertext)=344 and password_ciphertext ~ '^[A-Za-z0-9+/]+==$')),
    password_expires_at timestamptz,
    password_submission_id uuid,
    last_password_submission_id uuid,
    profile jsonb,
    error_code text check(error_code is null or error_code in ('AUTH_FAILED','PASSWORD_INVALID','LOGIN_EXPIRED','SESSION_MISSING','SESSION_REVOKED','TELEGRAM_UNAVAILABLE','LOGOUT_FAILED')),
    lease_token uuid,
    ever_leased boolean not null default false,
    cancelled_before_start boolean not null default false,
    lease_expires_at timestamptz,
    updated_at timestamptz not null default now(),
    unique(organization_id,owner_user_id),
    foreign key(organization_id,owner_user_id,worker_id) references app.telegram_workers(organization_id,owner_user_id,id)
);
do $$ declare t text; begin
    foreach t in array array['telegram_connector_workers','telegram_connections'] loop
        execute format('alter table app.%I enable row level security',t);
        execute format('alter table app.%I force row level security',t);
        execute format('grant select,insert,update,delete on app.%I to app_executor',t);
        execute format('create policy telegram_connection_owner on app.%I for all to app_executor using(organization_id=app.context_uuid_v1(''app.organization_id'') and owner_user_id=app.context_uuid_v1(''app.actor_id'')) with check(organization_id=app.context_uuid_v1(''app.organization_id'') and owner_user_id=app.context_uuid_v1(''app.actor_id''))',t);
    end loop;
end $$;
grant create on schema app to app_executor;
reset role;
set local role app_executor;

create function app.telegram_connection_expire_v1()
returns void language plpgsql volatile set search_path=pg_catalog,app,pg_temp as $$ begin
    update app.telegram_connections set status='failed',generation=generation+1,error_code='LOGIN_EXPIRED',qr_login_url=null,qr_expires_at=null,password_hint=null,password_ciphertext=null,password_expires_at=null,password_submission_id=null,last_password_submission_id=null,lease_token=null,lease_expires_at=null,updated_at=clock_timestamp()
      where status in ('requested','qr_pending','awaiting_password') and auth_expires_at<=clock_timestamp();
    update app.telegram_connections set password_ciphertext=null,password_expires_at=null,password_submission_id=null
      where password_expires_at<=clock_timestamp();
end $$;
create function app.telegram_connection_json_v1(c app.telegram_connections)
returns jsonb language sql stable set search_path=pg_catalog,app,pg_temp as $$
    select jsonb_build_object('id',c.id,'workerId',c.worker_id,'generation',c.generation,'status',c.status,'challengeId',c.challenge_id,
      'qrLoginUrl',case when c.qr_expires_at>now() then c.qr_login_url end,'qrExpiresAt',c.qr_expires_at,
      'passwordHint',c.password_hint,'passwordPending',c.password_ciphertext is not null and c.password_expires_at>now(),
      'errorCode',c.error_code,'cancelledBeforeStart',c.cancelled_before_start,'profile',c.profile,'updatedAt',c.updated_at);
$$;
create function app.telegram_connection_status_v1()
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare c app.telegram_connections; workers jsonb; begin
    perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
    perform app.telegram_connection_expire_v1();
    select * into c from app.telegram_connections;
    select coalesce(jsonb_agg(jsonb_build_object('id',k.id,'name',w.name,'publicKeySpki',k.public_key_spki,'lastSeenAt',k.last_seen_at,'online',k.last_seen_at>clock_timestamp()-interval '90 seconds') order by k.last_seen_at desc),'[]'::jsonb)
      into workers from app.telegram_connector_workers k join app.telegram_workers w on w.id=k.id
      where w.organization_id=app.context_uuid_v1('app.organization_id') and w.owner_user_id=app.context_uuid_v1('app.actor_id') and w.revoked_at is null and w.expires_at>clock_timestamp();
    return jsonb_build_object('workers',workers,'connection',case when c.id is null then null else app.telegram_connection_json_v1(c) end);
end $$;
create function app.telegram_connection_start_v1(p_worker uuid)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare c app.telegram_connections; w app.telegram_workers; begin
    perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
    select * into w from app.telegram_workers where id=p_worker and organization_id=app.context_uuid_v1('app.organization_id') and owner_user_id=app.context_uuid_v1('app.actor_id') and revoked_at is null and expires_at>clock_timestamp() for share;
    if not found or not exists(select 1 from app.telegram_connector_workers where id=p_worker and last_seen_at>clock_timestamp()-interval '90 seconds') then raise exception 'Connector unavailable' using errcode='40001'; end if;
    perform app.telegram_connection_expire_v1();
    select * into c from app.telegram_connections for update;
    if found and c.status not in ('failed','disconnected') then
        if c.worker_id<>p_worker then raise exception 'Connection active' using errcode='40001'; end if;
        return app.telegram_connection_status_v1();
    end if;
    insert into app.telegram_connections(organization_id,owner_user_id,worker_id,status,auth_expires_at)
      values(app.context_uuid_v1('app.organization_id'),app.context_uuid_v1('app.actor_id'),p_worker,'requested',clock_timestamp()+interval '10 minutes')
      on conflict(organization_id,owner_user_id) do update set worker_id=excluded.worker_id,status='requested',cancelled_before_start=false,generation=telegram_connections.generation+1,challenge_id=gen_random_uuid(),auth_expires_at=excluded.auth_expires_at,qr_login_url=null,qr_expires_at=null,password_hint=null,password_ciphertext=null,password_expires_at=null,password_submission_id=null,last_password_submission_id=null,profile=null,error_code=null,lease_token=null,lease_expires_at=null,updated_at=clock_timestamp() where telegram_connections.status in ('failed','disconnected');
    return app.telegram_connection_status_v1();
end $$;
create function app.telegram_connection_password_v1(p_id uuid,p_generation bigint,p_challenge uuid,p_ciphertext text)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare c app.telegram_connections; begin
    perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
    perform app.telegram_connection_expire_v1();
    if p_ciphertext is null or char_length(p_ciphertext)<>344 or p_ciphertext !~ '^[A-Za-z0-9+/]+==$' then raise exception 'Invalid encrypted submission' using errcode='22023'; end if;
    select * into c from app.telegram_connections where id=p_id for update;
    if not found or c.generation is distinct from p_generation or c.challenge_id is distinct from p_challenge or c.status<>'awaiting_password' then raise exception 'Challenge changed' using errcode='40001'; end if;
    if c.password_ciphertext is not null and c.password_ciphertext<>p_ciphertext then raise exception 'Submission pending' using errcode='40001'; end if;
    update app.telegram_connections set password_ciphertext=p_ciphertext,password_submission_id=coalesce(password_submission_id,gen_random_uuid()),password_expires_at=coalesce(password_expires_at,clock_timestamp()+interval '60 seconds'),error_code=null,updated_at=clock_timestamp() where id=p_id;
    return app.telegram_connection_status_v1();
end $$;
create function app.telegram_connection_disconnect_v1(p_id uuid,p_generation bigint)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare c app.telegram_connections; begin
    perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
    select * into c from app.telegram_connections where id=p_id for update;
    if not found then raise exception 'Connection unavailable' using errcode='P0002'; end if;
    if c.status in ('disconnecting','disconnected') then return app.telegram_connection_status_v1(); end if;
    if c.generation is distinct from p_generation then raise exception 'Connection changed' using errcode='40001'; end if;
    update app.telegram_connections set status=case when c.status='requested' and not c.ever_leased and c.lease_token is null then 'disconnected' else 'disconnecting' end,cancelled_before_start=(c.status='requested' and not c.ever_leased and c.lease_token is null),generation=generation+1,qr_login_url=null,qr_expires_at=null,password_hint=null,password_ciphertext=null,password_expires_at=null,password_submission_id=null,last_password_submission_id=null,profile=null,error_code=null,lease_token=null,lease_expires_at=null,updated_at=clock_timestamp() where id=p_id;
    return app.telegram_connection_status_v1();
end $$;
create function app.telegram_connection_heartbeat_v1(p_token text,p_key text)
returns boolean language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare w uuid; oldkey text; begin
    w:=app.telegram_worker_context_v1(p_token);
    if p_key is null or char_length(p_key)<>392 or p_key !~ '^[A-Za-z0-9+/]+={0,2}$' then raise exception 'Invalid connector key' using errcode='22023'; end if;
    select public_key_spki into oldkey from app.telegram_connector_workers where id=w;
    if oldkey is not null and oldkey<>p_key and exists(select 1 from app.telegram_connections where worker_id=w and status<>'disconnected') then raise exception 'Connector key is in use' using errcode='40001'; end if;
    insert into app.telegram_connector_workers(id,organization_id,owner_user_id,public_key_spki)
      values(w,app.context_uuid_v1('app.organization_id'),app.context_uuid_v1('app.actor_id'),p_key)
      on conflict(id) do update set public_key_spki=excluded.public_key_spki,last_seen_at=clock_timestamp();
    return true;
end $$;
create function app.telegram_connection_claim_v1(p_token text)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare w uuid; c app.telegram_connections; begin
    w:=app.telegram_worker_context_v1(p_token);
    perform app.telegram_connection_expire_v1();
    select * into c from app.telegram_connections where worker_id=w and status<>'disconnected' for update;
    if not found then return null; end if;
    update app.telegram_connections set ever_leased=true,lease_token=case when lease_token is not null and lease_expires_at>clock_timestamp() then lease_token else gen_random_uuid() end,lease_expires_at=clock_timestamp()+interval '120 seconds' where id=c.id returning * into c;
    return jsonb_build_object('id',c.id,'generation',c.generation,'status',c.status,'leaseToken',c.lease_token,'leaseExpiresAt',c.lease_expires_at,'challengeId',c.challenge_id,'passwordCiphertext',c.password_ciphertext,'passwordSubmissionId',c.password_submission_id,'passwordExpiresAt',c.password_expires_at);
end $$;
create function app.telegram_connection_update_v1(p_token text,p_id uuid,p_generation bigint,p_lease uuid,p_update jsonb)
returns boolean language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare w uuid; c app.telegram_connections; s text; expiry timestamptz; v_profile jsonb; begin
    w:=app.telegram_worker_context_v1(p_token);
    perform app.telegram_connection_expire_v1();
    select * into c from app.telegram_connections where id=p_id and worker_id=w for update;
    if not found or c.generation is distinct from p_generation or c.lease_token is distinct from p_lease or c.lease_expires_at<=clock_timestamp() then raise exception 'Connection lease changed' using errcode='40001'; end if;
    if p_update is null or jsonb_typeof(p_update)<>'object' or exists(select 1 from jsonb_object_keys(p_update) k where k not in ('status','challengeId','qrLoginUrl','qrExpiresAt','passwordHint','profile','errorCode','passwordSubmissionId')) then raise exception 'Invalid connection report' using errcode='22023'; end if;
    s:=p_update->>'status';
    if s is null or s not in ('qr_pending','awaiting_password','connected','disconnecting','disconnected','failed') then raise exception 'Invalid connection state' using errcode='22023'; end if;
    if s='awaiting_password' and p_update->>'passwordSubmissionId' is not null and p_update->>'passwordSubmissionId'=c.last_password_submission_id::text then return true; end if;
    if (c.status='disconnecting' and s not in ('disconnecting','disconnected')) or (c.status<>'disconnecting' and s in ('disconnecting','disconnected')) or (c.status='connected' and s not in ('connected','failed')) or (c.status='failed' and s<>'failed') or c.status='disconnected' then raise exception 'Invalid connection transition' using errcode='40001'; end if;
    if s in ('qr_pending','awaiting_password') and (p_update->>'challengeId') is distinct from c.challenge_id::text then raise exception 'Challenge changed' using errcode='40001'; end if;
    if s='qr_pending' then
      expiry:=(p_update->>'qrExpiresAt')::timestamptz;
      if p_update->>'qrLoginUrl' is null or char_length(p_update->>'qrLoginUrl')>528 or p_update->>'qrLoginUrl' !~ '^tg://login\?token=[A-Za-z0-9_-]+$' or expiry is null or expiry<=clock_timestamp() or expiry>clock_timestamp()+interval '120 seconds' then raise exception 'Invalid QR challenge' using errcode='22023'; end if;
    end if;
    if s='connected' then
      v_profile:=p_update->'profile';
      if v_profile is null or jsonb_typeof(v_profile)<>'object' or exists(select 1 from jsonb_object_keys(v_profile) k where k not in ('telegramUserId','username','displayName')) or coalesce(v_profile->>'telegramUserId','') !~ '^[0-9]{1,30}$' or jsonb_typeof(v_profile->'telegramUserId')<>'string' or jsonb_typeof(v_profile->'displayName') is distinct from 'string' or char_length(v_profile->>'displayName') not between 1 and 200 or (v_profile->>'username' is not null and v_profile->>'username' !~ '^[A-Za-z0-9_]{5,32}$') then raise exception 'Invalid connected profile' using errcode='22023'; end if;
    end if;
    if coalesce(char_length(p_update->>'passwordHint'),0)>100 then raise exception 'Invalid password hint' using errcode='22023'; end if;
    if p_update ? 'passwordSubmissionId' and (p_update->>'passwordSubmissionId') is distinct from c.password_submission_id::text then raise exception 'Password submission changed' using errcode='40001'; end if;
    update app.telegram_connections set status=s,ever_leased=case when s='disconnected' then false else ever_leased end,qr_login_url=case when s='qr_pending' then p_update->>'qrLoginUrl' end,qr_expires_at=expiry,password_hint=case when s='awaiting_password' then p_update->>'passwordHint' end,password_ciphertext=case when s='awaiting_password' and not(p_update ? 'passwordSubmissionId') then password_ciphertext end,password_expires_at=case when s='awaiting_password' and not(p_update ? 'passwordSubmissionId') then password_expires_at end,password_submission_id=case when s='awaiting_password' and not(p_update ? 'passwordSubmissionId') then password_submission_id end,last_password_submission_id=case when p_update ? 'passwordSubmissionId' then (p_update->>'passwordSubmissionId')::uuid else last_password_submission_id end,profile=v_profile,error_code=p_update->>'errorCode',updated_at=clock_timestamp() where id=p_id;
    return true;
end $$;
do $$ declare f record; begin
    for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app' and p.proname like 'telegram_connection_%' loop
      execute format('revoke all on function %s from public',f.signature);
    end loop;
end $$;
grant execute on function app.telegram_connection_status_v1(),app.telegram_connection_start_v1(uuid),app.telegram_connection_password_v1(uuid,bigint,uuid,text),app.telegram_connection_disconnect_v1(uuid,bigint) to app_staff;
grant execute on function app.telegram_connection_heartbeat_v1(text,text),app.telegram_connection_claim_v1(text),app.telegram_connection_update_v1(text,uuid,bigint,uuid,jsonb) to app_telegram_worker;
reset role;
set local role app_owner;
revoke create on schema app from app_executor;
commit;
