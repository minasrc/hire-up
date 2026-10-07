begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';
do $$ begin
    if current_setting('server_version_num')::integer / 10000 <> 17 then
        raise exception 'Foundation requires PostgreSQL 17';
    end if;
    if not exists(select 1 from pg_roles where rolname = 'app_telegram_worker') then
        create role app_telegram_worker nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
    end if;
    if not (select rolsuper from pg_roles where rolname = session_user) then
        execute format('grant app_owner to %I with inherit true, set true', session_user);
        execute format('grant app_executor to %I with set true, inherit false', session_user);
    end if;
end $$;
set local role app_owner;
grant usage on schema app to app_telegram_worker;

create table app.telegram_drafts (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null,
    owner_user_id uuid not null,
    candidate_target_id uuid not null default gen_random_uuid(),
    status text not null default 'pending' check (status in ('pending','snoozed','duplicate','approved','discarded')),
    fields jsonb not null default '{}' check (jsonb_typeof(fields) = 'object' and octet_length(fields::text) <= 49152),
    document jsonb check (document is null or jsonb_typeof(document) = 'object'),
    source_title text not null default 'Manual draft' check (char_length(source_title) between 1 and 200),
    approved_candidate_id uuid,
    version bigint not null default 1 check (version > 0),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    reviewed_at timestamptz,
    unique (organization_id,owner_user_id,id),
    foreign key (organization_id,owner_user_id) references app.organization_memberships(organization_id,user_id),
    foreign key (organization_id,approved_candidate_id) references app.candidates(organization_id,id)
);
create index telegram_drafts_inbox_idx on app.telegram_drafts(organization_id,owner_user_id,status,updated_at desc,id);

create table app.telegram_evidence (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null,
    owner_user_id uuid not null,
    source_key text not null check (char_length(source_key) between 1 and 200),
    text text not null check (octet_length(text) <= 16384),
    sender_name text check (char_length(sender_name) <= 200),
    sent_at timestamptz,
    unique (organization_id,owner_user_id,id),
    unique (organization_id,owner_user_id,source_key),
    foreign key (organization_id,owner_user_id) references app.organization_memberships(organization_id,user_id)
);
create table app.telegram_draft_evidence (
    organization_id uuid not null,
    owner_user_id uuid not null,
    draft_id uuid not null,
    evidence_id uuid not null,
    primary key (draft_id,evidence_id),
    foreign key (organization_id,owner_user_id,draft_id) references app.telegram_drafts(organization_id,owner_user_id,id) on delete cascade,
    foreign key (organization_id,owner_user_id,evidence_id) references app.telegram_evidence(organization_id,owner_user_id,id) on delete cascade
);
-- Discarded upload deletion is recorded durably, for server-side storage cleanup.
-- The Mac never receives storage credentials or permission to delete blobs.
create table app.telegram_upload_cleanup (
    organization_id uuid not null,
    owner_user_id uuid not null,
    object_key text primary key,
    state text not null default 'pending' check (state in ('pending','deleting')),
    available_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    foreign key (organization_id,owner_user_id) references app.organization_memberships(organization_id,user_id)
);
create table app.telegram_workers (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null,
    owner_user_id uuid not null,
    name text not null check (char_length(name) between 1 and 80),
    token_sha256 bytea not null unique check (octet_length(token_sha256)=32),
    expires_at timestamptz not null default now()+interval '30 days',
    revoked_at timestamptz,
    last_seen_at timestamptz,
    created_at timestamptz not null default now(),
    foreign key (organization_id,owner_user_id) references app.organization_memberships(organization_id,user_id)
);
create table app.telegram_jobs (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null,
    owner_user_id uuid not null,
    draft_id uuid not null,
    source_version bigint not null,
    kind text not null default 'embedding' check (kind='embedding'),
    status text not null default 'queued' check (status in ('queued','leased','completed','failed','cancelled')),
    payload jsonb not null check (octet_length(payload::text) <= 131072),
    result_sha256 bytea,
    attempts integer not null default 0 check (attempts between 0 and 5),
    lease_token uuid,
    lease_worker_id uuid references app.telegram_workers(id),
    lease_expires_at timestamptz,
    available_at timestamptz not null default now(),
    failure_code text check (failure_code is null or failure_code in ('EMBEDDING_UNAVAILABLE','INVALID_JOB','WORKER_ERROR','ATTEMPTS_EXHAUSTED')),
    created_at timestamptz not null default now(),
    finished_at timestamptz,
    unique (draft_id,source_version,kind),
    foreign key (organization_id,owner_user_id,draft_id) references app.telegram_drafts(organization_id,owner_user_id,id) on delete cascade
);
create index telegram_jobs_claim_idx on app.telegram_jobs(organization_id,owner_user_id,status,available_at,created_at);
-- Portable intermediate projection. A dedicated search adapter/index follows;
-- no vector extension is introduced into the business schema.
create table app.telegram_draft_embeddings (
    organization_id uuid not null,
    owner_user_id uuid not null,
    draft_id uuid primary key,
    source_version bigint not null,
    index_version text not null,
    embedding real[] not null check (cardinality(embedding)=384),
    updated_at timestamptz not null default now(),
    foreign key (organization_id,owner_user_id,draft_id) references app.telegram_drafts(organization_id,owner_user_id,id) on delete cascade
);

do $$ declare t text; begin
    foreach t in array array['telegram_drafts','telegram_evidence','telegram_draft_evidence','telegram_upload_cleanup','telegram_jobs','telegram_draft_embeddings'] loop
        execute format('alter table app.%I enable row level security',t);
        execute format('alter table app.%I force row level security',t);
        execute format('grant select,insert,update,delete on app.%I to app_executor',t);
        execute format('create policy telegram_private_owner on app.%I for all to app_executor using (organization_id=app.context_uuid_v1(''app.organization_id'') and owner_user_id=app.context_uuid_v1(''app.actor_id'')) with check (organization_id=app.context_uuid_v1(''app.organization_id'') and owner_user_id=app.context_uuid_v1(''app.actor_id''))',t);
    end loop;
end $$;
alter table app.telegram_workers enable row level security;
alter table app.telegram_workers force row level security;
grant select,insert,update on app.telegram_workers to app_executor;
-- Only the definer can look up a token before establishing actor context.
-- Neither runtime role has table access; staff functions explicitly scope rows.
create policy telegram_worker_token_lookup on app.telegram_workers to app_executor using(true) with check(true);
grant create on schema app to app_executor;
reset role;
set local role app_executor;

create function app.telegram_missing_v1(p_fields jsonb,p_document jsonb)
returns text[] language sql immutable set search_path=pg_catalog,app,pg_temp as $$
    select array_remove(array[
        case when coalesce(btrim(p_fields->>'firstName'),'')='' then 'firstName' end,
        case when coalesce(btrim(p_fields->>'lastName'),'')='' then 'lastName' end,
        case when coalesce(btrim(p_fields->>'primaryEmail'),'')='' then 'primaryEmail' end,
        case when p_document is null then 'cv' end
    ],null);
$$;
create function app.telegram_draft_json_v1(d app.telegram_drafts)
returns jsonb language sql stable set search_path=pg_catalog,app,pg_temp as $$
    select jsonb_build_object('id',d.id,'version',d.version,'status',d.status,'fields',d.fields,
        'cv',case when d.document is null then null else jsonb_build_object('filename',d.document->>'filename','status','validated') end,
        'missingFields',to_jsonb(app.telegram_missing_v1(d.fields,d.document)),
        'sourceTitle',d.source_title,'updatedAt',d.updated_at,'candidateId',d.approved_candidate_id);
$$;
create function app.telegram_get_draft_v1(p_id uuid)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare d app.telegram_drafts; result jsonb;
begin
    perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
    select * into d from app.telegram_drafts where id=p_id;
    if not found then raise exception 'Draft not found' using errcode='P0002'; end if;
    select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'text',e.text,'senderName',e.sender_name,'sentAt',e.sent_at) order by e.sent_at,e.id),'[]'::jsonb)
        into result from app.telegram_evidence e join app.telegram_draft_evidence x on x.evidence_id=e.id where x.draft_id=p_id;
    return app.telegram_draft_json_v1(d)||jsonb_build_object('evidence',result);
end $$;
create function app.telegram_list_drafts_v1(p_view text,p_missing text,p_query text,p_page integer)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare rows_json jsonb; counts_json jsonb; more boolean;
begin
    perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
    if p_view not in ('ready','needs_information','snoozed','duplicates','all') or p_page not between 1 and 10000 or char_length(p_query)>200
        or (p_missing is not null and p_missing not in ('firstName','lastName','primaryEmail','cv')) then
        raise exception 'Invalid inbox filter' using errcode='22023';
    end if;
    select jsonb_build_object('ready',count(*) filter(where status='pending' and cardinality(app.telegram_missing_v1(fields,document))=0),
        'needs_information',count(*) filter(where status='pending' and cardinality(app.telegram_missing_v1(fields,document))>0),
        'snoozed',count(*) filter(where status='snoozed'),'duplicates',count(*) filter(where status='duplicate'),
        'all',count(*) filter(where status in ('pending','snoozed','duplicate'))) into counts_json from app.telegram_drafts;
    with filtered as (
        select d.* from app.telegram_drafts d where
            case p_view when 'ready' then status='pending' and cardinality(app.telegram_missing_v1(fields,document))=0
            when 'needs_information' then status='pending' and cardinality(app.telegram_missing_v1(fields,document))>0
            when 'snoozed' then status='snoozed' when 'duplicates' then status='duplicate' else status in ('pending','snoozed','duplicate') end
            and (p_missing is null or p_missing=any(app.telegram_missing_v1(fields,document)))
            and (coalesce(p_query,'')='' or strpos(lower(concat_ws(' ',fields->>'firstName',fields->>'lastName',fields->>'primaryEmail',fields->>'telegramUsername',source_title)),lower(p_query))>0)
        order by updated_at desc,id limit 26 offset (p_page-1)*25
    ), numbered as (select f.*,row_number() over(order by updated_at desc,id) n from filtered f)
    select coalesce(jsonb_agg(app.telegram_draft_json_v1(d) order by n.n) filter(where n.n<=25),'[]'),count(*)>25 into rows_json,more
        from numbered n join app.telegram_drafts d on d.id=n.id;
    return jsonb_build_object('drafts',rows_json,'counts',counts_json,'page',p_page,'hasMore',more);
end $$;

create function app.telegram_create_draft_v1(p_id uuid,p_fields jsonb,p_title text)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare d app.telegram_drafts;
begin
    perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
    insert into app.telegram_drafts(id,organization_id,owner_user_id,fields,source_title)
        values(p_id,app.context_uuid_v1('app.organization_id'),app.context_uuid_v1('app.actor_id'),p_fields,p_title) returning * into d;
    return app.telegram_draft_json_v1(d);
end $$;
create function app.telegram_update_draft_v1(p_id uuid,p_version bigint,p_fields jsonb)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare d app.telegram_drafts;
begin
    perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
    update app.telegram_drafts set fields=p_fields,status=case when status='duplicate' then 'pending' else status end,version=version+1,updated_at=clock_timestamp()
        where id=p_id and version=p_version and status in ('pending','snoozed','duplicate') returning * into d;
    if not found then raise exception 'Draft changed or is unavailable' using errcode='40001'; end if;
    delete from app.telegram_draft_embeddings where draft_id=p_id;
    return app.telegram_draft_json_v1(d);
end $$;
-- Register before touching storage. A fresh reservation cannot be cleaned for an
-- hour; consuming it and attaching the CV commit together. Cleanup fences late
-- attachment before releasing the database transaction to call object storage.
create function app.telegram_reserve_upload_v1(p_id uuid,p_version bigint,p_key text)
returns boolean language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare d app.telegram_drafts; begin
    perform app.recruitment_actor_v1(array['candidates.read','candidates.write','documents.write'],null,null,false);
    select * into d from app.telegram_drafts where id=p_id for share;
    if not found or d.version<>p_version or d.status not in ('pending','snoozed','duplicate') then raise exception 'Draft changed' using errcode='40001'; end if;
    if p_key is null or p_key !~ ('^staff/'||d.organization_id||'/'||d.candidate_target_id||'/[0-9a-f-]{36}\.(pdf|docx)$') then raise exception 'Invalid upload key' using errcode='22023'; end if;
    insert into app.telegram_upload_cleanup(organization_id,owner_user_id,object_key,available_at)
        values(d.organization_id,d.owner_user_id,p_key,clock_timestamp()+interval '1 hour');
    return true;
end $$;
create function app.telegram_pending_cleanup_v1()
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
begin
    perform app.recruitment_actor_v1(array['candidates.read','candidates.write','documents.write'],null,null,false);
    return coalesce((select jsonb_agg(object_key) from (select object_key from app.telegram_upload_cleanup
        where available_at<=clock_timestamp() order by created_at limit 10) q),'[]'::jsonb);
end $$;
create function app.telegram_claim_cleanup_v1(p_key text)
returns boolean language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
begin
    perform app.recruitment_actor_v1(array['candidates.read','candidates.write','documents.write'],gen_random_uuid(),gen_random_uuid(),true);
    perform 1 from app.telegram_upload_cleanup where object_key=p_key and available_at<=clock_timestamp() for update;
    if not found then return false; end if;
    if exists(select 1 from app.telegram_drafts where document->>'objectKey'=p_key)
        or app.candidate_upload_referenced_v1(p_key) then return false; end if;
    update app.telegram_upload_cleanup set state='deleting' where object_key=p_key;
    return true;
end $$;
create function app.telegram_finish_cleanup_v1(p_key text)
returns boolean language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
begin
    perform app.recruitment_actor_v1(array['candidates.read','candidates.write','documents.write'],null,null,false);
    delete from app.telegram_upload_cleanup where object_key=p_key and state='deleting';
    return found;
end $$;
create function app.telegram_attach_cv_v1(p_id uuid,p_version bigint,p_document jsonb)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare d app.telegram_drafts;
begin
    perform app.recruitment_actor_v1(array['candidates.read','candidates.write','documents.write'],null,null,false);
    select * into d from app.telegram_drafts where id=p_id for update;
    if not found or d.version<>p_version or d.status not in ('pending','snoozed','duplicate') then raise exception 'Draft changed' using errcode='40001'; end if;
    if jsonb_typeof(p_document) is distinct from 'object' or p_document->>'objectKey' not like 'staff/'||d.organization_id||'/'||d.candidate_target_id||'/%'
        or p_document->>'extension' not in ('pdf','docx') or (p_document->>'sizeBytes')::bigint not between 1 and 4194304 then raise exception 'Invalid CV' using errcode='22023'; end if;
    perform 1 from app.telegram_upload_cleanup where object_key=p_document->>'objectKey' and state='pending' for update;
    if not found then raise exception 'Upload reservation unavailable' using errcode='40001'; end if;
    if d.document is not null then insert into app.telegram_upload_cleanup(organization_id,owner_user_id,object_key)
        values(d.organization_id,d.owner_user_id,d.document->>'objectKey') on conflict do nothing; end if;
    update app.telegram_drafts set document=p_document,version=version+1,updated_at=clock_timestamp() where id=p_id returning * into d;
    delete from app.telegram_upload_cleanup where object_key=p_document->>'objectKey';
    delete from app.telegram_draft_embeddings where draft_id=p_id;
    return app.telegram_draft_json_v1(d);
end $$;
create function app.telegram_cv_document_v1(p_id uuid)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare doc jsonb; begin
    perform app.recruitment_actor_v1(array['candidates.read','candidates.write','documents.download'],null,null,false);
    select document into doc from app.telegram_drafts where id=p_id and status in ('pending','snoozed','duplicate');
    if doc is null then raise exception 'CV unavailable' using errcode='P0002'; end if;
    return doc;
end $$;
create function app.telegram_cv_target_v1(p_id uuid)
returns uuid language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare target uuid; begin
    perform app.recruitment_actor_v1(array['candidates.read','candidates.write','documents.write'],null,null,false);
    select candidate_target_id into target from app.telegram_drafts where id=p_id and status in ('pending','snoozed','duplicate');
    if target is null then raise exception 'Draft unavailable' using errcode='P0002'; end if;
    return target;
end $$;

create function app.telegram_decide_draft_v1(p_id uuid,p_version bigint,p_action text,p_operation uuid)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare d app.telegram_drafts; result jsonb; source_id uuid; username text; user_id text;
begin
    perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],p_operation,gen_random_uuid(),true);
    select * into d from app.telegram_drafts where id=p_id for update;
    if not found then raise exception 'Draft unavailable' using errcode='P0002'; end if;
    if d.status='approved' and p_action='approve' then return jsonb_build_object('status','approved','candidateId',d.approved_candidate_id,'replayed',true); end if;
    if d.version<>p_version or d.status in ('approved','discarded') then raise exception 'Draft changed' using errcode='40001'; end if;
    if p_action='approve' then
        if cardinality(app.telegram_missing_v1(d.fields,d.document))>0 then raise exception 'Required candidate information missing' using errcode='23514'; end if;
        username:=d.fields->>'telegramUsername'; user_id:=d.fields->>'telegramUserId';
        if (username is not null and username !~ '^[A-Za-z0-9_]{5,32}$') or (user_id is not null and user_id !~ '^[0-9]{1,30}$') then raise exception 'Invalid Telegram identity' using errcode='22023'; end if;
        result:=app.create_candidate_upload_v1(d.candidate_target_id,d.fields-array['telegramUsername','telegramUserId'],d.document,p_operation,gen_random_uuid());
        if result->>'status'='duplicate' then
            update app.telegram_drafts set status='duplicate',version=version+1,updated_at=clock_timestamp() where id=p_id;
            return result;
        end if;
        select id into strict source_id from app.candidate_sources where organization_id=d.organization_id and candidate_id=d.candidate_target_id;
        if username is not null then
            insert into app.candidate_identifiers(id,organization_id,candidate_id,kind,raw_value,normalized_value,normalization_version,verification,source_id,received_at)
            values(gen_random_uuid(),d.organization_id,d.candidate_target_id,'professional_url','https://t.me/'||username,'https://t.me/'||lower(username),1,'unverified',source_id,now());
        end if;
        if user_id is not null then
            insert into app.candidate_identifiers(id,organization_id,candidate_id,kind,raw_value,normalized_value,normalization_version,verification,source_id,received_at)
            values(gen_random_uuid(),d.organization_id,d.candidate_target_id,'provider_subject','telegram:user:'||user_id,'telegram:user:'||user_id,1,'unverified',source_id,now());
        end if;
        update app.telegram_drafts set status='approved',approved_candidate_id=d.candidate_target_id,fields='{}',document=null,reviewed_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() where id=p_id;
    elsif p_action in ('discard','snooze','reopen') then
        if p_action='discard' and d.document is not null then
            insert into app.telegram_upload_cleanup(organization_id,owner_user_id,object_key) values(d.organization_id,d.owner_user_id,d.document->>'objectKey') on conflict do nothing;
        end if;
        update app.telegram_drafts set status=case p_action when 'discard' then 'discarded' when 'snooze' then 'snoozed' else 'pending' end,
            fields=case when p_action='discard' then '{}'::jsonb else fields end,
            document=case when p_action='discard' then null else document end,version=version+1,updated_at=clock_timestamp() where id=p_id;
    else raise exception 'Invalid decision' using errcode='22023'; end if;
    if p_action in ('approve','discard') then
        delete from app.telegram_draft_evidence where draft_id=p_id;
        delete from app.telegram_evidence e where not exists(select 1 from app.telegram_draft_evidence x where x.evidence_id=e.id);
        delete from app.telegram_draft_embeddings where draft_id=p_id;
        update app.telegram_jobs set status='cancelled',payload='{}',result_sha256=null,finished_at=clock_timestamp(),lease_token=null where draft_id=p_id;
    end if;
    if p_action='approve' then return jsonb_build_object('status','approved','candidateId',d.candidate_target_id); end if;
    return app.telegram_get_draft_v1(p_id);
end $$;

create function app.telegram_register_worker_v1(p_name text,p_token text)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare w app.telegram_workers; begin
    perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
    if p_token !~ '^[A-Za-z0-9_-]{64}$' then raise exception 'Invalid worker credential' using errcode='22023'; end if;
    insert into app.telegram_workers(organization_id,owner_user_id,name,token_sha256)
        values(app.context_uuid_v1('app.organization_id'),app.context_uuid_v1('app.actor_id'),p_name,sha256(convert_to(p_token,'UTF8'))) returning * into w;
    return jsonb_build_object('id',w.id,'name',w.name,'expiresAt',w.expires_at);
end $$;
create function app.telegram_revoke_worker_v1(p_id uuid)
returns boolean language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
begin
    perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
    update app.telegram_workers set revoked_at=clock_timestamp() where id=p_id and organization_id=app.context_uuid_v1('app.organization_id') and owner_user_id=app.context_uuid_v1('app.actor_id');
    return found;
end $$;
create function app.telegram_worker_context_v1(p_token text)
returns uuid language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare w app.telegram_workers; begin
    perform set_config('app.actor_id','',true); perform set_config('app.organization_id','',true);
    if p_token is null or p_token !~ '^[A-Za-z0-9_-]{64}$' then raise exception 'Worker unauthorized' using errcode='42501'; end if;
    select * into w from app.telegram_workers where token_sha256=sha256(convert_to(p_token,'UTF8')) and revoked_at is null and expires_at>clock_timestamp() for update;
    if not found then raise exception 'Worker unauthorized' using errcode='42501'; end if;
    perform set_config('app.actor_id',w.owner_user_id::text,true); perform set_config('app.organization_id',w.organization_id::text,true);
    perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
    update app.telegram_workers set last_seen_at=clock_timestamp() where id=w.id;
    return w.id;
end $$;
create function app.telegram_enqueue_embedding_v1(p_id uuid,p_version bigint,p_text text,p_index text)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare d app.telegram_drafts; j uuid; begin
    perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
    select * into d from app.telegram_drafts where id=p_id and version=p_version and status in ('pending','snoozed','duplicate') for share;
    if not found then raise exception 'Draft changed' using errcode='40001'; end if;
    if char_length(p_text) not between 1 and 1600 or p_index<>'intfloat/multilingual-e5-small@614241f622f53c4eeff9890bdc4f31cfecc418b3:e5-prefix:l2:384:v1' then raise exception 'Invalid embedding input' using errcode='22023'; end if;
    insert into app.telegram_jobs(organization_id,owner_user_id,draft_id,source_version,payload)
        values(d.organization_id,d.owner_user_id,d.id,d.version,jsonb_build_object('texts',jsonb_build_array(p_text),'inputType','passage','indexVersion',p_index))
        on conflict(draft_id,source_version,kind) do update set status='queued',payload=excluded.payload,attempts=0,
            lease_token=null,lease_worker_id=null,lease_expires_at=null,failure_code=null,finished_at=null,available_at=clock_timestamp()
            where telegram_jobs.status='failed' returning id into j;
    if j is null then select id into j from app.telegram_jobs where draft_id=p_id and source_version=p_version and kind='embedding'; end if;
    return jsonb_build_object('jobId',j);
end $$;
create function app.telegram_claim_job_v1(p_token text)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare w uuid; j app.telegram_jobs; begin
    w:=app.telegram_worker_context_v1(p_token);
    update app.telegram_jobs set status='failed',failure_code='ATTEMPTS_EXHAUSTED',payload='{}',finished_at=clock_timestamp()
        where attempts>=5 and status='leased' and lease_expires_at<clock_timestamp();
    select * into j from app.telegram_jobs where attempts<5 and available_at<=clock_timestamp()
        and (status='queued' or (status='leased' and lease_expires_at<clock_timestamp()))
        order by created_at,id for update skip locked limit 1;
    if not found then return null; end if;
    update app.telegram_jobs set status='leased',attempts=attempts+1,lease_token=gen_random_uuid(),lease_worker_id=w,lease_expires_at=clock_timestamp()+interval '120 seconds'
        where id=j.id returning * into j;
    return jsonb_build_object('id',j.id,'leaseToken',j.lease_token,'leaseExpiresAt',j.lease_expires_at,'kind',j.kind,'payload',j.payload);
end $$;
create function app.telegram_complete_job_v1(p_token text,p_job uuid,p_lease uuid,p_result jsonb)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare w uuid; j app.telegram_jobs; d app.telegram_drafts; digest bytea; vector real[]; norm double precision;
begin
    w:=app.telegram_worker_context_v1(p_token);
    select * into j from app.telegram_jobs where id=p_job for update;
    if not found or j.lease_token is distinct from p_lease or j.lease_worker_id is distinct from w then raise exception 'Lease unavailable' using errcode='40001'; end if;
    digest:=sha256(convert_to(p_result::text,'UTF8'));
    if j.status='completed' and j.result_sha256=digest then return jsonb_build_object('status','completed','replayed',true); end if;
    if j.status<>'leased' or j.lease_expires_at<=clock_timestamp() then raise exception 'Lease expired' using errcode='40001'; end if;
    select * into d from app.telegram_drafts where id=j.draft_id for share;
    if not found or d.version<>j.source_version or d.status not in ('pending','snoozed','duplicate') then
        update app.telegram_jobs set status='cancelled',payload='{}',finished_at=clock_timestamp() where id=j.id;
        return jsonb_build_object('status','cancelled');
    end if;
    if p_result->>'indexVersion' is distinct from j.payload->>'indexVersion'
        or jsonb_typeof(p_result->'embeddings') is distinct from 'array' or jsonb_array_length(p_result->'embeddings')<>1
        or jsonb_typeof(p_result->'embeddings'->0) is distinct from 'array' or jsonb_array_length(p_result->'embeddings'->0)<>384
        or exists(select 1 from jsonb_array_elements(p_result->'embeddings'->0) v where jsonb_typeof(v)<>'number') then raise exception 'Invalid embedding result' using errcode='22023'; end if;
    select array_agg(v::real),sum((v::double precision)^2) into vector,norm from jsonb_array_elements_text(p_result->'embeddings'->0) v;
    if norm not between 0.98 and 1.02 then raise exception 'Embedding must be normalized' using errcode='22023'; end if;
    insert into app.telegram_draft_embeddings(organization_id,owner_user_id,draft_id,source_version,index_version,embedding)
        values(j.organization_id,j.owner_user_id,j.draft_id,j.source_version,p_result->>'indexVersion',vector)
        on conflict(draft_id) do update set source_version=excluded.source_version,index_version=excluded.index_version,embedding=excluded.embedding,updated_at=clock_timestamp();
    update app.telegram_jobs set status='completed',payload='{}',result_sha256=digest,finished_at=clock_timestamp() where id=j.id;
    return jsonb_build_object('status','completed');
end $$;
create function app.telegram_fail_job_v1(p_token text,p_job uuid,p_lease uuid,p_code text)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare w uuid; j app.telegram_jobs; begin
    w:=app.telegram_worker_context_v1(p_token);
    if p_code not in ('EMBEDDING_UNAVAILABLE','INVALID_JOB','WORKER_ERROR') then raise exception 'Invalid failure code' using errcode='22023'; end if;
    select * into j from app.telegram_jobs where id=p_job for update;
    if not found or j.status<>'leased' or j.lease_token is distinct from p_lease or j.lease_worker_id is distinct from w or j.lease_expires_at<=clock_timestamp() then raise exception 'Lease unavailable' using errcode='40001'; end if;
    update app.telegram_jobs set status=case when attempts>=5 or p_code='INVALID_JOB' then 'failed' else 'queued' end,
        payload=case when attempts>=5 or p_code='INVALID_JOB' then '{}'::jsonb else payload end,
        lease_token=null,lease_worker_id=null,lease_expires_at=null,failure_code=p_code,
        available_at=clock_timestamp()+make_interval(secs=>least(300,power(2,attempts)::integer)) where id=j.id;
    return jsonb_build_object('status','recorded');
end $$;

-- Default function EXECUTE is public in PostgreSQL; revoke every new entrypoint.
do $$ declare f record; begin
    for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app' and p.proname like 'telegram_%' loop
        execute format('revoke all on function %s from public',f.signature);
    end loop;
end $$;
grant execute on function app.telegram_cv_document_v1(uuid),app.telegram_reserve_upload_v1(uuid,bigint,text),app.telegram_pending_cleanup_v1(),app.telegram_claim_cleanup_v1(text),app.telegram_finish_cleanup_v1(text),app.telegram_get_draft_v1(uuid),app.telegram_list_drafts_v1(text,text,text,integer),app.telegram_create_draft_v1(uuid,jsonb,text),app.telegram_update_draft_v1(uuid,bigint,jsonb),app.telegram_attach_cv_v1(uuid,bigint,jsonb),app.telegram_cv_target_v1(uuid),app.telegram_decide_draft_v1(uuid,bigint,text,uuid),app.telegram_register_worker_v1(text,text),app.telegram_revoke_worker_v1(uuid),app.telegram_enqueue_embedding_v1(uuid,bigint,text,text) to app_staff;
grant execute on function app.telegram_claim_job_v1(text),app.telegram_complete_job_v1(text,uuid,uuid,jsonb),app.telegram_fail_job_v1(text,uuid,uuid,text) to app_telegram_worker;
reset role;
set local role app_owner;
revoke create on schema app from app_executor;
commit;
