import { app } from '@azure/functions';
import { query } from '../db.js';
import { requireRole } from '../auth.js';
import { readBody, idParam, handler } from '../validate.js';

// Quotes, at /api/quotes
//   GET   /api/quotes?customerId=&mine=1   → list
//   GET   /api/quotes/{id}                 → one
//   POST  /api/quotes                      → create
//   PATCH /api/quotes/{id}                 → update, with a concurrency check
//
// This is the feature the legacy app never had. Quotes lived in the browser and were
// exported as .p1est files onto a shared OneDrive folder, so a refresh lost work and
// two people could not see each other's estimates.
//
// form_data is jsonb and holds the line items, materials, BOM and T&M detail. It is
// deliberately not normalised further: its shape is still moving as the Quote Builder
// gains features, and a schema migration per UI change would slow that down for no
// gain. The values that need to be QUERIED — customer, rate profile, the headline RMR
// figures — are real columns.

const QUOTE_FIELDS = {
  customer_id: { type: 'integer', required: true, min: 1 },
  estimate_type: { type: 'enum', required: true, values: ['time_and_materials', 'flat_rate'] },
  system_type: { type: 'string', max: 50 },
  site_type: { type: 'enum', values: ['Residential', 'Commercial'] },
  form_data: { type: 'json', required: true },
  recommended_rmr: { type: 'number', min: 0 },
  monitoring_rmr: { type: 'number', min: 0 },
};

app.http('quotes-list', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'quotes',
  handler: handler(async (request) => {
    const { user, denied } = requireRole(request);
    if (denied) return denied;

    const params = new URL(request.url).searchParams;
    const customerId = idParam(params.get('customerId'));
    const mineOnly = params.get('mine') === '1';

    // Built from a fixed set of fragments with positional parameters — never by
    // concatenating values.
    const where = [];
    const values = [];
    if (customerId) {
      values.push(customerId);
      where.push(`q.customer_id = $${values.length}`);
    }
    if (mineOnly) {
      values.push(user.oid);
      where.push(`q.owner_oid = $${values.length}`);
    }

    const result = await query(
      `SELECT q.quote_id, q.customer_id, c.name AS customer_name, q.estimate_type,
              q.system_type, q.site_type, q.recommended_rmr, q.monitoring_rmr,
              q.owner_oid, q.created_at, q.updated_at, q.row_version
         FROM quote q
         JOIN customer c ON c.customer_id = q.customer_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY q.updated_at DESC
        LIMIT 200`,
      values,
    );
    return { jsonBody: { quotes: result.rows } };
  }),
});

app.http('quotes-get', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'quotes/{id}',
  handler: handler(async (request) => {
    const { denied } = requireRole(request);
    if (denied) return denied;

    const id = idParam(request.params.id);
    if (!id) return { status: 400, jsonBody: { error: 'Invalid quote id.' } };

    const result = await query(
      `SELECT q.*, c.name AS customer_name, rp.version AS rate_version
         FROM quote q
         JOIN customer c ON c.customer_id = q.customer_id
         JOIN rate_profile rp ON rp.rate_profile_id = q.rate_profile_id
        WHERE q.quote_id = $1`,
      [id],
    );
    if (result.rowCount === 0) return { status: 404, jsonBody: { error: 'Quote not found.' } };
    return { jsonBody: result.rows[0] };
  }),
});

app.http('quotes-create', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'quotes',
  handler: handler(async (request) => {
    const { user, denied } = requireRole(request);
    if (denied) return denied;

    const body = await readBody(request, QUOTE_FIELDS);

    // Pin the rate profile in force RIGHT NOW. The client does not get to choose it:
    // a quote is priced with one published rate set, and recording which one is what
    // lets someone explain a six-month-old number instead of re-deriving it from
    // today's rates and getting a different answer.
    const active = await query(
      'SELECT rate_profile_id FROM active_rate_profile WHERE product_tag = $1',
      [process.env.PRODUCT_TAG || 'sse'],
    );
    if (active.rowCount === 0) {
      return {
        status: 409,
        jsonBody: { error: 'No active rate profile — a quote cannot be priced until one is published.' },
      };
    }

    const result = await query(
      `INSERT INTO quote (customer_id, rate_profile_id, estimate_type, system_type, site_type,
                          form_data, recommended_rmr, monitoring_rmr, owner_oid)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        body.customer_id,
        active.rows[0].rate_profile_id,
        body.estimate_type,
        body.system_type,
        body.site_type,
        JSON.stringify(body.form_data),
        body.recommended_rmr,
        body.monitoring_rmr,
        user.oid,
      ],
    );
    return { status: 201, jsonBody: result.rows[0] };
  }),
});

app.http('quotes-update', {
  methods: ['PATCH'],
  authLevel: 'anonymous',
  route: 'quotes/{id}',
  handler: handler(async (request) => {
    const { denied } = requireRole(request);
    if (denied) return denied;

    const id = idParam(request.params.id);
    if (!id) return { status: 400, jsonBody: { error: 'Invalid quote id.' } };

    const body = await readBody(request, {
      ...QUOTE_FIELDS,
      customer_id: { type: 'integer', min: 1 },   // not moveable between customers
      row_version: { type: 'integer', required: true, min: 1 },
    });

    // Optimistic concurrency. Two estimators opening the same quote is the realistic
    // conflict here, and without this the second save silently overwrites the first —
    // the failure is invisible, and the lost work only surfaces when a number is
    // wrong days later.
    //
    // The WHERE clause carries the check, so it is atomic: no read-then-write gap
    // where another save could land in between.
    const result = await query(
      `UPDATE quote
          SET estimate_type = $1, system_type = $2, site_type = $3, form_data = $4,
              recommended_rmr = $5, monitoring_rmr = $6,
              updated_at = now(), row_version = row_version + 1
        WHERE quote_id = $7 AND row_version = $8
        RETURNING *`,
      [
        body.estimate_type,
        body.system_type,
        body.site_type,
        JSON.stringify(body.form_data),
        body.recommended_rmr,
        body.monitoring_rmr,
        id,
        body.row_version,
      ],
    );

    if (result.rowCount === 0) {
      // Tell the two cases apart. "Someone else saved" needs a different response
      // from the person than "this quote is gone".
      const current = await query('SELECT row_version FROM quote WHERE quote_id = $1', [id]);
      if (current.rowCount === 0) return { status: 404, jsonBody: { error: 'Quote not found.' } };
      return {
        status: 409,
        jsonBody: {
          error: 'Someone else saved this quote while you were editing. Reload to see their changes before saving again.',
          currentVersion: current.rows[0].row_version,
        },
      };
    }
    return { jsonBody: result.rows[0] };
  }),
});
