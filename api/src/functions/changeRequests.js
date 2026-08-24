import { app } from '@azure/functions';
import { query, transaction } from '../db.js';
import { requireRole, ROLE_DEVELOPER } from '../auth.js';
import { readBody, idParam, handler } from '../validate.js';

// Change requests, at /api/change-requests
//   GET   /api/change-requests?status=&app=&type=   → list
//   GET   /api/change-requests/{id}                 → one, with notes and files
//   POST  /api/change-requests                      → raise one
//   PATCH /api/change-requests/{id}                 → change status — DEVELOPERS ONLY
//   POST  /api/change-requests/{id}/notes           → add a note
//
// Replaces the cr_* Supabase tables. Two things changed on the way across, both
// deliberate:
//
// 1. NO PROFILES TABLE. cr_profiles held id/email/display_name/is_developer keyed to
//    a Supabase Auth account. Identity is Entra now, so the requester's object id,
//    email and name are snapshotted onto the row — which is what a list needs anyway,
//    and keeps a record readable after someone leaves the company.
//
// 2. is_developer IS NOT A COLUMN. It gated who could change a request's status while
//    living in a table the requesters could write to. It is now the sse-developers
//    role, resolved from an Entra group at login by getRoles.js.

const REQUEST_FIELDS = {
  app: { type: 'string', required: true, max: 60 },
  page: { type: 'string', max: 120 },
  url: { type: 'string', max: 1000 },
  request_type: { type: 'enum', required: true, values: ['change', 'suggestion', 'bug'] },
  priority: { type: 'enum', values: ['low', 'normal', 'high'], default: 'normal' },
  title: { type: 'string', required: true, max: 200, min: 1 },
  description: { type: 'string', required: true, min: 1 },
  desired_result: { type: 'string' },
};

app.http('change-requests-list', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'change-requests',
  handler: handler(async (request) => {
    const { denied } = requireRole(request);
    if (denied) return denied;

    const params = new URL(request.url).searchParams;
    const where = [];
    const values = [];

    // Each filter is validated against a known set before it reaches the query, so
    // an unexpected value is dropped rather than passed through.
    const status = params.get('status');
    if (['open', 'in_progress', 'done', 'wont_do'].includes(status)) {
      values.push(status);
      where.push(`status = $${values.length}`);
    }
    const type = params.get('type');
    if (['change', 'suggestion', 'bug'].includes(type)) {
      values.push(type);
      where.push(`request_type = $${values.length}`);
    }
    const appName = params.get('app');
    if (appName) {
      values.push(appName.slice(0, 60));
      where.push(`app = $${values.length}`);
    }

    const result = await query(
      `SELECT * FROM change_request_list
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY created_at DESC
        LIMIT 500`,
      values,
    );
    return { jsonBody: { requests: result.rows } };
  }),
});

app.http('change-requests-get', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'change-requests/{id}',
  handler: handler(async (request) => {
    const { denied } = requireRole(request);
    if (denied) return denied;

    const id = idParam(request.params.id);
    if (!id) return { status: 400, jsonBody: { error: 'Invalid request id.' } };

    const [req, notes, files] = await Promise.all([
      query('SELECT * FROM change_request_list WHERE change_request_id = $1', [id]),
      query(
        'SELECT * FROM change_request_note WHERE change_request_id = $1 ORDER BY created_at DESC',
        [id],
      ),
      query(
        'SELECT * FROM change_request_file WHERE change_request_id = $1 ORDER BY uploaded_at',
        [id],
      ),
    ]);
    if (req.rowCount === 0) return { status: 404, jsonBody: { error: 'Request not found.' } };

    return { jsonBody: { ...req.rows[0], notes: notes.rows, files: files.rows } };
  }),
});

app.http('change-requests-create', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'change-requests',
  handler: handler(async (request) => {
    const { user, denied } = requireRole(request);
    if (denied) return denied;

    const body = await readBody(request, REQUEST_FIELDS);
    const result = await query(
      `INSERT INTO change_request
         (app, page, url, request_type, priority, title, description, desired_result,
          requester_oid, requester_email, requester_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        body.app, body.page, body.url, body.request_type, body.priority,
        body.title, body.description, body.desired_result,
        user.oid, user.email, user.name,
      ],
    );
    return { status: 201, jsonBody: result.rows[0] };
  }),
});

app.http('change-requests-update-status', {
  methods: ['PATCH'],
  authLevel: 'anonymous',
  route: 'change-requests/{id}',
  handler: handler(async (request) => {
    // The gate that used to be a column. Anyone signed in may RAISE a request;
    // deciding it is done is the development team's.
    const { user, denied } = requireRole(request, ROLE_DEVELOPER);
    if (denied) return denied;

    const id = idParam(request.params.id);
    if (!id) return { status: 400, jsonBody: { error: 'Invalid request id.' } };

    const body = await readBody(request, {
      status: { type: 'enum', required: true, values: ['open', 'in_progress', 'done', 'wont_do'] },
      note: { type: 'string' },
    });

    // The status change and its audit note are one unit — a status that moved with
    // no record of who moved it is exactly what someone asks about later.
    const updated = await transaction(async (client) => {
      const before = await client.query(
        'SELECT status FROM change_request WHERE change_request_id = $1',
        [id],
      );
      if (before.rowCount === 0) return null;
      const from = before.rows[0].status;
      if (from === body.status && !body.note) return { unchanged: true };

      const r = await client.query(
        `UPDATE change_request SET status = $1, updated_at = now()
          WHERE change_request_id = $2 RETURNING *`,
        [body.status, id],
      );

      const text = body.note
        ? body.note
        : `Status changed from ${from.replace('_', ' ')} to ${body.status.replace('_', ' ')}.`;
      await client.query(
        `INSERT INTO change_request_note
           (change_request_id, note_type, body, author_oid, author_email, author_name)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, body.note ? 'note' : 'status_change', text, user.oid, user.email, user.name],
      );

      return r.rows[0];
    });

    if (updated === null) return { status: 404, jsonBody: { error: 'Request not found.' } };
    if (updated.unchanged) return { status: 200, jsonBody: { unchanged: true } };
    return { jsonBody: updated };
  }),
});

app.http('change-requests-add-note', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'change-requests/{id}/notes',
  handler: handler(async (request) => {
    // Any signed-in user may comment — the person who raised it needs to answer
    // questions on it, and that is most of the conversation.
    const { user, denied } = requireRole(request);
    if (denied) return denied;

    const id = idParam(request.params.id);
    if (!id) return { status: 400, jsonBody: { error: 'Invalid request id.' } };

    const body = await readBody(request, {
      body: { type: 'string', required: true, min: 1 },
    });

    const exists = await query(
      'SELECT 1 FROM change_request WHERE change_request_id = $1',
      [id],
    );
    if (exists.rowCount === 0) return { status: 404, jsonBody: { error: 'Request not found.' } };

    const result = await query(
      `INSERT INTO change_request_note
         (change_request_id, note_type, body, author_oid, author_email, author_name)
       VALUES ($1, 'note', $2, $3, $4, $5)
       RETURNING *`,
      [id, body.body, user.oid, user.email, user.name],
    );
    return { status: 201, jsonBody: result.rows[0] };
  }),
});
