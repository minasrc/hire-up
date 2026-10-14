begin;
set local lock_timeout='2s';
set local statement_timeout='30s';
set local role app_owner;
grant create on schema app to app_executor;
reset role;
set local role app_executor;

-- Only explicit year statements qualify; unknown experience never satisfies a filter.
create function app.candidate_experience_years_v1(p_text text) returns numeric[]
language plpgsql immutable set search_path=pg_catalog,app,pg_temp as $$
declare words text[]:=array['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen','twenty']; normalized text:=lower(coalesce(p_text,''));
begin
 for i in 1..array_length(words,1) loop
  normalized:=regexp_replace(normalized, '\m'||words[i]||'\M', (i-1)::text, 'g');
 end loop;
 return array(select (m[1])::numeric from regexp_matches(normalized, '\m([0-9]+(?:\.[0-9]+)?)\s*\+?\s*(?:years?|yrs?)\M', 'g') m);
end $$;
revoke all on function app.candidate_experience_years_v1(text) from public;

create function app.list_candidate_profile_directory_v2(p_query text, p_page integer, p_intent jsonb)
returns jsonb language plpgsql volatile security definer
set search_path = pg_catalog, app, pg_temp
as $$
declare
    v_org uuid := app.context_uuid_v1('app.organization_id');
begin
    perform app.recruitment_actor_v1(array['candidates.read'], null, null, false);
    if p_query is null or length(p_query) > 200 or p_page is null
        or p_page not between 1 and 1000000 then
        raise exception 'Invalid candidate directory filters' using errcode = '22023';
    end if;
    return (
        with filtered as materialized (
            select c.id, c.full_name, c.created_at,
                case when lower(c.full_name)=lower(p_query) or lower(app.candidate_contact_v1(c,'email'))=lower(p_query) then 4
                    when strpos(lower(concat_ws(' ',c.full_name,app.candidate_contact_v1(c,'email'))),lower(p_query))>0 then 3
                    when strpos(lower(coalesce(c.headline,'')),lower(p_query))>0 then 2
                    else 1 end as match_rank
            from app.candidates c
            where c.organization_id = v_org and c.lifecycle = 'active'
                and (p_query = '' or (
                    (strpos(lower(coalesce(c.full_name, '') || ' ' || coalesce(app.candidate_contact_v1(c, 'email'), '')), lower(p_query)) > 0
                    or (jsonb_array_length(p_intent->'terms') > 0 and not exists (
                        select 1 from jsonb_array_elements_text(p_intent->'terms') term
                        where not exists (select 1 from regexp_split_to_table(lower(concat_ws(' ', c.full_name,
                            app.candidate_contact_v1(c, 'email'), c.headline, c.location, c.professional_summary)), '[^[:alnum:]+#.]+') word
                            where (case when length(word)>3 then regexp_replace(word, 's$', '') else word end)=term)
                    )) or (p_intent->'experience' <> 'null'::jsonb and jsonb_array_length(p_intent->'terms')=0))
                    and (p_intent->'experience' = 'null'::jsonb or exists (
                        select 1 from unnest(app.candidate_experience_years_v1(concat_ws(' ', c.headline,c.professional_summary))) years
                        where case p_intent->'experience'->>'comparison'
                            when 'gte' then years >= (p_intent->'experience'->>'years')::numeric
                            when 'lte' then years <= (p_intent->'experience'->>'years')::numeric
                            when 'gt' then years > (p_intent->'experience'->>'years')::numeric
                            when 'lt' then years < (p_intent->'experience'->>'years')::numeric
                            else years = (p_intent->'experience'->>'years')::numeric end
                    ))
                ))
        ), metadata as (
            select count(*) as total,
                least(p_page, greatest(1, (count(*) + 49) / 50))::integer as page
            from filtered
        ), paged as (
            select * from filtered order by match_rank desc, created_at desc, id desc
            limit 50 offset (select (page - 1) * 50 from metadata)
        )
        select jsonb_build_object(
            'total', m.total, 'page', m.page, 'pageSize', 50,
            'rows', coalesce((select jsonb_agg(jsonb_build_object(
                'candidateId', c.id, 'fullName', c.full_name,
                'email', app.candidate_contact_v1(c, 'email'),
                'headline', c.headline, 'location', c.location,
                'ownerName', ou.display_name,
                'applicationCount', (select count(*) from app.applications a
                    where a.organization_id = v_org and a.candidate_id = c.id),
                'hasCv', c.current_document_id is not null, 'createdAt', c.created_at
            ) order by p.match_rank desc, c.created_at desc, c.id desc)
                from paged p join app.candidates c on c.id = p.id and c.organization_id = v_org
                left join app.organization_memberships om
                    on om.id = c.owner_membership_id and om.organization_id = v_org
                left join app.users ou on ou.id = om.user_id), '[]'::jsonb),
            'profileOptions', app.get_candidate_profile_options_v1()
        ) from metadata m
    );
end
$$;
revoke all on function app.list_candidate_profile_directory_v2(text,integer,jsonb) from public;
grant execute on function app.list_candidate_profile_directory_v2(text,integer,jsonb) to app_staff;
reset role;
set local role app_owner;
revoke create on schema app from app_executor;
commit;
