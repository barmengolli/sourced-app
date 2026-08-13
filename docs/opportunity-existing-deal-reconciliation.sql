-- =============================================================
-- Opportunity queue to existing Sourced deal reconciliation.
-- READ-ONLY. AGGREGATE-ONLY.
--
-- Run this in the Supabase SQL Editor against Production before enabling
-- an existing-deal adoption action in the Opportunity queue.
--
-- SAFETY
--   Every statement is a SELECT. Nothing is created, updated, deleted,
--   linked, approved, or refreshed. The result contains counts only. It
--   never returns an Opportunity name, Account name, Salesforce ID, deal
--   ID, lead ID, channel ID, or attribution note.
--
-- MATCH TIERS
--   1. A unique exact Salesforce Opportunity ID found in a legacy sf_link.
--   2. A unique exact normalized Opportunity name and Account name.
--   3. Ambiguous or unmatched records remain manual review work.
-- =============================================================

WITH queue_candidates AS (
  SELECT
    r.id AS review_id,
    o.id AS sf_opportunity_uuid,
    o.sf_opportunity_id,
    lower(regexp_replace(btrim(COALESCE(o.opportunity_name, '')), '\s+', ' ', 'g'))
      AS normalized_opportunity_name,
    lower(regexp_replace(btrim(COALESCE(o.account_name, '')), '\s+', ' ', 'g'))
      AS normalized_account_name
  FROM public.sf_opportunity_reviews r
  JOIN public.sf_opportunities o ON o.id = r.sf_opportunity_uuid
  LEFT JOIN public.sf_opportunity_deal_links l
    ON l.sf_opportunity_uuid = o.id
   AND l.link_state = 'active'
  WHERE r.review_state IN ('pending', 'blocked')
    AND o.normalized_record_type_state IS DISTINCT FROM 'out_of_scope'
    AND l.id IS NULL
),
manual_rows AS (
  SELECT
    a.id AS attribution_id,
    btrim(a.deal_id) AS deal_id,
    lower(regexp_replace(btrim(COALESCE(a.label, '')), '\s+', ' ', 'g')) AS normalized_label,
    lower(regexp_replace(btrim(COALESCE(a.account, '')), '\s+', ' ', 'g')) AS normalized_account,
    a.channel_id,
    a.lead_id,
    a.region,
    a.bdr_name,
    a.sf_link
  FROM public.attributions a
  WHERE a.source_system = 'manual'
    AND NULLIF(btrim(a.deal_id), '') IS NOT NULL
),
touches_by_deal AS (
  SELECT mr.deal_id, count(t.id) AS touch_count
  FROM manual_rows mr
  LEFT JOIN public.attribution_touches t ON t.attribution_id = mr.attribution_id
  GROUP BY mr.deal_id
),
manual_deals AS (
  SELECT
    mr.deal_id,
    min(mr.normalized_label) AS normalized_label,
    min(mr.normalized_account) AS normalized_account,
    count(*) AS stage_rows,
    count(DISTINCT mr.normalized_label) FILTER (WHERE mr.normalized_label <> '') AS label_variants,
    count(DISTINCT mr.normalized_account) FILTER (WHERE mr.normalized_account <> '') AS account_variants,
    count(DISTINCT mr.channel_id) FILTER (WHERE mr.channel_id IS NOT NULL) AS channel_variants,
    count(DISTINCT mr.lead_id) FILTER (WHERE mr.lead_id IS NOT NULL) AS lead_variants,
    count(DISTINCT mr.region) FILTER (WHERE NULLIF(btrim(mr.region), '') IS NOT NULL) AS region_variants,
    count(DISTINCT mr.bdr_name) FILTER (WHERE NULLIF(btrim(mr.bdr_name), '') IS NOT NULL) AS bdr_variants,
    COALESCE(t.touch_count, 0) AS touch_count
  FROM manual_rows mr
  LEFT JOIN touches_by_deal t ON t.deal_id = mr.deal_id
  GROUP BY mr.deal_id, t.touch_count
),
exact_id_matches AS (
  SELECT DISTINCT q.review_id, mr.deal_id
  FROM queue_candidates q
  JOIN manual_rows mr
    ON NULLIF(btrim(mr.sf_link), '') IS NOT NULL
   AND length(q.sf_opportunity_id) >= 15
   AND position(left(q.sf_opportunity_id, 15) IN mr.sf_link) > 0
),
exact_id_rollup AS (
  SELECT review_id, count(DISTINCT deal_id) AS match_count, min(deal_id) AS unique_deal_id
  FROM exact_id_matches
  GROUP BY review_id
),
name_account_matches AS (
  SELECT DISTINCT q.review_id, md.deal_id
  FROM queue_candidates q
  JOIN manual_deals md
    ON md.label_variants = 1
   AND md.account_variants = 1
   AND md.normalized_label = q.normalized_opportunity_name
   AND md.normalized_account = q.normalized_account_name
  WHERE q.normalized_opportunity_name <> ''
    AND q.normalized_account_name <> ''
),
name_account_rollup AS (
  SELECT review_id, count(DISTINCT deal_id) AS match_count, min(deal_id) AS unique_deal_id
  FROM name_account_matches
  GROUP BY review_id
),
classified AS (
  SELECT
    q.review_id,
    COALESCE(e.match_count, 0) AS exact_id_match_count,
    COALESCE(n.match_count, 0) AS name_account_match_count,
    CASE
      WHEN COALESCE(e.match_count, 0) = 1 THEN e.unique_deal_id
      WHEN COALESCE(e.match_count, 0) = 0 AND COALESCE(n.match_count, 0) = 1
        THEN n.unique_deal_id
      ELSE NULL
    END AS selected_deal_id,
    CASE
      WHEN COALESCE(e.match_count, 0) = 1 THEN 'exact_salesforce_id_unique'
      WHEN COALESCE(e.match_count, 0) > 1 THEN 'exact_salesforce_id_ambiguous'
      WHEN COALESCE(n.match_count, 0) = 1 THEN 'exact_name_account_unique'
      WHEN COALESCE(n.match_count, 0) > 1 THEN 'exact_name_account_ambiguous'
      ELSE 'no_match'
    END AS match_class
  FROM queue_candidates q
  LEFT JOIN exact_id_rollup e ON e.review_id = q.review_id
  LEFT JOIN name_account_rollup n ON n.review_id = q.review_id
),
unique_match_quality AS (
  SELECT
    c.review_id,
    md.stage_rows,
    md.touch_count,
    (
      md.label_variants <= 1
      AND md.account_variants <= 1
      AND md.channel_variants <= 1
      AND md.lead_variants <= 1
      AND md.region_variants <= 1
      AND md.bdr_variants <= 1
    ) AS legacy_fields_consistent
  FROM classified c
  JOIN manual_deals md ON md.deal_id = c.selected_deal_id
),
active_links AS (
  SELECT
    l.id AS link_id,
    l.deal_id,
    o.sf_opportunity_id,
    lower(regexp_replace(btrim(COALESCE(o.opportunity_name, '')), '\s+', ' ', 'g'))
      AS normalized_opportunity_name,
    lower(regexp_replace(btrim(COALESCE(o.account_name, '')), '\s+', ' ', 'g'))
      AS normalized_account_name
  FROM public.sf_opportunity_deal_links l
  JOIN public.sf_opportunities o ON o.id = l.sf_opportunity_uuid
  WHERE l.link_state = 'active'
),
active_legacy_matches AS (
  SELECT DISTINCT al.link_id, md.deal_id
  FROM active_links al
  JOIN manual_deals md
    ON md.deal_id <> al.deal_id
   AND md.label_variants = 1
   AND md.account_variants = 1
   AND md.normalized_label = al.normalized_opportunity_name
   AND md.normalized_account = al.normalized_account_name
  WHERE al.normalized_opportunity_name <> ''
    AND al.normalized_account_name <> ''
  UNION
  SELECT DISTINCT al.link_id, mr.deal_id
  FROM active_links al
  JOIN manual_rows mr
    ON mr.deal_id <> al.deal_id
   AND NULLIF(btrim(mr.sf_link), '') IS NOT NULL
   AND length(al.sf_opportunity_id) >= 15
   AND position(left(al.sf_opportunity_id, 15) IN mr.sf_link) > 0
),
active_legacy_rollup AS (
  SELECT link_id, count(DISTINCT deal_id) AS legacy_match_count
  FROM active_legacy_matches
  GROUP BY link_id
),
orphan_salesforce_projections AS (
  SELECT count(DISTINCT a.sf_opportunity_id) AS opportunity_count
  FROM public.attributions a
  WHERE a.source_system = 'salesforce'
    AND NULLIF(btrim(a.sf_opportunity_id), '') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.sf_opportunities o
      JOIN public.sf_opportunity_deal_links l
        ON l.sf_opportunity_uuid = o.id
       AND l.link_state = 'active'
      WHERE o.sf_opportunity_id = a.sf_opportunity_id
    )
)
SELECT metric, value
FROM (
  VALUES
    ('01_attention_reviews_without_active_link',
      (SELECT count(*) FROM queue_candidates)),
    ('02_exact_salesforce_id_unique',
      (SELECT count(*) FROM classified WHERE match_class = 'exact_salesforce_id_unique')),
    ('03_exact_salesforce_id_ambiguous',
      (SELECT count(*) FROM classified WHERE match_class = 'exact_salesforce_id_ambiguous')),
    ('04_exact_name_account_unique',
      (SELECT count(*) FROM classified WHERE match_class = 'exact_name_account_unique')),
    ('05_exact_name_account_ambiguous',
      (SELECT count(*) FROM classified WHERE match_class = 'exact_name_account_ambiguous')),
    ('06_no_existing_manual_deal_match',
      (SELECT count(*) FROM classified WHERE match_class = 'no_match')),
    ('07_unique_matches_with_consistent_legacy_fields',
      (SELECT count(*) FROM unique_match_quality WHERE legacy_fields_consistent)),
    ('08_unique_matches_with_conflicting_legacy_fields',
      (SELECT count(*) FROM unique_match_quality WHERE NOT legacy_fields_consistent)),
    ('09_unique_matches_with_attribution_touches',
      (SELECT count(*) FROM unique_match_quality WHERE touch_count > 0)),
    ('10_attribution_touches_on_unique_matches',
      (SELECT COALESCE(sum(touch_count), 0) FROM unique_match_quality)),
    ('11_active_salesforce_links',
      (SELECT count(*) FROM active_links)),
    ('12_active_links_with_possible_legacy_duplicate',
      (SELECT count(*) FROM active_legacy_rollup WHERE legacy_match_count = 1)),
    ('13_active_links_with_ambiguous_legacy_duplicates',
      (SELECT count(*) FROM active_legacy_rollup WHERE legacy_match_count > 1)),
    ('14_orphan_salesforce_projection_opportunities',
      (SELECT opportunity_count FROM orphan_salesforce_projections))
) AS results(metric, value)
ORDER BY metric;
