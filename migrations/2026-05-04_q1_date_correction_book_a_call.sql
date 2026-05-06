-- One-off correction: 34 Book a Call & Contact Us leads were imported with
-- Member First Associated Date = 4/2/2026 but actually converted in Q1.
-- We pin marketing_sourced_date to 2026-03-31 (last day of Q1) and lock the
-- field so future re-imports don't overwrite it. SFDC's reported date moves
-- into source_sfdc.marketing_sourced_date so the drift remains visible.
--
-- Run in Supabase SQL Editor. Pre-flight count below should return 34
-- before you run the UPDATE.

-- Pre-flight: should return 34
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
);

-- Run the correction in a transaction so you can verify before committing.
BEGIN;

UPDATE leads
SET
  source_sfdc = COALESCE(source_sfdc, '{}'::jsonb) || jsonb_build_object(
    'marketing_sourced_date',
    COALESCE(source_sfdc->>'marketing_sourced_date', marketing_sourced_date::text)
  ),
  marketing_sourced_date = '2026-03-31',
  field_locks = COALESCE(field_locks, '{}'::jsonb)
                || '{"marketing_sourced_date": true}'::jsonb,
  last_edited_by = 'manual-q1-correction',
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
);

-- Verify the affected rows
SELECT
  email,
  marketing_sourced_date,
  source_sfdc->>'marketing_sourced_date' AS sfdc_says,
  field_locks->>'marketing_sourced_date' AS locked
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

-- If the result looks right:
COMMIT;
-- If something looks off:
-- ROLLBACK;
