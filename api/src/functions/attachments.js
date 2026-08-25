import { app } from '@azure/functions';
import { query } from '../db.js';
import { requireRole } from '../auth.js';
import { idParam, handler } from '../validate.js';

// Change-request attachments, at /api/change-requests/{id}/files
//   POST  …/files              upload one file
//   GET   …/files/{fileId}     download it
//
// Replaces the Supabase storage bucket. Two things are different, and both are
// deliberate.
//
// THE BYTES STREAM THROUGH THIS FUNCTION rather than being handed out as a signed
// URL. The storage account has allowSharedKeyAccess disabled, so an account-key SAS
// cannot be minted at all — which is the point: a signed URL, once created, works for
// anyone who has it until it expires, and it leaks by being forwarded. Streaming
// means every download is authorised at the moment it happens, by the same gate as
// the rest of the API. A user-delegation SAS would also work and would scale better
// for large files; these are screenshots and exports, so the simpler path wins.
//
// PATHS KEEP THE LEGACY SHAPE — "<requestId>/<timestamp>-<n>-<name>" — so objects
// copy across from the Supabase bucket without rewriting stored paths.

// Matches the CHECK constraint on change_request_file.size_bytes, and the limit the
// legacy bucket enforced. Stated here as well so an oversized upload is refused
// before the bytes are written rather than after.
const MAX_BYTES = 25 * 1024 * 1024;

const ROLES = ['export', 'screenshot', 'fixed_export'];

// Filenames land in a blob path and in a Content-Disposition header. Anything that
// could traverse a path or break out of the header is stripped rather than escaped —
// the original name is kept in the database column for display.
const safeName = (name) =>
  String(name || 'file')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 120) || 'file';

let containerClient;
async function container() {
  if (containerClient) return containerClient;
  const name = process.env.AZURE_STORAGE_CONTAINER || 'change-requests';
  const { BlobServiceClient } = await import('@azure/storage-blob');

  // LOCAL DEVELOPMENT ONLY. Azurite authenticates by shared key, and the real
  // storage account has shared-key access disabled — so the passwordless path below
  // cannot work against the emulator, and the emulator's key cannot work against
  // Azure. Setting this in Azure would be both pointless and a step backwards, which
  // is why it is named for what it is and never appears in infra/main.bicep.
  const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (conn) {
    const client = BlobServiceClient.fromConnectionString(conn);
    containerClient = client.getContainerClient(name);
    // Azurite starts empty; the container the app expects has to exist before the
    // first upload, and creating it here saves a setup step that is easy to forget.
    await containerClient.createIfNotExists();
    return containerClient;
  }

  const url = process.env.AZURE_STORAGE_ACCOUNT_URL;
  if (!url) {
    throw new Error(
      'Storage is not configured. Set AZURE_STORAGE_ACCOUNT_URL (Azure) or ' +
        'AZURE_STORAGE_CONNECTION_STRING (local Azurite).',
    );
  }
  const { DefaultAzureCredential } = await import('@azure/identity');
  containerClient = new BlobServiceClient(url, new DefaultAzureCredential()).getContainerClient(name);
  return containerClient;
}

app.http('change-request-file-upload', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'change-requests/{id}/files',
  handler: handler(async (request, context) => {
    const { user, denied } = requireRole(request);
    if (denied) return denied;

    const id = idParam(request.params.id);
    if (!id) return { status: 400, jsonBody: { error: 'Invalid request id.' } };

    const exists = await query('SELECT 1 FROM change_request WHERE change_request_id = $1', [id]);
    if (exists.rowCount === 0) return { status: 404, jsonBody: { error: 'Request not found.' } };

    const form = await request.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') {
      return { status: 400, jsonBody: { error: 'Attach a file to upload.' } };
    }
    const role = ROLES.includes(form.get('role')) ? form.get('role') : 'screenshot';

    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.length === 0) {
      return { status: 400, jsonBody: { error: 'That file is empty.' } };
    }
    if (bytes.length > MAX_BYTES) {
      return {
        status: 413,
        jsonBody: { error: `That file is larger than the ${MAX_BYTES / 1024 / 1024} MB limit.` },
      };
    }

    const path = `${id}/${Date.now()}-${safeName(file.name)}`;
    const c = await container();
    await c.getBlockBlobClient(path).uploadData(bytes, {
      blobHTTPHeaders: { blobContentType: file.type || 'application/octet-stream' },
    });

    // Recorded only after the bytes are safely stored — a row pointing at a blob that
    // does not exist is worse than a blob nothing points at, because the UI offers it
    // as a download and it 404s.
    const row = await query(
      `INSERT INTO change_request_file
         (change_request_id, file_role, storage_path, filename, mime_type, size_bytes,
          uploaded_by_oid, uploaded_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [id, role, path, file.name, file.type || null, bytes.length, user.oid, user.name],
    );

    context.log(`[attachments] request ${id}: stored ${path} (${bytes.length} bytes)`);
    return { status: 201, jsonBody: row.rows[0] };
  }),
});

app.http('change-request-file-download', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'change-requests/{id}/files/{fileId}',
  handler: handler(async (request) => {
    const { denied } = requireRole(request);
    if (denied) return denied;

    const id = idParam(request.params.id);
    const fileId = idParam(request.params.fileId);
    if (!id || !fileId) return { status: 400, jsonBody: { error: 'Invalid id.' } };

    // Scoped to the request in the URL, so a valid file id belonging to a different
    // request cannot be fetched by guessing.
    const row = await query(
      `SELECT * FROM change_request_file
        WHERE change_request_file_id = $1 AND change_request_id = $2`,
      [fileId, id],
    );
    if (row.rowCount === 0) return { status: 404, jsonBody: { error: 'File not found.' } };
    const file = row.rows[0];

    const c = await container();
    const blob = c.getBlockBlobClient(file.storage_path);
    if (!(await blob.exists())) {
      // The row outlived its blob. Say so plainly rather than returning an empty
      // download that looks like a corrupt file.
      return { status: 404, jsonBody: { error: 'That attachment is no longer stored.' } };
    }

    const buffer = await blob.downloadToBuffer();
    return {
      status: 200,
      headers: {
        'Content-Type': file.mime_type || 'application/octet-stream',
        // Quoted and stripped of anything that could break out of the header.
        'Content-Disposition': `attachment; filename="${safeName(file.filename)}"`,
        'Content-Length': String(buffer.length),
        // Attachments are immutable once written, but they are not public — cache in
        // the browser only, never in a shared proxy.
        'Cache-Control': 'private, max-age=3600',
      },
      body: buffer,
    };
  }),
});
