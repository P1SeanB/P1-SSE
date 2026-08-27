// Reading and writing a rate profile. ONE implementation, used by everything.
//
// rates-export.mjs, rates-publish.mjs and parity-rates-roundtrip.mjs all go through
// here on purpose. The first version of the round-trip harness carried its own copy of
// the insert logic, which meant it proved the harness agreed with itself — the exact
// blind spot that hid three real faults in this codebase already: a parity fixture
// shaped unlike the API's response, add-ons compared as dollar amounts on both sides,
// and an adc tree the rates endpoint never returned.
//
// A check that does not run the real code is not a check.

// numeric columns come back as strings from node-postgres. Converted so the exported
// file diffs as numbers — '145.00' -> '145.5' reads as noise, 145 -> 145.5 does not.
export const numeric = (row, drop = []) => {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.endsWith('_id') || drop.includes(k)) continue;
    out[k] = typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
  }
  return out;
};

const SINGLE = [
  ['labor', 'labor_rate'],
  ['serviceCall', 'service_call_rate'],
  ['monitoring', 'monitoring_rate'],
  ['door', 'door_rate'],
  ['video', 'video_rate'],
  ['gcs', 'gcs_rate'],
  ['minRmr', 'min_rmr_rate'],
];

const LISTS = [
  ['tiers', 'tier_rate', 'sort_order'],
  ['doorBundles', 'door_bundle', 'bundle_type, sort_order'],
  ['pricingOptions', 'pricing_option', 'dropdown_group, sort_order'],
];

async function insertRow(client, table, rpId, obj) {
  const cols = Object.keys(obj).filter((k) => obj[k] !== undefined);
  await client.query(
    `INSERT INTO ${table} (rate_profile_id, ${cols.join(', ')})
     VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')})`,
    [rpId, ...cols.map((k) => obj[k])],
  );
}

/**
 * Write a profile as a NEW version and make it active. Never edits the current one:
 * every quote pins the rate_profile_id it was priced against, so rewriting in place
 * would change what past quotes claim they were priced from.
 *
 * Caller owns the transaction — publish commits, the harness rolls back.
 */
export async function publishProfile(client, profile, by) {
  const tag = profile.productTag || 'sse';
  const product = await client.query(
    `INSERT INTO product (tag) VALUES ($1)
     ON CONFLICT (tag) DO UPDATE SET tag = EXCLUDED.tag RETURNING product_id`, [tag],
  );
  const productId = product.rows[0].product_id;

  const currentRow = await client.query(
    'SELECT version FROM rate_profile WHERE product_id = $1 AND is_active', [productId],
  );
  const nextRow = await client.query(
    'SELECT COALESCE(MAX(version), 0) + 1 AS v FROM rate_profile WHERE product_id = $1', [productId],
  );
  const version = nextRow.rows[0].v;

  await client.query('UPDATE rate_profile SET is_active = false WHERE product_id = $1', [productId]);
  const rp = await client.query(
    `INSERT INTO rate_profile (product_id, version, is_active, created_by, adc)
     VALUES ($1, $2, true, $3, $4) RETURNING rate_profile_id`,
    [productId, version, by, profile.adc ? JSON.stringify(profile.adc) : null],
  );
  const rateProfileId = rp.rows[0].rate_profile_id;

  for (const [key, table] of SINGLE) {
    if (profile[key]) await insertRow(client, table, rateProfileId, profile[key]);
  }
  for (const [key, value] of Object.entries(profile.misc || {})) {
    await client.query(
      'INSERT INTO misc_rate (rate_profile_id, rate_key, rate_value) VALUES ($1,$2,$3)',
      [rateProfileId, key, value],
    );
  }
  for (const [key, table] of LISTS) {
    for (const row of profile[key] || []) await insertRow(client, table, rateProfileId, row);
  }

  return { rateProfileId, version, previousVersion: currentRow.rows[0]?.version ?? null, tag };
}

/** Read a profile back in exactly the shape publishProfile accepts. */
export async function readProfile(client, rateProfileId, tag, exportedFromVersion) {
  const out = {
    $schema: 'p1-sse rate profile v1',
    productTag: tag,
    exportedFromVersion,
  };

  for (const [key, table] of SINGLE) {
    const r = await client.query(`SELECT * FROM ${table} WHERE rate_profile_id = $1`, [rateProfileId]);
    out[key] = r.rows[0] ? numeric(r.rows[0]) : null;
  }

  const misc = {};
  const m = await client.query(
    'SELECT rate_key, rate_value FROM misc_rate WHERE rate_profile_id = $1 ORDER BY rate_key', [rateProfileId],
  );
  for (const row of m.rows) misc[row.rate_key] = Number(row.rate_value);
  out.misc = misc;

  for (const [key, table, order] of LISTS) {
    const r = await client.query(
      `SELECT * FROM ${table} WHERE rate_profile_id = $1 ORDER BY ${order}`, [rateProfileId],
    );
    out[key] = r.rows.map((row) => numeric(row));
  }

  const adc = await client.query('SELECT adc FROM rate_profile WHERE rate_profile_id = $1', [rateProfileId]);
  out.adc = adc.rows[0]?.adc || null;

  return out;
}

/** Sections without which the app would price at zero rather than fail. */
export function validateProfile(profile) {
  const problems = [];
  for (const [key] of SINGLE) if (!profile[key]) problems.push(`missing "${key}" — those rates would price at zero`);
  if (!Array.isArray(profile.pricingOptions) || !profile.pricingOptions.length) {
    problems.push('no pricingOptions — every dropdown in the app would be empty');
  }
  if (!profile.adc) problems.push('no adc sheet — supervision, Noonlight and LiftMaster would contribute nothing');
  return problems;
}
