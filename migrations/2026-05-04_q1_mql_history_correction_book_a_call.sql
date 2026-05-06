-- Companion fix to 2026-05-04_q1_date_correction_book_a_call.sql.
--
-- That earlier migration moved marketing_sourced_date from 2026-04-02 to
-- 2026-03-31 for 34 Book a Call & Contact Us leads, so they'd count as
-- Q1 Leads instead of Q2 Leads. It did NOT touch stage_history, so any
-- of those 34 that had reached MQL kept their MQL entered_at = 2026-04-02
-- and continued to count as Q2 MQLs. The funnel grid then shows fewer
-- Leads than MQLs in Q2 Website / Book a Call & Contact Us, which is
-- mathematically impossible at the same channel/period.
--
-- This migration moves each MQL stage_history entry on the same 34 leads
-- from 2026-04-02 to 2026-03-31. After this:
--   - Leads bucket: Q1                  (set previously)
--   - MQL bucket:   Q1                  (set here)
--
-- Lead-stage leads (HubSpot Lifecycle = 'Lead' at import time) have an
-- empty stage_history and are skipped by the WHERE EXISTS clause.

-- Pre-flight: how many of the 34 actually have an MQL entry to fix?
-- Should return some N <= 34. Lead-stage rows are skipped.
SELECT COUNT(*) AS will_update
FROM leads
WHERE LOWER(email) IN (
  'jasonm@asebp.ca','nkibim@systemiclogic.com','geremia.maestrini@zurich.com',
  'daniel.lewis@admiralgroup.co.uk','hassan.kagalwala@salama.ae','neill.muller@rgare.com',
  'alain.vanderbeken@ensur.be','zar.malikh@gmail.com','michael.t.penney@emcins.com',
  'jayesh.dighe@scatterpie.io','johpang@deloitte.ca','mohan.ibeforum@gmail.com',
  'bharath@gosure.ai','belle.noma@scoutlogicscreening.com','juhanikorhonen@bernergroupoy.com',
  'pigot_joe@fiduciaryf2partners.com','adly.thebaud@soris.ai','eisgroup-com@alloresearch.com',
  'mar2285@businessbrokersleads.com','simone.bekerman@theciotimes.com','glenn@ai4.co',
  'egdl@valthena.com','katheline.gilbert@wavestone.com','daniel.chavira@bakertilly.com',
  'mazen.abouelela@aprio.com','hchari@mutualofenumclaw.com',
  'romain.douville@twelve-consulting.com','jrdestina@nassagroup.com','mkirkham@vio.bm',
  'muralib@usekreabusiness.com','patrycja.staszewska@mt.com','kyleransome@ondemandtt.com',
  'thelma@mfs.co.zm','jlandicho83@gmail.com'
)
AND stage_history IS NOT NULL
AND jsonb_array_length(stage_history) > 0
AND EXISTS (
  SELECT 1 FROM jsonb_array_elements(stage_history) AS entry
  WHERE entry->>'stage' = 'mql'
    AND entry->>'entered_at' LIKE '2026-04-02%'
);

-- Apply the fix.
BEGIN;

UPDATE leads
SET
  stage_history = (
    SELECT jsonb_agg(
      CASE
        WHEN entry->>'stage' = 'mql'
         AND entry->>'entered_at' LIKE '2026-04-02%'
        THEN jsonb_set(entry::jsonb, '{entered_at}', to_jsonb('2026-03-31'::text))
        ELSE entry
      END
    )
    FROM jsonb_array_elements(stage_history) AS entry
  ),
  last_edited_by = 'manual-q1-correction-mql-history',
  updated_at = now()
WHERE LOWER(email) IN (
  'jasonm@asebp.ca','nkibim@systemiclogic.com','geremia.maestrini@zurich.com',
  'daniel.lewis@admiralgroup.co.uk','hassan.kagalwala@salama.ae','neill.muller@rgare.com',
  'alain.vanderbeken@ensur.be','zar.malikh@gmail.com','michael.t.penney@emcins.com',
  'jayesh.dighe@scatterpie.io','johpang@deloitte.ca','mohan.ibeforum@gmail.com',
  'bharath@gosure.ai','belle.noma@scoutlogicscreening.com','juhanikorhonen@bernergroupoy.com',
  'pigot_joe@fiduciaryf2partners.com','adly.thebaud@soris.ai','eisgroup-com@alloresearch.com',
  'mar2285@businessbrokersleads.com','simone.bekerman@theciotimes.com','glenn@ai4.co',
  'egdl@valthena.com','katheline.gilbert@wavestone.com','daniel.chavira@bakertilly.com',
  'mazen.abouelela@aprio.com','hchari@mutualofenumclaw.com',
  'romain.douville@twelve-consulting.com','jrdestina@nassagroup.com','mkirkham@vio.bm',
  'muralib@usekreabusiness.com','patrycja.staszewska@mt.com','kyleransome@ondemandtt.com',
  'thelma@mfs.co.zm','jlandicho83@gmail.com'
)
AND stage_history IS NOT NULL
AND jsonb_array_length(stage_history) > 0
AND EXISTS (
  SELECT 1 FROM jsonb_array_elements(stage_history) AS entry
  WHERE entry->>'stage' = 'mql'
    AND entry->>'entered_at' LIKE '2026-04-02%'
);

-- Verify: each affected lead's MQL entry should now show entered_at = 2026-03-31.
SELECT
  email,
  marketing_sourced_date,
  current_stage,
  stage_history
FROM leads
WHERE LOWER(email) IN (
  'jasonm@asebp.ca','nkibim@systemiclogic.com','geremia.maestrini@zurich.com',
  'daniel.lewis@admiralgroup.co.uk','hassan.kagalwala@salama.ae','neill.muller@rgare.com',
  'alain.vanderbeken@ensur.be','zar.malikh@gmail.com','michael.t.penney@emcins.com',
  'jayesh.dighe@scatterpie.io','johpang@deloitte.ca','mohan.ibeforum@gmail.com',
  'bharath@gosure.ai','belle.noma@scoutlogicscreening.com','juhanikorhonen@bernergroupoy.com',
  'pigot_joe@fiduciaryf2partners.com','adly.thebaud@soris.ai','eisgroup-com@alloresearch.com',
  'mar2285@businessbrokersleads.com','simone.bekerman@theciotimes.com','glenn@ai4.co',
  'egdl@valthena.com','katheline.gilbert@wavestone.com','daniel.chavira@bakertilly.com',
  'mazen.abouelela@aprio.com','hchari@mutualofenumclaw.com',
  'romain.douville@twelve-consulting.com','jrdestina@nassagroup.com','mkirkham@vio.bm',
  'muralib@usekreabusiness.com','patrycja.staszewska@mt.com','kyleransome@ondemandtt.com',
  'thelma@mfs.co.zm','jlandicho83@gmail.com'
)
ORDER BY email;

-- If the verify result looks right (every MQL entry now shows 2026-03-31),
-- commit. Otherwise rollback.
COMMIT;
-- ROLLBACK;
