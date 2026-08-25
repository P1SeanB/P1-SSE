-- Move three monitoring prices out of source and into the rate tables.
--
-- Honeywell Communicator, Telguard Communicator and BuildingReports.com were never in
-- app_rates. The legacy hardcodes them in its MARKUP:
--
--   legacy/index.html:2037   toggleCB('honeywell', 13.00)
--   legacy/index.html:2038   toggleCB('teleguard', 25.00)
--   legacy/index.html:2039   toggleCB('br',         6.00)
--
-- The port carried them across as `Number(misc.honeywellComm) || 13` fallbacks, which
-- is the same problem wearing different clothes: correct today, and a code change plus
-- a deploy the day a price moves. Rates being data is the point of this migration.
--
-- SAME VALUES, so nothing reprices. This is a storage change, not a pricing change.
--
-- Applied to EVERY rate profile, not just the active one. A profile is a historical
-- record of what a quote was priced against; backfilling only the current one would
-- leave older profiles unable to explain their own numbers.
--
-- ON CONFLICT is not usable here — misc_rate has no unique constraint on
-- (rate_profile_id, rate_key) — so the insert is guarded by NOT EXISTS instead. That
-- also makes it re-runnable, and means a profile where somebody has already set a
-- different price is left alone rather than reset to the legacy default.
INSERT INTO misc_rate (rate_profile_id, rate_key, rate_value)
SELECT rp.rate_profile_id, v.rate_key, v.rate_value
  FROM rate_profile rp
 CROSS JOIN (VALUES
         ('honeywellComm',   13.00),
         ('telguardComm',    25.00),
         ('buildingReports',  6.00)
       ) AS v(rate_key, rate_value)
 WHERE NOT EXISTS (
         SELECT 1 FROM misc_rate m
          WHERE m.rate_profile_id = rp.rate_profile_id
            AND m.rate_key = v.rate_key
       );
