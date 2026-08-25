import { app } from '@azure/functions';
import { query } from '../db.js';

// GET /api/rates — replaces the Supabase read
// `sb.from('app_rates').select('config').eq('app','sse').single()`.
//
// The legacy version returned one JSON blob. This assembles the same shape from the
// normalised tables, so the frontend contract is unchanged while the data becomes
// queryable and versioned. Every quote pins the rate_profile_id it was priced with,
// which is what makes an old quote explainable later.
//
// Route protection is enforced by staticwebapp.config.json — every route requires
// the sse-users role — so this handler can assume an authenticated caller. That is
// why authLevel is 'anonymous': the gate is the platform's, not the function's.
app.http('rates', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'rates',
  handler: async (request, context) => {
    const productTag = process.env.PRODUCT_TAG || 'sse';

    const profile = await query(
      'SELECT rate_profile_id, version FROM active_rate_profile WHERE product_tag = $1',
      [productTag],
    );
    if (profile.rowCount === 0) {
      return {
        status: 404,
        jsonBody: {
          error:
            `No active rate profile for "${productTag}". Publish one, or check ` +
            `PRODUCT_TAG matches a row in the product table.`,
        },
      };
    }
    const { rate_profile_id: id, version } = profile.rows[0];

    // One round trip per table, issued together. The pool is deliberately small, so
    // this is bounded by it rather than by the number of queries.
    const [labor, svc, monitoring, door, doorBundles, video, gcs, minRmr, misc, tiers, options, sheet] =
      await Promise.all([
        query('SELECT * FROM labor_rate WHERE rate_profile_id = $1', [id]),
        query('SELECT * FROM service_call_rate WHERE rate_profile_id = $1', [id]),
        query('SELECT * FROM monitoring_rate WHERE rate_profile_id = $1', [id]),
        query('SELECT * FROM door_rate WHERE rate_profile_id = $1', [id]),
        query('SELECT * FROM door_bundle WHERE rate_profile_id = $1 ORDER BY bundle_type, sort_order', [id]),
        query('SELECT * FROM video_rate WHERE rate_profile_id = $1', [id]),
        query('SELECT * FROM gcs_rate WHERE rate_profile_id = $1', [id]),
        query('SELECT * FROM min_rmr_rate WHERE rate_profile_id = $1', [id]),
        query('SELECT rate_key, rate_value FROM misc_rate WHERE rate_profile_id = $1', [id]),
        query('SELECT * FROM tier_rate WHERE rate_profile_id = $1 ORDER BY sort_order', [id]),
        query('SELECT * FROM pricing_option WHERE rate_profile_id = $1 ORDER BY dropdown_group, sort_order', [id]),
        // Alarm.com's price sheet, stored as published. src/lib/adc.js consumes it as a
        // tree; WITHOUT IT adcCfg is null and supervision, Noonlight licences and the
        // LiftMaster surcharge each contribute zero to a quote (adc.js:193, :202, :217).
        // That was the state before the Supabase import: three charges silently missing
        // from every commercial quote.
        query('SELECT adc FROM rate_profile WHERE rate_profile_id = $1', [id]),
      ]);

    const miscMap = {};
    for (const row of misc.rows) miscMap[row.rate_key] = row.rate_value;

    // Grouped the way the legacy dropdownsHTML was keyed, so a <select> renders real
    // <option> elements from data instead of the app injecting stored markup.
    const optionsByGroup = {};
    for (const row of options.rows) {
      (optionsByGroup[row.dropdown_group] ||= []).push({
        value: row.option_value,
        label: row.label,
        price: row.price,
          // From the legacy data-type attribute. src/lib/adc.js:76 reads this to decide
          // whether a video selection is flat, per-camera or an expansion package —
          // omit it and every tier prices as flat, quietly and plausibly.
          type: row.option_type,
          // The legacy title attribute: guidance an estimator reads while choosing.
          tooltip: row.tooltip,
      });
    }

    return {
      jsonBody: {
        rateProfileId: id,
        version,
        labor: labor.rows[0] || null,
        serviceCall: svc.rows[0] || null,
        monitoring: monitoring.rows[0] || null,
        door: door.rows[0] || null,
        doorBundles: doorBundles.rows,
        video: video.rows[0] || null,
        gcs: gcs.rows[0] || null,
        minRmr: minRmr.rows[0] || null,
        misc: miscMap,
        tiers: tiers.rows,
        // null when no sheet has been imported. adc.js already guards on that, and a
        // null reads as "not loaded" where an empty object would read as "free".
        adc: sheet.rows[0]?.adc || null,
        dropdownOptions: optionsByGroup,
      },
    };
  },
});
