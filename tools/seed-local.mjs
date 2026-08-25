// Prepare the local database: apply the schema, then publish one rate profile.
//
//   npm run db:local
//
// WHY A SEED IS REQUIRED, not a nicety. App.jsx blocks on the rates call — with no
// ACTIVE rate profile the API returns 404 and the app shows an error instead of any
// tabs. So a freshly created database gives you a dead screen, and the natural
// conclusion is that something is broken rather than empty.
//
// The numbers here are PLAUSIBLE BUT INVENTED. They are not Point 1's rates and must
// never be treated as them — this exists so the UI renders and behaves, not so
// anyone can quote from it. Real rates live in the database each environment points
// at, published through the rate-admin path.
import { readFileSync } from 'node:fs';
import pg from 'pg';

const cfg = {
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5433),
  database: process.env.PGDATABASE || 'sse',
  user: process.env.PGUSER || 'sse',
  password: process.env.PGPASSWORD || 'sse',
  ssl: false,
};

// Refuse to run anywhere that looks like a real environment. This script publishes
// invented rates and would happily overwrite the active profile.
if (/\.postgres\.database\.azure\.com$/i.test(cfg.host)) {
  console.error(
    `\n  REFUSING: "${cfg.host}" is an Azure PostgreSQL server.\n\n` +
      `  This seeds INVENTED rates and marks them active. Run it against the local\n` +
      `  container only (PGHOST=localhost). Real rates are published through the app.\n`,
  );
  process.exit(1);
}

const client = new pg.Client(cfg);

const RATE_PROFILE = {
  labor: {
    labor_cost_per_hr: 120, labor_bill_default: 145, labor_sell_default: 180,
    svc_gm: 45, sub_markup: 15, av_maint_gm: 40, mat_markup: 69, tm_sub_gm: 42,
    overhead_rate: 12,
  },
  serviceCall: {
    straight_time_rate: 145, time_and_half_rate: 217.5, double_time_rate: 290,
    priority_multiplier: 1.15, premier_multiplier: 1.3,
  },
  monitoring: { base_rate: 35, addon_rate: 8 },
  door: { sacp_rate: 3.25, standard_rate: 2 },
  video: { expansion_base_rate: 24, server_rate: 6.5 },
  gcs: {
    fire_rate: 32, burg_rate: 26, residential_rate: 18, two_way_rate: 12,
    sf_burg_residential: 22, sf_burg_commercial: 30,
  },
  minRmr: { commercial_floor: 75, residential_floor: 45, two_way_floor: 35 },
  misc: { ulCerts: 12, pmVisitRate: 145, honeywellComm: 13, telguardComm: 25, buildingReports: 6 },
  tiers: [
    ['Standard', 'Standard response', 145, 1],
    ['Priority', 'Priority response', 166.75, 2],
    ['Premier', 'Premier response', 188.5, 3],
  ],
  options: [
    ['adc-base', '4.95', 'Residential — $4.95', 4.95, 1],
    ['adc-base', '11.50', 'Commercial — $11.50', 11.5, 2],
    ['adc-base', '13.95', 'Commercial Plus — $13.95', 13.95, 3],
    ['adc-video', '1.50', 'Commercial Video — $1.50/camera', 1.5, 1],
    ['adc-video', '3.10', 'Commercial Video Plus — $3.10/camera', 3.1, 2],
    ['adc-video', '9.99', 'Video Doorbell — $9.99', 9.99, 3],
    ['adc-addons', 'liftmaster-integration', 'LiftMaster integration', 2.5, 1],
    ['adc-addons', 'locks', 'Locks', 1.5, 2],
    ['adc-addons', 'thermostats', 'Thermostats', 1.5, 3],
    ['adc-sensors', '2.00', 'Up to 10 sensors — $2.00', 2, 1],
    ['adc-comms', '5.00', 'Cellular — $5.00', 5, 1],
    ['alarmnet-plan', '18.00', 'AlarmNet TC2 — $18.00', 18, 1],
    ['connectone-systems', '25.00', '1 system — $25.00', 25, 1],
    ['connectone-sms', '3.00', 'SMS — $3.00', 3, 1],
    ['overheadRate', '0.12', '12%', 0.12, 1],
  ],
};

async function main() {
  await client.connect();
  console.log(`  connected to ${cfg.host}:${cfg.port}/${cfg.database}`);

  const schema = readFileSync(new URL('../db/schema.pg.sql', import.meta.url), 'utf8');
  await client.query(schema);
  console.log('  schema applied');

  await client.query('BEGIN');
  try {
    const product = await client.query(
      `INSERT INTO product (tag) VALUES ($1)
       ON CONFLICT (tag) DO UPDATE SET tag = EXCLUDED.tag
       RETURNING product_id`,
      ['sse'],
    );
    const productId = product.rows[0].product_id;

    // Re-seeding replaces the active profile rather than adding a second one — the
    // partial unique index allows only one active per product, and a failed insert
    // here would read as a schema problem rather than a re-run.
    await client.query('UPDATE rate_profile SET is_active = false WHERE product_id = $1', [productId]);
    const nextVersion = await client.query(
      'SELECT COALESCE(MAX(version), 0) + 1 AS v FROM rate_profile WHERE product_id = $1',
      [productId],
    );
    const version = nextVersion.rows[0].v;

    const profile = await client.query(
      `INSERT INTO rate_profile (product_id, version, is_active, created_by)
       VALUES ($1, $2, true, $3) RETURNING rate_profile_id`,
      [productId, version, 'seed-local'],
    );
    const id = profile.rows[0].rate_profile_id;

    const insertOne = async (table, obj) => {
      const cols = Object.keys(obj);
      const params = cols.map((_, i) => `$${i + 2}`).join(', ');
      await client.query(
        `INSERT INTO ${table} (rate_profile_id, ${cols.join(', ')}) VALUES ($1, ${params})`,
        [id, ...cols.map((c) => obj[c])],
      );
    };

    await insertOne('labor_rate', RATE_PROFILE.labor);
    await insertOne('service_call_rate', RATE_PROFILE.serviceCall);
    await insertOne('monitoring_rate', RATE_PROFILE.monitoring);
    await insertOne('door_rate', RATE_PROFILE.door);
    await insertOne('video_rate', RATE_PROFILE.video);
    await insertOne('gcs_rate', RATE_PROFILE.gcs);
    await insertOne('min_rmr_rate', RATE_PROFILE.minRmr);

    for (const [key, value] of Object.entries(RATE_PROFILE.misc)) {
      await client.query(
        'INSERT INTO misc_rate (rate_profile_id, rate_key, rate_value) VALUES ($1,$2,$3)',
        [id, key, value],
      );
    }
    for (const [name, label, rate, sort] of RATE_PROFILE.tiers) {
      await client.query(
        'INSERT INTO tier_rate (rate_profile_id, tier_name, label, rate, sort_order) VALUES ($1,$2,$3,$4,$5)',
        [id, name, label, rate, sort],
      );
    }
    for (const [group, value, label, price, sort] of RATE_PROFILE.options) {
      await client.query(
        `INSERT INTO pricing_option (rate_profile_id, dropdown_group, option_value, label, price, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, group, value, label, price, sort],
      );
    }

    // Door bundles, both packages.
    for (const [type, rows] of Object.entries({
      SACP: [[1, 8, 26, 1], [9, 16, 48, 2], [17, null, 88, 3]],
      Standard: [[1, 8, 16, 1], [9, 16, 30, 2], [17, null, 55, 3]],
    })) {
      for (const [min, max, price, sort] of rows) {
        await client.query(
          `INSERT INTO door_bundle (rate_profile_id, bundle_type, min_doors, max_doors, price, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, type, min, max, price, sort],
        );
      }
    }

    await client.query('COMMIT');
    console.log(`  published rate profile v${version} (active)`);
    console.log('\n  Ready. Start the app with: npm run dev:swa\n');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`\n  FAILED: ${err.message}\n`);
  process.exit(1);
});
