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
end
$$;

set local role app_owner;
grant create on schema app to app_executor;
reset role;
set local role app_executor;

alter function app.submit_public_application_v1(
    uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid,
    text, text, text, text, text, text, bytea, bigint, text, text, text, text, text
) rename to submit_public_application_core_v1;
revoke all on function app.submit_public_application_core_v1(
    uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid,
    text, text, text, text, text, text, bytea, bigint, text, text, text, text, text
) from public, app_intake;

create function app.submit_public_application_v1(
    p_candidate_id uuid, p_source_id uuid, p_email_identifier_id uuid,
    p_url_identifier_id uuid, p_application_id uuid, p_history_id uuid,
    p_audit_id uuid, p_correlation_id uuid, p_blob_id uuid, p_location_id uuid,
    p_document_id uuid, p_job_slug text, p_public_reference text, p_full_name text,
    p_email text, p_professional_url text, p_achievement text, p_blob_sha256 bytea,
    p_blob_size_bytes bigint, p_mime_type text, p_extension text, p_bucket text,
    p_object_key text, p_filename text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, app, pg_temp
as $$
declare
    v_org uuid := app.context_uuid_v1('app.organization_id');
begin
    if v_org is null or app.context_uuid_v1('app.actor_id') is not null then
        raise exception 'Public intake context is required' using errcode = '42501';
    end if;
    perform o.id from app.organizations o where o.id = v_org for update;
    if not found then raise exception 'Organization not found' using errcode = 'P0002'; end if;
    if exists (select 1 from app.candidate_identifiers i join app.candidates c
        on c.organization_id = i.organization_id and c.id = i.candidate_id
        where i.organization_id = v_org and i.kind = 'email'
            and i.normalized_value = lower(btrim(p_email)) and c.lifecycle <> 'active') then
        raise exception 'Application cannot be accepted' using errcode = '42501';
    end if;
    return app.submit_public_application_core_v1(p_candidate_id, p_source_id,
        p_email_identifier_id, p_url_identifier_id, p_application_id, p_history_id,
        p_audit_id, p_correlation_id, p_blob_id, p_location_id, p_document_id,
        p_job_slug, p_public_reference, p_full_name, p_email, p_professional_url,
        p_achievement, p_blob_sha256, p_blob_size_bytes, p_mime_type, p_extension,
        p_bucket, p_object_key, p_filename);
end
$$;

create or replace function app.get_document_download_v1(p_document_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, app, pg_temp
as $$
declare
    v_org uuid := app.context_uuid_v1('app.organization_id');
    v_member uuid;
    v_row record;
begin
    v_member := app.recruitment_actor_v1(array['candidates.read', 'documents.download'],
        null, null, false);
    if p_document_id is null then
        raise exception 'Document id is required' using errcode = '22023';
    end if;
    select d.id as document_id, d.candidate_id, d.original_filename,
        b.scan_state, b.mime_type, l.bucket, l.object_key
    into v_row
    from app.documents d join app.candidates c
        on c.organization_id = d.organization_id and c.id = d.candidate_id
    join app.file_blobs b on b.organization_id = d.organization_id
        and b.candidate_id = d.candidate_id and b.id = d.blob_id
    join app.blob_locations l on l.organization_id = b.organization_id and l.blob_id = b.id
    where d.organization_id = v_org and d.id = p_document_id
        and c.lifecycle = 'active' and d.lifecycle = 'active'
        and b.lifecycle = 'live' and b.scan_state <> 'infected'
        and l.is_primary and l.state = 'available'
        and l.verified_sha256 = b.sha256 and l.verified_size_bytes = b.size_bytes;
    if not found then raise exception 'Document unavailable' using errcode = 'P0002'; end if;
    insert into app.audit_events (id, organization_id, actor_kind, actor_user_id,
        actor_membership_id, action, target_type, target_id, correlation_id, occurred_at, details)
    values (gen_random_uuid(), v_org, 'staff', app.context_uuid_v1('app.actor_id'), v_member,
        'document.downloaded', 'document', v_row.document_id, gen_random_uuid(), clock_timestamp(),
        jsonb_build_object('candidate_id', v_row.candidate_id));
    return jsonb_build_object('bucket', v_row.bucket, 'objectKey', v_row.object_key,
        'filename', v_row.original_filename, 'mimeType', v_row.mime_type, 'scanState', v_row.scan_state);
end
$$;

create function app.review_candidate_import_v1(p_records jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, app, pg_temp
as $$
declare
    v_org uuid := app.context_uuid_v1('app.organization_id');
    v_record jsonb;
    v_fields jsonb;
    v_match app.candidates;
    v_index integer := 0;
    v_email text;
    v_emails text[] := '{}';
    v_status text;
    v_reason text;
    v_match_id uuid;
    v_result jsonb := '[]'::jsonb;
begin
    perform app.recruitment_actor_v1(array['candidates.read', 'candidates.write'], null, null, false);
    if jsonb_typeof(p_records) is distinct from 'array' then
        raise exception 'Import must be a list of candidates' using errcode = '22023';
    end if;
    if jsonb_array_length(p_records) not between 1 and 100 then
        raise exception 'Import between 1 and 100 rows at a time' using errcode = '22023';
    end if;
    for v_record in select value from jsonb_array_elements(p_records) loop
        v_fields := v_record -> 'fields';
        v_status := 'ready'; v_reason := null; v_match_id := null;
        v_email := lower(nullif(btrim(v_fields ->> 'email'), ''));
        if not app.candidate_fields_valid_v1(v_fields)
            or octet_length(v_record ->> 'note') > 16384 then
            v_status := 'invalid'; v_reason := 'Check required fields and field lengths.';
        elsif v_email is not null and v_email = any(v_emails) then
            v_status := 'duplicate'; v_reason := 'Email repeats within this file.';
        else
            select c.* into v_match from app.candidate_identifiers i
            join app.candidates c on c.organization_id = i.organization_id and c.id = i.candidate_id
            where i.organization_id = v_org and i.kind = 'email'
                and i.normalized_value = v_email
            order by (c.lifecycle <> 'active') desc, i.received_at desc, i.id desc limit 1;
            if found then
                if v_match.lifecycle <> 'active' then
                    v_status := 'blocked'; v_reason := 'This row requires a separate record review.';
                else
                    v_status := 'duplicate'; v_reason := 'Email already exists in the workspace.';
                    v_match_id := v_match.id;
                end if;
            elsif exists (select 1 from app.candidates c where c.organization_id = v_org
                and c.lifecycle = 'active' and lower(btrim(c.full_name)) = lower(btrim(v_fields ->> 'fullName'))) then
                v_status := 'possible_match'; v_reason := 'A candidate has the same name; check before adding.';
            end if;
        end if;
        if v_email is not null then v_emails := array_append(v_emails, v_email); end if;
        v_result := v_result || jsonb_build_array(jsonb_build_object('index', v_index,
            'status', v_status, 'reason', v_reason, 'candidateId', v_match_id));
        v_index := v_index + 1;
    end loop;
    return jsonb_build_object('rows', v_result);
end
$$;

revoke all on function app.submit_public_application_v1(
    uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid,
    text, text, text, text, text, text, bytea, bigint, text, text, text, text, text
) from public;
grant execute on function app.submit_public_application_v1(
    uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid,
    text, text, text, text, text, text, bytea, bigint, text, text, text, text, text
) to app_intake;
revoke all on function app.review_candidate_import_v1(jsonb) from public;
grant execute on function app.review_candidate_import_v1(jsonb) to app_staff;

reset role;
set local role app_owner;
revoke create on schema app from app_executor;
commit;
