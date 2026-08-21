import { app } from '@azure/functions';
import { getPool } from '../db.js';

// GET /api/rates — replaces the old Supabase
// `sb.from('app_rates').select('config').eq('app','sse').single()` read.
// Route protection (must be signed in) is enforced by staticwebapp.config.json,
// not by this function, so this handler assumes an already-authenticated caller.
app.http('rates', {
  methods: ['GET'],
  authLevel: 'anonymous', // SWA's platform-level auth gate already blocked unauthenticated callers
  route: 'rates',
  handler: async (request, context) => {
    const productTag = process.env.PRODUCT_TAG || 'sse';
    const pool = await getPool();

    const profileResult = await pool.request()
      .input('tag', productTag)
      .query(`
        SELECT rp.RateProfileId, rp.Version
        FROM dbo.ActiveRateProfile rp
        WHERE rp.ProductTag = @tag
      `);

    const profile = profileResult.recordset[0];
    if (!profile) {
      return { status: 404, jsonBody: { error: 'No active rate profile for ' + productTag } };
    }
    const rateProfileId = profile.RateProfileId;

    const [labor, svc, monitoring, door, doorBundles, video, gcs, minRmr, misc, tiers, options] =
      await Promise.all([
        pool.request().input('id', rateProfileId).query('SELECT * FROM dbo.LaborRate WHERE RateProfileId=@id'),
        pool.request().input('id', rateProfileId).query('SELECT * FROM dbo.ServiceCallRate WHERE RateProfileId=@id'),
        pool.request().input('id', rateProfileId).query('SELECT * FROM dbo.MonitoringRate WHERE RateProfileId=@id'),
        pool.request().input('id', rateProfileId).query('SELECT * FROM dbo.DoorRate WHERE RateProfileId=@id'),
        pool.request().input('id', rateProfileId).query('SELECT * FROM dbo.DoorBundle WHERE RateProfileId=@id ORDER BY BundleType, SortOrder'),
        pool.request().input('id', rateProfileId).query('SELECT * FROM dbo.VideoRate WHERE RateProfileId=@id'),
        pool.request().input('id', rateProfileId).query('SELECT * FROM dbo.GcsRate WHERE RateProfileId=@id'),
        pool.request().input('id', rateProfileId).query('SELECT * FROM dbo.MinRmrRate WHERE RateProfileId=@id'),
        pool.request().input('id', rateProfileId).query('SELECT * FROM dbo.MiscRate WHERE RateProfileId=@id'),
        pool.request().input('id', rateProfileId).query('SELECT * FROM dbo.TierRate WHERE RateProfileId=@id ORDER BY SortOrder'),
        pool.request().input('id', rateProfileId).query('SELECT * FROM dbo.PricingOption WHERE RateProfileId=@id ORDER BY DropdownGroup, SortOrder'),
      ]);

    const miscMap = {};
    for (const row of misc.recordset) miscMap[row.RateKey] = row.RateValue;

    const optionsByGroup = {};
    for (const row of options.recordset) {
      (optionsByGroup[row.DropdownGroup] ||= []).push({
        value: row.OptionValue,
        label: row.Label,
        price: row.Price,
      });
    }

    return {
      jsonBody: {
        rateProfileId,
        version: profile.Version,
        labor: labor.recordset[0] || null,
        serviceCall: svc.recordset[0] || null,
        monitoring: monitoring.recordset[0] || null,
        door: door.recordset[0] || null,
        doorBundles: doorBundles.recordset,
        video: video.recordset[0] || null,
        gcs: gcs.recordset[0] || null,
        minRmr: minRmr.recordset[0] || null,
        misc: miscMap,
        tiers: tiers.recordset,
        dropdownOptions: optionsByGroup,
      },
    };
  },
});
