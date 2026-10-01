begin;
set local lock_timeout='2s';set local statement_timeout='30s';
create role app_worker_pairing nologin noinherit nosuperuser nocreatedb nocreaterole nobypassrls;
grant app_worker_pairing to app_telegram_worker with inherit false,set true;
set local role app_owner;
grant usage on schema app to app_worker_pairing;
create table app.worker_pairings(
 id uuid primary key default gen_random_uuid(),organization_id uuid not null,owner_user_id uuid not null,
 name text not null check(char_length(name) between 1 and 80),device_name text,
 invitation_sha256 bytea not null unique check(octet_length(invitation_sha256)=32),
 invite_operation uuid not null,invite_digest bytea not null,invite_receipt jsonb not null default '{}',
 claim_id uuid,claim_digest bytea,token_sha256 bytea unique,verifier_sha256 bytea,
 fingerprint text,worker_id uuid unique references app.telegram_workers(id),
 status text not null default 'invited' check(status in('invited','claimed','approved','cancelled','expired')),
 created_at timestamptz not null default now(),expires_at timestamptz not null default now()+interval '10 minutes',decided_at timestamptz,poll_after timestamptz,
 approve_operation uuid,approve_digest bytea,approve_receipt jsonb,cancel_operation uuid,cancel_digest bytea,cancel_receipt jsonb,
 foreign key(organization_id,owner_user_id) references app.organization_memberships(organization_id,user_id),
 unique(organization_id,owner_user_id,invite_operation),unique(organization_id,owner_user_id,approve_operation),unique(organization_id,owner_user_id,cancel_operation),
 check(token_sha256 is null or octet_length(token_sha256)=32),check(verifier_sha256 is null or octet_length(verifier_sha256)=32)
);
create index worker_pairing_owner_idx on app.worker_pairings(organization_id,owner_user_id,created_at,id);
create index worker_pairing_active_idx on app.worker_pairings(expires_at) where status in('invited','claimed');
create index worker_pairing_purge_idx on app.worker_pairings((coalesce(decided_at,expires_at)));
create table app.worker_pairing_budget(id boolean primary key default true check(id),minute_start timestamptz not null default 'epoch',request_count integer not null default 0 check(request_count between 0 and 600));
insert into app.worker_pairing_budget(id) values(true);
create table app.worker_pairing_owner_budget(organization_id uuid not null,owner_user_id uuid not null,hour_start timestamptz not null default 'epoch',invite_count integer not null default 0 check(invite_count between 0 and 10),primary key(organization_id,owner_user_id),foreign key(organization_id,owner_user_id) references app.organization_memberships(organization_id,user_id));
alter table app.telegram_workers add column renew_operation uuid,add column renew_digest bytea,add column renew_receipt jsonb;
create unique index telegram_worker_renew_operation_idx on app.telegram_workers(organization_id,owner_user_id,renew_operation) where renew_operation is not null;
create index telegram_worker_device_page_idx on app.telegram_workers(organization_id,owner_user_id,created_at desc,id desc);
do $$ declare t text;begin foreach t in array array['worker_pairings','worker_pairing_budget','worker_pairing_owner_budget'] loop
 execute format('alter table app.%I enable row level security',t);execute format('alter table app.%I force row level security',t);
 execute format('grant select,insert,update,delete on app.%I to app_executor',t);
 -- No runtime role has table privileges. Only narrow definer procedures may
 -- locate a public invitation; all staff procedures explicitly recheck owner.
 execute format('create policy worker_pairing_internal on app.%I to app_executor using(true) with check(true)',t);
 end loop;end $$;
grant create on schema app to app_executor;
reset role;set local role app_executor;
create function app.worker_pairing_error_v1(code text,http integer,retry integer default null) returns jsonb language sql immutable set search_path=pg_catalog,app,pg_temp as $$
 select jsonb_build_object('ok',false,'httpStatus',http,'code',code)||case when retry is null then '{}'::jsonb else jsonb_build_object('retryAfterSeconds',greatest(1,least(3600,retry))) end
$$;
create function app.worker_pairing_ok_v1(data jsonb,http integer default 200) returns jsonb language sql immutable set search_path=pg_catalog,app,pg_temp as $$select jsonb_build_object('ok',true,'httpStatus',http,'data',data)$$;
create function app.worker_pairing_uuid_v1(v jsonb) returns boolean language sql immutable set search_path=pg_catalog,app,pg_temp as $$select coalesce(jsonb_typeof(v)='string' and (v#>>'{}')~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false)$$;
create function app.worker_pairing_text_v1(v jsonb) returns boolean language sql immutable set search_path=pg_catalog,app,pg_temp as $$select coalesce(jsonb_typeof(v)='string' and char_length(v#>>'{}') between 1 and 80 and length(btrim(v#>>'{}'))>0 and (v#>>'{}')!~'[[:cntrl:]]',false)$$;
create function app.worker_pairing_shape_v1(p jsonb,keys text[]) returns boolean language plpgsql immutable set search_path=pg_catalog,app,pg_temp as $$begin if jsonb_typeof(p) is distinct from 'object' then return false;end if;return p?&keys and (p-keys)='{}';end $$;
create function app.worker_pairing_budget_v1() returns jsonb language plpgsql volatile set search_path=pg_catalog,app,pg_temp as $$declare b app.worker_pairing_budget;tm timestamptz:=date_trunc('minute',clock_timestamp());begin
 select * into b from app.worker_pairing_budget where id for update;
 if b.minute_start<>tm then update app.worker_pairing_budget set minute_start=tm,request_count=1 where id;return null;end if;
 if b.request_count>=600 then return app.worker_pairing_error_v1('PAIRING_RATE_LIMIT',429,ceil(extract(epoch from tm+interval '1 minute'-clock_timestamp()))::integer);end if;
 update app.worker_pairing_budget set request_count=request_count+1 where id;return null;
end $$;
create function app.worker_pairing_owner_allowed_v1(org uuid,actor uuid) returns boolean language plpgsql volatile set search_path=pg_catalog,app,pg_temp as $$begin
 perform set_config('app.organization_id',org::text,true);perform set_config('app.actor_id',actor::text,true);
 begin perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);return true;exception when insufficient_privilege then return false;end;
end $$;
create function app.worker_pairing_json_v1(p app.worker_pairings) returns jsonb language sql stable set search_path=pg_catalog,app,pg_temp as $$
 select jsonb_build_object('pairingId',p.id,'status',case when p.status in('invited','claimed') and p.expires_at<=now() then 'expired' else p.status end,'name',p.name,'deviceName',p.device_name,'expiresAt',p.expires_at,'deviceFingerprint',p.fingerprint,'worker',case when p.worker_id is not null then(select jsonb_build_object('id',w.id,'name',w.name,'expiresAt',w.expires_at) from app.telegram_workers w where w.id=p.worker_id and w.organization_id=p.organization_id and w.owner_user_id=p.owner_user_id) end)
$$;
create function app.worker_pairing_claim_v1(proof text,p jsonb) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare j app.worker_pairings;charged jsonb;digest bytea;v_fingerprint text;canonical text;
begin
 charged:=app.worker_pairing_budget_v1();if charged is not null then return charged;end if;
 if not app.worker_pairing_shape_v1(p,array['pairingId','claimId','deviceName','tokenSha256','verifierSha256']) or not app.worker_pairing_uuid_v1(p->'pairingId') or not app.worker_pairing_uuid_v1(p->'claimId') or not app.worker_pairing_text_v1(p->'deviceName') or jsonb_typeof(p->'tokenSha256') is distinct from 'string' or jsonb_typeof(p->'verifierSha256') is distinct from 'string' or coalesce(p->>'tokenSha256','')!~'^[a-f0-9]{64}$' or coalesce(p->>'verifierSha256','')!~'^[a-f0-9]{64}$' or octet_length(p::text)>4096 then return app.worker_pairing_error_v1('INVALID_INPUT',400);end if;
 if proof is null or proof!~'^[A-Za-z0-9_-]{43}$' then return app.worker_pairing_error_v1('PAIRING_UNAVAILABLE',404);end if;
 select * into j from app.worker_pairings where id=(p->>'pairingId')::uuid and invitation_sha256=sha256(convert_to(proof,'UTF8')) for update;
 if not found then return app.worker_pairing_error_v1('PAIRING_UNAVAILABLE',404);end if;
 if not app.worker_pairing_owner_allowed_v1(j.organization_id,j.owner_user_id) then return app.worker_pairing_error_v1('PAIRING_UNAVAILABLE',404);end if;
 digest:=sha256(convert_to(p::text,'UTF8'));
 if j.status='approved' and j.claim_digest=digest and j.decided_at>now()-interval '24 hours' then return app.worker_pairing_ok_v1(jsonb_build_object('pairingId',j.id,'status','approved'));end if;
 if j.status not in('invited','claimed') or j.expires_at<=clock_timestamp() then return app.worker_pairing_error_v1('PAIRING_UNAVAILABLE',404);end if;
 if j.status='claimed' then
 if j.claim_digest is distinct from digest then return app.worker_pairing_error_v1('PAIRING_CLAIMED',409);end if;
 return app.worker_pairing_ok_v1(jsonb_build_object('pairingId',j.id,'status','claimed','deviceFingerprint',j.fingerprint,'expiresAt',j.expires_at,'pollIntervalSeconds',5));end if;
 if exists(select 1 from app.telegram_workers where token_sha256=decode(p->>'tokenSha256','hex')) or exists(select 1 from app.worker_pairings where token_sha256=decode(p->>'tokenSha256','hex')) then return app.worker_pairing_error_v1('TOKEN_UNAVAILABLE',409);end if;
 -- Explicit JSON string composition matches JSON.stringify's compact array;
 -- all members are fixed ASCII UUID/hash strings, not arbitrary user text.
 canonical:='["worker-pairing-v1","'||j.id::text||'","'||((p->>'claimId')::uuid)::text||'","'||(p->>'tokenSha256')||'","'||(p->>'verifierSha256')||'"]';
 v_fingerprint:=left(encode(sha256(convert_to(canonical,'UTF8')),'hex'),12);
 update app.worker_pairings set status='claimed',claim_id=(p->>'claimId')::uuid,claim_digest=digest,device_name=p->>'deviceName',token_sha256=decode(p->>'tokenSha256','hex'),verifier_sha256=decode(p->>'verifierSha256','hex'),fingerprint=v_fingerprint where id=j.id;
 return app.worker_pairing_ok_v1(jsonb_build_object('pairingId',j.id,'status','claimed','deviceFingerprint',v_fingerprint,'expiresAt',j.expires_at,'pollIntervalSeconds',5));
end $$;
create function app.worker_pairing_poll_v1(proof text,p jsonb) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare j app.worker_pairings;w app.telegram_workers;charged jsonb;allowed boolean;
begin
 charged:=app.worker_pairing_budget_v1();if charged is not null then return charged;end if;
 if not app.worker_pairing_shape_v1(p,array['pairingId']) or not app.worker_pairing_uuid_v1(p->'pairingId') then return app.worker_pairing_error_v1('INVALID_INPUT',400);end if;
 if proof is null or proof!~'^[A-Za-z0-9_-]{43}$' then return app.worker_pairing_error_v1('PAIRING_UNAVAILABLE',404);end if;
 select * into j from app.worker_pairings where id=(p->>'pairingId')::uuid and verifier_sha256=sha256(convert_to(proof,'UTF8'));
 if not found or coalesce(j.decided_at,j.expires_at)<=now()-interval '24 hours' then return app.worker_pairing_error_v1('PAIRING_UNAVAILABLE',404);end if;
 -- Worker before pairing if both locks are required; no membership-wide UPDATE.
 if j.worker_id is not null then select * into w from app.telegram_workers where id=j.worker_id for share;end if;
 select * into j from app.worker_pairings where id=j.id and verifier_sha256=sha256(convert_to(proof,'UTF8')) for update;
 if not found then return app.worker_pairing_error_v1('PAIRING_UNAVAILABLE',404);end if;
 allowed:=app.worker_pairing_owner_allowed_v1(j.organization_id,j.owner_user_id);
 if not allowed or (j.status='approved' and (w.id is null or w.revoked_at is not null or w.expires_at<=clock_timestamp() or w.organization_id<>j.organization_id or w.owner_user_id<>j.owner_user_id)) then return app.worker_pairing_ok_v1(jsonb_build_object('status','access_denied'));end if;
 if j.status in('invited','claimed') and j.expires_at<=clock_timestamp() then return app.worker_pairing_ok_v1(jsonb_build_object('status','expired'));end if;
 if j.status in('cancelled','expired') then return app.worker_pairing_ok_v1(jsonb_build_object('status',j.status));end if;
 if j.poll_after>clock_timestamp() then return app.worker_pairing_error_v1('PAIRING_RATE_LIMIT',429,ceil(extract(epoch from j.poll_after-clock_timestamp()))::integer);end if;
 update app.worker_pairings set poll_after=clock_timestamp()+interval '5 seconds' where id=j.id;
 if j.status='approved' then return app.worker_pairing_ok_v1(jsonb_build_object('status','approved','worker',jsonb_build_object('id',w.id,'name',w.name,'expiresAt',w.expires_at),'organization',(select jsonb_build_object('id',id,'name',coalesce(nullif(left(regexp_replace(name,'[[:cntrl:]]','','g'),200),''),'Workspace')) from app.organizations where id=j.organization_id)));end if;
 return app.worker_pairing_ok_v1(jsonb_build_object('status','claimed','expiresAt',j.expires_at,'retryAfterSeconds',5));
end $$;
create function app.worker_device_status_v1(pairing uuid,cursor jsonb) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare j app.worker_pairings;org uuid:=app.context_uuid_v1('app.organization_id');actor uuid:=app.context_uuid_v1('app.actor_id');records jsonb;pending jsonb;next_page jsonb;organization jsonb;
begin
 perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
 select jsonb_build_object('id',id,'name',coalesce(nullif(left(regexp_replace(name,'[[:cntrl:]]','','g'),200),''),'Workspace')) into organization from app.organizations where id=org;
 if pairing is not null then select * into j from app.worker_pairings where id=pairing and organization_id=org and owner_user_id=actor;
 if not found then return app.worker_pairing_error_v1('PAIRING_UNAVAILABLE',404);end if;
 return app.worker_pairing_ok_v1(app.worker_pairing_json_v1(j)||jsonb_build_object('organization',organization));end if;
 if cursor is not null and (not app.worker_pairing_shape_v1(cursor,array['createdAt','id']) or not app.worker_pairing_uuid_v1(cursor->'id') or jsonb_typeof(cursor->'createdAt') is distinct from 'string') then return app.worker_pairing_error_v1('INVALID_INPUT',400);end if;
 with page as materialized(select w.* from app.telegram_workers w where w.organization_id=org and w.owner_user_id=actor and (cursor is null or (w.created_at,w.id)<((cursor->>'createdAt')::timestamptz,(cursor->>'id')::uuid)) order by w.created_at desc,w.id desc limit 26)
 select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'createdAt',p.created_at,'expiresAt',p.expires_at,'revokedAt',p.revoked_at,'lastSeenAt',p.last_seen_at,'connectorLastSeenAt',k.last_seen_at,'compatibleSearchLastSeenAt',p.last_search_seen_at) order by p.created_at desc,p.id desc),'[]') into records from page p left join app.telegram_connector_workers k on k.id=p.id and k.organization_id=org and k.owner_user_id=actor;
 if jsonb_array_length(records)>25 then records:=records-25;next_page:=jsonb_build_object('createdAt',records->24->'createdAt','id',records->24->'id');end if;
 select coalesce(jsonb_agg(jsonb_build_object('pairingId',id,'status',status,'name',name,'deviceName',device_name,'expiresAt',expires_at,'deviceFingerprint',fingerprint) order by created_at desc,id desc),'[]') into pending from app.worker_pairings where organization_id=org and owner_user_id=actor and status in('invited','claimed') and expires_at>clock_timestamp();
 return app.worker_pairing_ok_v1(jsonb_build_object('devices',records,'pairings',pending,'nextAfter',next_page,'organization',organization));
end $$;
create function app.worker_device_action_v1(p jsonb) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare org uuid:=app.context_uuid_v1('app.organization_id');actor uuid:=app.context_uuid_v1('app.actor_id');j app.worker_pairings;w app.telegram_workers;b app.worker_pairing_owner_budget;act text:=p->>'action';op uuid;digest bytea;receipt jsonb;other uuid;n integer;tm timestamptz:=date_trunc('hour',clock_timestamp());expected timestamptz;
begin
 perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
 if not app.worker_pairing_uuid_v1(p->'operationId') or octet_length(p::text)>4096 then return app.worker_pairing_error_v1('INVALID_INPUT',400);end if;
 op:=(p->>'operationId')::uuid;digest:=sha256(convert_to(p::text,'UTF8'));
 if act='invite' then
 if not app.worker_pairing_shape_v1(p,array['action','operationId','invitationSha256','name']) or not app.worker_pairing_text_v1(p->'name') or jsonb_typeof(p->'invitationSha256') is distinct from 'string' or coalesce(p->>'invitationSha256','')!~'^[a-f0-9]{64}$' then return app.worker_pairing_error_v1('INVALID_INPUT',400);end if;
 -- The fixed global row serializes the global live-invitation bound and owner
 -- counters. This does not consume the separate public request budget.
 perform 1 from app.worker_pairing_budget where id for update;
 select * into j from app.worker_pairings where organization_id=org and owner_user_id=actor and invite_operation=op;
 if found then if j.invite_digest is distinct from digest then return app.worker_pairing_error_v1('OPERATION_CONFLICT',409);end if;return app.worker_pairing_ok_v1(j.invite_receipt);end if;
 insert into app.worker_pairing_owner_budget(organization_id,owner_user_id) values(org,actor) on conflict do nothing;
 select * into b from app.worker_pairing_owner_budget where organization_id=org and owner_user_id=actor for update;
 if b.hour_start<>tm then update app.worker_pairing_owner_budget set hour_start=tm,invite_count=0 where organization_id=org and owner_user_id=actor;b.invite_count:=0;end if;
 if b.invite_count>=10 then return app.worker_pairing_error_v1('INVITATION_LIMIT',429,ceil(extract(epoch from tm+interval '1 hour'-clock_timestamp()))::integer);end if;
 update app.worker_pairing_owner_budget set invite_count=invite_count+1 where organization_id=org and owner_user_id=actor;
 select count(*) into n from app.worker_pairings where organization_id=org and owner_user_id=actor and status in('invited','claimed') and expires_at>clock_timestamp();
 if n>=2 then return app.worker_pairing_error_v1('INVITATION_LIMIT',429,(select ceil(extract(epoch from min(expires_at)-clock_timestamp()))::integer from app.worker_pairings where organization_id=org and owner_user_id=actor and status in('invited','claimed') and expires_at>clock_timestamp()));end if;
 if (select count(*) from app.worker_pairings where status in('invited','claimed') and expires_at>clock_timestamp())>=1000 then return app.worker_pairing_error_v1('INVITATION_LIMIT',429,60);end if;
 if exists(select 1 from app.worker_pairings where invitation_sha256=decode(p->>'invitationSha256','hex')) then return app.worker_pairing_error_v1('OPERATION_CONFLICT',409);end if;
 insert into app.worker_pairings(organization_id,owner_user_id,name,invitation_sha256,invite_operation,invite_digest) values(org,actor,p->>'name',decode(p->>'invitationSha256','hex'),op,digest) returning * into j;
 receipt:=jsonb_build_object('pairingId',j.id,'status','invited','name',j.name,'expiresAt',j.expires_at);update app.worker_pairings set invite_receipt=receipt where id=j.id;
 return app.worker_pairing_ok_v1(receipt,201);
 elsif act='renew' then
 if not app.worker_pairing_shape_v1(p,array['action','operationId','workerId','expectedExpiresAt']) or not app.worker_pairing_uuid_v1(p->'workerId') or jsonb_typeof(p->'expectedExpiresAt') is distinct from 'string' then return app.worker_pairing_error_v1('INVALID_INPUT',400);end if;
 begin expected:=(p->>'expectedExpiresAt')::timestamptz;exception when others then return app.worker_pairing_error_v1('INVALID_INPUT',400);end;
 select * into w from app.telegram_workers where id=(p->>'workerId')::uuid and organization_id=org and owner_user_id=actor for update;
 if not found then return app.worker_pairing_error_v1('WORKER_UNAVAILABLE',404);end if;
 if w.revoked_at is not null then return app.worker_pairing_error_v1('RENEWAL_UNAVAILABLE',409);end if;
 if w.renew_operation=op then if w.renew_digest is distinct from digest then return app.worker_pairing_error_v1('OPERATION_CONFLICT',409);end if;return app.worker_pairing_ok_v1(w.renew_receipt);end if;
 if exists(select 1 from app.telegram_workers where organization_id=org and owner_user_id=actor and renew_operation=op) then return app.worker_pairing_error_v1('OPERATION_CONFLICT',409);end if;
 if w.expires_at is distinct from expected then return app.worker_pairing_error_v1('WORKER_CHANGED',409);end if;
 if w.expires_at>clock_timestamp()+interval '7 days' or w.expires_at<clock_timestamp()-interval '7 days' then return app.worker_pairing_error_v1('RENEWAL_UNAVAILABLE',409);end if;
 update app.telegram_workers set expires_at=clock_timestamp()+interval '30 days' where id=w.id returning * into w;
 receipt:=jsonb_build_object('worker',jsonb_build_object('id',w.id,'name',w.name,'expiresAt',w.expires_at));update app.telegram_workers set renew_operation=op,renew_digest=digest,renew_receipt=receipt where id=w.id;
 return app.worker_pairing_ok_v1(receipt);
 elsif act in('approve','cancel') then
 if not app.worker_pairing_shape_v1(p,case when act='approve' then array['action','operationId','pairingId','deviceFingerprint'] else array['action','operationId','pairingId'] end) or not app.worker_pairing_uuid_v1(p->'pairingId') or (act='approve' and coalesce(p->>'deviceFingerprint','')!~'^[a-f0-9]{12}$') then return app.worker_pairing_error_v1('INVALID_INPUT',400);end if;
 -- Serialize the binding transition with public polls before they read worker_id.
 perform 1 from app.worker_pairing_budget where id for update;
 select * into j from app.worker_pairings where id=(p->>'pairingId')::uuid and organization_id=org and owner_user_id=actor for update;
 if not found then return app.worker_pairing_error_v1('PAIRING_UNAVAILABLE',404);end if;
 if act='approve' and j.approve_operation=op then if j.approve_digest is distinct from digest then return app.worker_pairing_error_v1('OPERATION_CONFLICT',409);end if;return app.worker_pairing_ok_v1(j.approve_receipt);end if;
 if act='cancel' and j.cancel_operation=op then if j.cancel_digest is distinct from digest then return app.worker_pairing_error_v1('OPERATION_CONFLICT',409);end if;return app.worker_pairing_ok_v1(j.cancel_receipt);end if;
 if exists(select 1 from app.worker_pairings where organization_id=org and owner_user_id=actor and (case when act='approve' then approve_operation else cancel_operation end)=op) then return app.worker_pairing_error_v1('OPERATION_CONFLICT',409);end if;
 if j.status not in('invited','claimed') or j.expires_at<=clock_timestamp() then return app.worker_pairing_error_v1('PAIRING_DECIDED',409);end if;
 if act='cancel' then
 receipt:=jsonb_build_object('pairingId',j.id,'status','cancelled');update app.worker_pairings set status='cancelled',decided_at=clock_timestamp(),cancel_operation=op,cancel_digest=digest,cancel_receipt=receipt where id=j.id;return app.worker_pairing_ok_v1(receipt);end if;
 if j.status<>'claimed' or j.fingerprint is distinct from p->>'deviceFingerprint' then return app.worker_pairing_error_v1('PAIRING_CLAIMED',409);end if;
 begin
 insert into app.telegram_workers(organization_id,owner_user_id,name,token_sha256) values(org,actor,j.name,j.token_sha256) returning * into w;
 exception when unique_violation then return app.worker_pairing_error_v1('TOKEN_UNAVAILABLE',409);end;
 receipt:=jsonb_build_object('pairingId',j.id,'status','approved','worker',jsonb_build_object('id',w.id,'name',w.name,'expiresAt',w.expires_at));
 update app.worker_pairings set status='approved',decided_at=clock_timestamp(),worker_id=w.id,approve_operation=op,approve_digest=digest,approve_receipt=receipt where id=j.id;
 return app.worker_pairing_ok_v1(receipt);
 end if;
 return app.worker_pairing_error_v1('INVALID_INPUT',400);
end $$;
-- Extend the existing daemon-independent bounded cleanup without exposing rows.
alter function app.telegram_maintenance_v1(integer) rename to telegram_maintenance_before_pairing_v1;
revoke all on function app.telegram_maintenance_before_pairing_v1(integer) from public,app_telegram_maintenance;
create function app.telegram_maintenance_v1(p_limit integer default 10) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$declare result jsonb;purged integer;begin
 result:=app.telegram_maintenance_before_pairing_v1(p_limit);
 with targets as materialized(select id from app.worker_pairings where coalesce(decided_at,expires_at)<=clock_timestamp()-interval '24 hours' order by coalesce(decided_at,expires_at),id for update skip locked limit 100), removed as(delete from app.worker_pairings where id in(select id from targets) returning id) select count(*) into purged from removed;
 return result||jsonb_build_object('pairingRowsPurged',purged,'remainingWork',coalesce((result->>'remainingWork')::boolean,false) or exists(select 1 from app.worker_pairings where coalesce(decided_at,expires_at)<=clock_timestamp()-interval '24 hours'));
end $$;
do $$declare f record;begin for f in select oid::regprocedure sig from pg_proc where pronamespace='app'::regnamespace and (proname like 'worker_pairing_%' or proname like 'worker_device_%') loop execute format('revoke all on function %s from public',f.sig);end loop;end $$;
revoke all on function app.telegram_maintenance_v1(integer) from public;
grant execute on function app.worker_pairing_claim_v1(text,jsonb),app.worker_pairing_poll_v1(text,jsonb) to app_worker_pairing;
grant execute on function app.worker_device_action_v1(jsonb),app.worker_device_status_v1(uuid,jsonb) to app_staff;
grant execute on function app.telegram_maintenance_v1(integer) to app_telegram_maintenance;
reset role;set local role app_owner;revoke create on schema app from app_executor;reset role;
commit;
