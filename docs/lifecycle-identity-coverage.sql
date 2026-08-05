-- =============================================================
-- Bite 4G2B2A: Sourced Salesforce-identity coverage. READ-ONLY.
--
-- Run this in the Supabase SQL Editor against the Production project.
-- It answers the one question the identity-anchored scope rule depends
-- on: how many Sourced people can actually be observed, and how many
-- cannot.
--
-- SAFETY
--   Every statement is a SELECT. Nothing is created, updated, deleted,
--   or granted. It returns AGGREGATES ONLY: counts and nothing else.
--   No Salesforce identifier, email, name, company, campaign, or row is
--   selected, so the result is safe to paste back verbatim.
--
--   `sfdc_lead_id` and `sfdc_contact_id` are nullable TEXT with no CHECK
--   constraint, so a blank string is possible and is counted SEPARATELY
--   from NULL. Conflating them would overstate coverage.
--
--   A Salesforce id is 15 or 18 characters of [A-Za-z0-9]. Anything else
--   is reported as malformed rather than coerced into shape.
-- =============================================================

WITH normalized AS (
  SELECT
    id,
    NULLIF(btrim(COALESCE(sfdc_lead_id, '')), '')    AS lead_id,
    NULLIF(btrim(COALESCE(sfdc_contact_id, '')), '') AS contact_id,
    (sfdc_lead_id IS NOT NULL    AND btrim(sfdc_lead_id) = '')    AS lead_id_blank,
    (sfdc_contact_id IS NOT NULL AND btrim(sfdc_contact_id) = '') AS contact_id_blank
  FROM public.leads
),
classified AS (
  SELECT
    id,
    lead_id,
    contact_id,
    lead_id_blank,
    contact_id_blank,
    (lead_id    ~ '^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$') AS lead_id_wellformed,
    (contact_id ~ '^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$') AS contact_id_wellformed
  FROM normalized
),
dup_lead AS (
  SELECT lead_id, count(*) AS n
  FROM classified WHERE lead_id IS NOT NULL
  GROUP BY lead_id HAVING count(*) > 1
),
dup_contact AS (
  SELECT contact_id, count(*) AS n
  FROM classified WHERE contact_id IS NOT NULL
  GROUP BY contact_id HAVING count(*) > 1
)
SELECT metric, value FROM (
  VALUES
    ('01_total_sourced_people',
      (SELECT count(*) FROM classified)),

    -- Coverage groups. These four are mutually exclusive and sum to the total.
    ('02_lead_id_only',
      (SELECT count(*) FROM classified WHERE lead_id IS NOT NULL AND contact_id IS NULL)),
    ('03_contact_id_only',
      (SELECT count(*) FROM classified WHERE contact_id IS NOT NULL AND lead_id IS NULL)),
    ('04_both_ids_present',
      (SELECT count(*) FROM classified WHERE lead_id IS NOT NULL AND contact_id IS NOT NULL)),
    ('05_neither_id_present',
      (SELECT count(*) FROM classified WHERE lead_id IS NULL AND contact_id IS NULL)),

    -- Distinct identity counts: how many Salesforce records we would query.
    ('06_distinct_lead_ids',
      (SELECT count(DISTINCT lead_id) FROM classified WHERE lead_id IS NOT NULL)),
    ('07_distinct_contact_ids',
      (SELECT count(DISTINCT contact_id) FROM classified WHERE contact_id IS NOT NULL)),

    -- Duplicates: one Salesforce id claimed by more than one Sourced person.
    -- Both the number of duplicated ids and the number of people affected.
    ('08_duplicate_lead_ids',
      (SELECT COALESCE(count(*), 0) FROM dup_lead)),
    ('09_people_affected_by_duplicate_lead_ids',
      (SELECT COALESCE(sum(n), 0) FROM dup_lead)),
    ('10_duplicate_contact_ids',
      (SELECT COALESCE(count(*), 0) FROM dup_contact)),
    ('11_people_affected_by_duplicate_contact_ids',
      (SELECT COALESCE(sum(n), 0) FROM dup_contact)),

    -- Blank strings, reported separately from NULL.
    ('12_lead_id_blank_string',
      (SELECT count(*) FROM classified WHERE lead_id_blank)),
    ('13_contact_id_blank_string',
      (SELECT count(*) FROM classified WHERE contact_id_blank)),

    -- Malformed ids: present but not a valid 15/18 character Salesforce id.
    ('14_lead_id_malformed',
      (SELECT count(*) FROM classified WHERE lead_id IS NOT NULL AND NOT lead_id_wellformed)),
    ('15_contact_id_malformed',
      (SELECT count(*) FROM classified WHERE contact_id IS NOT NULL AND NOT contact_id_wellformed)),

    -- The decision numbers.
    -- Eligible: at least one WELL-FORMED exact Salesforce identity.
    ('16_eligible_identity_anchored',
      (SELECT count(*) FROM classified
        WHERE (lead_id IS NOT NULL AND lead_id_wellformed)
           OR (contact_id IS NOT NULL AND contact_id_wellformed))),
    -- Unobservable: no usable exact identity. Counted separately and
    -- never treated as zero. Email matching is NOT a fallback.
    ('17_unobservable_no_exact_identity',
      (SELECT count(*) FROM classified
        WHERE NOT ((lead_id IS NOT NULL AND lead_id_wellformed)
                OR (contact_id IS NOT NULL AND contact_id_wellformed))))
) AS t(metric, value)
ORDER BY metric;
