begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';
do $$
begin
    if current_setting('server_version_num')::integer / 10000 <> 17 then
        raise exception 'Foundation requires PostgreSQL 17';
    end if;
    if not (select rolsuper from pg_catalog.pg_roles where rolname = session_user) then
        execute format('grant app_owner to %I with inherit true, set true', session_user);
        execute format('grant app_executor to %I with set true, inherit false', session_user);
    end if;
end $$;
set local role app_owner;
alter table app.candidates
    add column first_name text check (first_name is null or char_length(first_name) between 1 and 60),
    add column last_name text check (last_name is null or char_length(last_name) between 1 and 60),
    add column secondary_emails text[] not null default '{}' check (cardinality(secondary_emails) <= 9),
    add column compensation_preference text check (compensation_preference is null or char_length(compensation_preference) <= 500);
-- Split names must not outlive an authoritative name correction or erasure.
-- The existing privacy workflow corrects full_name; future lifecycle erasure
-- also clears these new fields without requiring changes to old procedures.
create function app.clear_candidate_upload_details_v1()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, app, pg_temp
as $$
begin
    if new.lifecycle in ('deleting','deleted') or new.full_name is null then
        new.first_name := null;
        new.last_name := null;
        new.compensation_preference := null;
        new.secondary_emails := '{}';
    elsif new.full_name is distinct from old.full_name then
        new.first_name := null;
        new.last_name := null;
    end if;
    return new;
end $$;
revoke all on function app.clear_candidate_upload_details_v1() from public;
create trigger candidates_clear_upload_details before update on app.candidates
    for each row execute function app.clear_candidate_upload_details_v1();
grant update (first_name, last_name, compensation_preference, secondary_emails) on app.candidates to app_executor;
grant select on app.blob_locations, app.candidate_sources to app_executor;
create policy executor_candidate_upload_sources_select on app.candidate_sources for select to app_executor
    using (organization_id = app.context_uuid_v1('app.organization_id') and app.has_permission_v1('candidates.read'));
create policy executor_candidate_upload_blobs_select on app.file_blobs for select to app_executor
    using (organization_id = app.context_uuid_v1('app.organization_id') and app.has_permission_v1('documents.write'));
create policy executor_candidate_upload_blobs_insert on app.file_blobs for insert to app_executor
    with check (organization_id = app.context_uuid_v1('app.organization_id') and app.has_permission_v1('documents.write') and app.has_permission_v1('candidates.write'));
create policy executor_candidate_upload_locations_select on app.blob_locations for select to app_executor
    using (organization_id = app.context_uuid_v1('app.organization_id') and app.has_permission_v1('documents.write'));
create policy executor_candidate_upload_locations_insert on app.blob_locations for insert to app_executor
    with check (organization_id = app.context_uuid_v1('app.organization_id') and app.has_permission_v1('documents.write') and app.has_permission_v1('candidates.write'));
create policy executor_candidate_upload_documents_insert on app.documents for insert to app_executor
    with check (organization_id = app.context_uuid_v1('app.organization_id') and app.has_permission_v1('documents.write') and app.has_permission_v1('candidates.write'));
grant create on schema app to app_executor;
reset role;
set local role app_executor;

create function app.create_candidate_upload_v1(p_candidate_id uuid, p_fields jsonb, p_document jsonb, p_operation_id uuid, p_correlation_id uuid)
returns jsonb language plpgsql volatile security definer
set search_path = pg_catalog, app, pg_temp
as $$
declare
    v_org uuid := app.context_uuid_v1('app.organization_id');
    v_member uuid;
    v_result jsonb;
    v_digest bytea;
    v_existing app.candidates;
    v_email text;
    v_emails text[];
    v_profile jsonb;
    v_source uuid;
    v_blob uuid := gen_random_uuid();
    v_document uuid := gen_random_uuid();
    v_now timestamptz := clock_timestamp();
begin
    -- Uses the same organization lock as profile saves, duplicate review and
    -- public intake: secondary emails cannot race a different intake path.
    v_member := app.recruitment_actor_v1(array['candidates.read', 'candidates.write', 'documents.write'], p_operation_id, p_correlation_id, true);
    if p_candidate_id is null or p_fields is null or jsonb_typeof(p_fields) <> 'object'
        or octet_length(p_fields::text) > 49152
        or p_fields - array['firstName','lastName','primaryEmail','secondaryEmails','headline','location','professionalUrl','ownerMembershipId','professionalSummary','compensationPreference'] <> '{}'::jsonb
        or jsonb_typeof(p_fields->'firstName') is distinct from 'string'
        or jsonb_typeof(p_fields->'lastName') is distinct from 'string'
        or char_length(btrim(p_fields->>'firstName')) not between 1 and 60
        or char_length(btrim(p_fields->>'lastName')) not between 1 and 60
        or jsonb_typeof(p_fields->'primaryEmail') is distinct from 'string'
        or jsonb_typeof(p_fields->'secondaryEmails') is distinct from 'array'
        or jsonb_array_length(p_fields->'secondaryEmails') > 9
        or (p_fields->'compensationPreference' is not null and jsonb_typeof(p_fields->'compensationPreference') not in ('string','null'))
        or char_length(p_fields->>'compensationPreference') > 500 then
        raise exception 'Candidate upload fields are invalid' using errcode = '22023';
    end if;
    if exists(select 1 from jsonb_array_elements(p_fields->'secondaryEmails') e where jsonb_typeof(e) <> 'string') then
        raise exception 'Email fields are invalid' using errcode = '22023';
    end if;
    v_emails := array[lower(btrim(p_fields->>'primaryEmail'))] || array(select lower(btrim(e)) from jsonb_array_elements_text(p_fields->'secondaryEmails') e);
    foreach v_email in array v_emails loop
        if char_length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
            raise exception 'Email fields are invalid' using errcode = '22023';
        end if;
    end loop;
    if cardinality(v_emails) <> (select count(distinct e) from unnest(v_emails) e) then
        raise exception 'Email fields must be distinct' using errcode = '22023';
    end if;
    if p_document is null or jsonb_typeof(p_document) <> 'object'
        or p_document - array['filename','sha256','sizeBytes','mimeType','extension','objectKey'] <> '{}'::jsonb
        or jsonb_typeof(p_document->'filename') is distinct from 'string'
        or char_length(p_document->>'filename') not between 1 and 512
        or (p_document->>'filename') ~ '[[:cntrl:]]'
        or (p_document->>'sha256') is null or (p_document->>'sha256') !~ '^[0-9a-f]{64}$'
        or jsonb_typeof(p_document->'sizeBytes') is distinct from 'number'
        or (p_document->>'sizeBytes') !~ '^[0-9]+$'
        or (p_document->>'sizeBytes')::bigint not between 1 and 4194304
        or not coalesce(((p_document->>'extension' = 'pdf' and p_document->>'mimeType' = 'application/pdf')
            or (p_document->>'extension' = 'docx' and p_document->>'mimeType' = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')), false)
        or not coalesce((p_document->>'objectKey') ~ ('^staff/' || v_org::text || '/' || p_candidate_id::text || '/[0-9a-f-]{36}\.' || (p_document->>'extension') || '$'), false) then
        raise exception 'CV metadata is invalid' using errcode = '22023';
    end if;
    -- Storage paths and generated candidate IDs change on retry; file content
    -- and every submitted field belong to the stable request identity.
    v_digest := sha256(convert_to(jsonb_build_object('workflow','candidate.upload','fields',p_fields,'document',p_document-'objectKey')::text,'UTF8'));
    v_result := app.recruitment_receipt_v1(p_operation_id, 'candidate.created', v_digest);
    if v_result is not null then return v_result; end if;
    select c.* into v_existing from app.candidate_identifiers i join app.candidates c
        on c.organization_id = i.organization_id and c.id = i.candidate_id
        where i.organization_id = v_org and i.kind = 'email' and i.normalized_value = any(v_emails)
        order by (c.lifecycle <> 'active') desc, i.received_at desc, i.id desc limit 1;
    if found then
        if v_existing.lifecycle <> 'active' then raise exception 'Candidate cannot be added' using errcode = '42501'; end if;
        return jsonb_build_object('status','duplicate','candidateId',v_existing.id);
    end if;
    v_profile := (p_fields - array['firstName','lastName','primaryEmail','secondaryEmails','compensationPreference']) || jsonb_build_object(
        'fullName', btrim(p_fields->>'firstName') || ' ' || btrim(p_fields->>'lastName'), 'email', v_emails[1]);
    v_result := app.save_candidate_profile_v1(p_candidate_id, null, v_profile, gen_random_uuid(), p_correlation_id);
    if v_result->>'status' <> 'created' then return v_result; end if;
    update app.candidates set first_name = btrim(p_fields->>'firstName'), last_name = btrim(p_fields->>'lastName'),
        compensation_preference = nullif(btrim(p_fields->>'compensationPreference'),''),
        secondary_emails = v_emails[2:cardinality(v_emails)]
        where organization_id = v_org and id = p_candidate_id;
    select id into strict v_source from app.candidate_sources where organization_id = v_org and candidate_id = p_candidate_id;
    foreach v_email in array v_emails[2:cardinality(v_emails)] loop
        insert into app.candidate_identifiers(id,organization_id,candidate_id,kind,raw_value,normalized_value,normalization_version,verification,source_id,received_at)
        values(gen_random_uuid(),v_org,p_candidate_id,'email',v_email,v_email,1,'unverified',v_source,v_now);
    end loop;
    insert into app.file_blobs(id,organization_id,candidate_id,sha256,size_bytes,mime_type,extension,lifecycle,scan_state)
        values(v_blob,v_org,p_candidate_id,decode(p_document->>'sha256','hex'),(p_document->>'sizeBytes')::bigint,p_document->>'mimeType',p_document->>'extension','live','unscanned');
    insert into app.blob_locations(id,organization_id,blob_id,backend_key,bucket,object_key,state,is_primary,verified_sha256,verified_size_bytes,verified_at)
        values(gen_random_uuid(),v_org,v_blob,'supabase_storage','cv-submissions',p_document->>'objectKey','available',true,decode(p_document->>'sha256','hex'),(p_document->>'sizeBytes')::bigint,v_now);
    insert into app.documents(id,organization_id,candidate_id,blob_id,purpose,original_filename,source_id,received_at,lifecycle)
        values(v_document,v_org,p_candidate_id,v_blob,'cv',p_document->>'filename',v_source,v_now,'active');
    update app.candidates set current_document_id = v_document where organization_id = v_org and id = p_candidate_id;
    v_result := v_result || jsonb_build_object('documentId',v_document);
    insert into app.recruitment_operation_receipts(operation_id,organization_id,actor_user_id,actor_membership_id,kind,target_id,request_sha256,result)
        values(p_operation_id,v_org,app.context_uuid_v1('app.actor_id'),v_member,'candidate.created',p_candidate_id,v_digest,v_result);
    return v_result;
end $$;

create function app.candidate_upload_referenced_v1(p_object_key text)
returns boolean language plpgsql volatile security definer
set search_path = pg_catalog, app, pg_temp
as $$
begin
    -- A share lock waits for any in-flight upload transaction to commit or roll
    -- back before deciding whether a private storage object is safe to remove.
    perform app.recruitment_actor_v1(array['candidates.read','candidates.write','documents.write'],null,null,false);
    return exists(select 1 from app.blob_locations where organization_id = app.context_uuid_v1('app.organization_id')
        and backend_key = 'supabase_storage' and bucket = 'cv-submissions' and object_key = p_object_key);
end $$;
create function app.get_candidate_upload_details_v1(p_candidate_id uuid)
returns jsonb language plpgsql volatile security definer
set search_path = pg_catalog, app, pg_temp
as $$
begin
    perform app.recruitment_actor_v1(array['candidates.read'],null,null,false);
    return (select jsonb_build_object('firstName',c.first_name,'lastName',c.last_name,
        'compensationPreference',c.compensation_preference,
        'secondaryEmails',to_jsonb(array(select e from unnest(c.secondary_emails) e
            where e <> coalesce(lower(app.candidate_contact_v1(c,'email')),''))))
        from app.candidates c where c.organization_id = app.context_uuid_v1('app.organization_id') and c.id = p_candidate_id and c.lifecycle = 'active');
end $$;
revoke all on function app.get_candidate_upload_details_v1(uuid) from public;
grant execute on function app.get_candidate_upload_details_v1(uuid) to app_staff;
revoke all on function app.create_candidate_upload_v1(uuid,jsonb,jsonb,uuid,uuid) from public;
revoke all on function app.candidate_upload_referenced_v1(text) from public;
grant execute on function app.create_candidate_upload_v1(uuid,jsonb,jsonb,uuid,uuid) to app_staff;
grant execute on function app.candidate_upload_referenced_v1(text) to app_staff;
reset role;
set local role app_owner;
revoke create on schema app from app_executor;
commit;
