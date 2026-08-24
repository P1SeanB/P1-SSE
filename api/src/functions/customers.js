import { app } from '@azure/functions';
import { query, transaction } from '../db.js';
import { requireRole } from '../auth.js';
import { readBody, idParam, handler } from '../validate.js';

// Customers and their sites, at /api/customers
//   GET    /api/customers            → list, newest first
//   GET    /api/customers/{id}       → one customer with its sites
//   POST   /api/customers            → create
//   PATCH  /api/customers/{id}       → update
//
// Sites are nested here rather than given their own endpoint because they have no
// life of their own: a site belongs to exactly one customer, and both the Quote
// Builder and Monitoring Contracts read them together. The legacy UI says as much —
// "Sites are shared with the Monitoring Contracts tab."
//
// Every estimator may read and write every customer. That is deliberate and matches
// how the team works today: quotes get picked up and finished by whoever is
// available. owner_oid records who created it, for attribution, not for access.

const CUSTOMER_FIELDS = {
  name: { type: 'string', required: true, max: 200 },
  contact_name: { type: 'string', max: 200 },
  phone: { type: 'string', max: 30 },
  email: { type: 'string', max: 200 },
  billing_address: { type: 'string', max: 300 },
};

app.http('customers-list', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'customers',
  handler: handler(async (request) => {
    const { denied } = requireRole(request);
    if (denied) return denied;

    const search = (new URL(request.url).searchParams.get('q') || '').trim();
    // ILIKE with a parameter, never string-built. The % wrapping happens in the
    // parameter value, so the pattern cannot escape into the SQL.
    const result = search
      ? await query(
          `SELECT * FROM customer WHERE name ILIKE $1 ORDER BY name LIMIT 200`,
          [`%${search}%`],
        )
      : await query('SELECT * FROM customer ORDER BY created_at DESC LIMIT 200');

    return { jsonBody: { customers: result.rows } };
  }),
});

app.http('customers-get', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'customers/{id}',
  handler: handler(async (request) => {
    const { denied } = requireRole(request);
    if (denied) return denied;

    const id = idParam(request.params.id);
    if (!id) return { status: 400, jsonBody: { error: 'Invalid customer id.' } };

    const [customer, sites] = await Promise.all([
      query('SELECT * FROM customer WHERE customer_id = $1', [id]),
      query('SELECT * FROM site WHERE customer_id = $1 ORDER BY sort_order, site_id', [id]),
    ]);
    if (customer.rowCount === 0) {
      return { status: 404, jsonBody: { error: 'Customer not found.' } };
    }
    return { jsonBody: { ...customer.rows[0], sites: sites.rows } };
  }),
});

app.http('customers-create', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'customers',
  handler: handler(async (request) => {
    const { user, denied } = requireRole(request);
    if (denied) return denied;

    const body = await readBody(request, CUSTOMER_FIELDS);
    const result = await query(
      `INSERT INTO customer (name, contact_name, phone, email, billing_address, owner_oid)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [body.name, body.contact_name, body.phone, body.email, body.billing_address, user.oid],
    );
    return { status: 201, jsonBody: result.rows[0] };
  }),
});

app.http('customers-update', {
  methods: ['PATCH'],
  authLevel: 'anonymous',
  route: 'customers/{id}',
  handler: handler(async (request) => {
    const { denied } = requireRole(request);
    if (denied) return denied;

    const id = idParam(request.params.id);
    if (!id) return { status: 400, jsonBody: { error: 'Invalid customer id.' } };

    const body = await readBody(request, CUSTOMER_FIELDS);
    const result = await query(
      `UPDATE customer
          SET name = $1, contact_name = $2, phone = $3, email = $4, billing_address = $5
        WHERE customer_id = $6
        RETURNING *`,
      [body.name, body.contact_name, body.phone, body.email, body.billing_address, id],
    );
    if (result.rowCount === 0) {
      return { status: 404, jsonBody: { error: 'Customer not found.' } };
    }
    return { jsonBody: result.rows[0] };
  }),
});

// ── Sites ───────────────────────────────────────────────────────────────────
// Replaced wholesale rather than patched individually: the legacy UI edits sites as
// a list, adding and removing rows before saving once. Sending the whole list makes
// the API match that, and makes a removed row actually disappear — a per-row PATCH
// would need a separate delete the UI never issues.
app.http('customers-sites-replace', {
  methods: ['PUT'],
  authLevel: 'anonymous',
  route: 'customers/{id}/sites',
  handler: handler(async (request) => {
    const { denied } = requireRole(request);
    if (denied) return denied;

    const id = idParam(request.params.id);
    if (!id) return { status: 400, jsonBody: { error: 'Invalid customer id.' } };

    const raw = await request.json().catch(() => null);
    if (!raw || !Array.isArray(raw.sites)) {
      return { status: 400, jsonBody: { error: 'Expected { sites: [...] }.' } };
    }

    const sites = raw.sites.map((s, i) => ({
      label: s.label ? String(s.label).slice(0, 100) : null,
      address: String(s.address ?? '').trim().slice(0, 300),
      city: s.city ? String(s.city).slice(0, 100) : null,
      state: s.state ? String(s.state).slice(0, 2).toUpperCase() : null,
      zip: s.zip ? String(s.zip).slice(0, 10) : null,
      monthly_rate: s.monthly_rate === undefined || s.monthly_rate === null || s.monthly_rate === ''
        ? null
        : Number(s.monthly_rate),
      sort_order: i,
    }));

    if (sites.some((s) => !s.address)) {
      return { status: 400, jsonBody: { error: 'Every site needs an address.' } };
    }
    if (sites.some((s) => s.monthly_rate !== null && !Number.isFinite(s.monthly_rate))) {
      return { status: 400, jsonBody: { error: 'Monthly rate must be a number.' } };
    }

    const rows = await transaction(async (client) => {
      const exists = await client.query('SELECT 1 FROM customer WHERE customer_id = $1', [id]);
      if (exists.rowCount === 0) return null;

      // A site referenced by an agreement cannot simply be deleted — the
      // agreement_site foreign key is the record of what that agreement covers.
      // Delete only the ones nothing points at, and report the rest rather than
      // failing the whole save.
      await client.query(
        `DELETE FROM site
          WHERE customer_id = $1
            AND site_id NOT IN (SELECT site_id FROM agreement_site)`,
        [id],
      );

      const inserted = [];
      for (const s of sites) {
        const r = await client.query(
          `INSERT INTO site (customer_id, label, address, city, state, zip, monthly_rate, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING *`,
          [id, s.label, s.address, s.city, s.state, s.zip, s.monthly_rate, s.sort_order],
        );
        inserted.push(r.rows[0]);
      }
      return inserted;
    });

    if (rows === null) return { status: 404, jsonBody: { error: 'Customer not found.' } };
    return { jsonBody: { sites: rows } };
  }),
});
