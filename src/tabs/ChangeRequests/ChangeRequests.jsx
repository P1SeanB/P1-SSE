import React, { useCallback, useEffect, useState } from 'react';
import { Card, Field, TextInput, SectionLabel } from '../../components/ui.jsx';

// Change requests — replaces legacy/change-request.js (1,035 lines against six
// Supabase tables, a storage bucket, and Supabase Auth accounts).
//
// Identity comes from the platform now. The legacy prompted for a Supabase sign-in
// inside the app and kept an is_developer flag in cr_profiles — a permission column
// in a table the requesters themselves could write to. Here the caller is already
// authenticated by Static Web Apps, and who may change a status is an Entra group
// resolved at login.
//
// Everything talks to /api/change-requests, which validates independently. This file
// never decides who may do what; it asks, and renders what it is allowed to see.

const STATUSES = [
  { value: 'open', label: 'Open', fg: '#1954b0', bg: '#e8effd' },
  { value: 'in_progress', label: 'In Progress', fg: '#8a5a00', bg: '#fef3da' },
  { value: 'done', label: 'Done', fg: '#1a6b4a', bg: '#e8f5ef' },
  { value: 'wont_do', label: "Won't Do", fg: '#6b6b6b', bg: '#eeeeee' },
];
const TYPES = [
  { value: 'change', label: 'Change' },
  { value: 'suggestion', label: 'Suggestion' },
  { value: 'bug', label: 'Bug' },
];
const PRIORITIES = [
  { value: 'low', label: 'Low' },
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'High' },
];

const statusMeta = (v) => STATUSES.find((s) => s.value === v) || { label: v, fg: '#6b6b6b', bg: '#eee' };
const labelOf = (list, v) => (list.find((x) => x.value === v) || {}).label || v;
const when = (iso) => (iso ? new Date(iso).toLocaleString() : '');

function StatusPill({ value }) {
  const m = statusMeta(value);
  return (
    <span style={{
      background: m.bg, color: m.fg, borderRadius: 999, padding: '0.1rem 0.55rem',
      fontSize: '0.78rem', fontWeight: 600, whiteSpace: 'nowrap',
    }}>{m.label}</span>
  );
}

async function api(path, options) {
  const res = await fetch(`/api/change-requests${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // The API says what went wrong and how to fix it; passing its message through
    // beats replacing it with a generic failure.
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return body;
}

export default function ChangeRequests({ appName = 'SSE', canChangeStatus = false }) {
  const [view, setView] = useState('list');       // list | form | detail
  const [rows, setRows] = useState([]);
  const [current, setCurrent] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({ status: '', type: '', q: '' });

  const load = useCallback(async () => {
    setBusy(true); setError('');
    try {
      const params = new URLSearchParams();
      if (filters.status) params.set('status', filters.status);
      if (filters.type) params.set('type', filters.type);
      const data = await api(`?${params}`);
      setRows(data.requests || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }, [filters.status, filters.type]);

  useEffect(() => { if (view === 'list') load(); }, [view, load]);

  const open = async (id) => {
    setBusy(true); setError('');
    try {
      setCurrent(await api(`/${id}`));
      setView('detail');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  // Search filters the loaded page rather than round-tripping: the list is capped at
  // 500 and an estimator scanning for a request they filed is looking at a page they
  // already have.
  const term = filters.q.trim().toLowerCase();
  const visible = term
    ? rows.filter((r) =>
        `${r.title} ${r.description} ${r.requester_name || ''}`.toLowerCase().includes(term))
    : rows;

  if (view === 'form') {
    return <RequestForm appName={appName} onCancel={() => setView('list')}
      onCreated={() => { setView('list'); }} />;
  }

  if (view === 'detail' && current) {
    return <RequestDetail request={current} canChangeStatus={canChangeStatus}
      onBack={() => { setCurrent(null); setView('list'); }}
      onChanged={() => open(current.change_request_id)} />;
  }

  return (
    <Card title="Change Requests">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'end' }}>
          <button type="button" onClick={() => setView('form')}>+ New request</button>
          <button type="button" onClick={load} disabled={busy}>
            {busy ? 'Refreshing…' : 'Refresh'}
          </button>
          <Field label="Search">
            <TextInput value={filters.q} onChange={(v) => setFilters({ ...filters, q: v })}
              placeholder="Title, description, person" />
          </Field>
          <Field label="Status">
            <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
              <option value="">Any status</option>
              {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </Field>
          <Field label="Type">
            <select value={filters.type} onChange={(e) => setFilters({ ...filters, type: e.target.value })}>
              <option value="">Any type</option>
              {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </Field>
        </div>

        {error && <div role="alert" style={{ color: '#a32a25' }}>{error}</div>}

        {!busy && visible.length === 0 && (
          <p style={{ margin: 0, color: 'var(--text-muted, #6b7688)' }}>
            {rows.length === 0 ? 'No requests yet.' : 'Nothing matches those filters.'}
          </p>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
          {visible.map((r) => (
            <button key={r.change_request_id} type="button" onClick={() => open(r.change_request_id)}
              style={{
                textAlign: 'left', display: 'grid',
                gridTemplateColumns: 'auto 1fr auto auto', gap: '0.6rem',
                alignItems: 'center', padding: '0.6rem', background: 'transparent',
                border: '1px solid var(--border, #d8dbe0)', borderRadius: 6, cursor: 'pointer',
              }}>
              <StatusPill value={r.status} />
              <span>
                <strong>{r.title}</strong>
                <br />
                <span style={{ fontSize: '0.82rem', color: 'var(--text-muted, #6b7688)' }}>
                  {labelOf(TYPES, r.request_type)} · {r.app} · {r.requester_name || r.requester_email} · {when(r.created_at)}
                </span>
              </span>
              <span style={{ fontSize: '0.82rem' }}>
                {Number(r.note_count) > 0 && `${r.note_count} note${r.note_count > 1 ? 's' : ''}`}
              </span>
              <span style={{ fontSize: '0.82rem' }}>
                {Number(r.file_count) > 0 && `${r.file_count} file${r.file_count > 1 ? 's' : ''}`}
              </span>
            </button>
          ))}
        </div>
      </div>
    </Card>
  );
}

function RequestForm({ appName, onCancel, onCreated }) {
  const [form, setForm] = useState({
    title: '', description: '', desired_result: '',
    request_type: 'change', priority: 'normal',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const set = (patch) => setForm({ ...form, ...patch });

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try {
      await api('', {
        method: 'POST',
        body: JSON.stringify({
          ...form,
          app: appName,
          // Captured automatically — the person reporting a problem should not have
          // to describe where they were when it happened.
          page: document.title || '',
          url: location.href.slice(0, 1000),
        }),
      });
      onCreated();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Card title="New change request">
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
        <Field label="Title">
          <TextInput value={form.title} onChange={(v) => set({ title: v })}
            placeholder="What is this about?" required />
        </Field>
        <Field label="What are you asking for?">
          <textarea value={form.description} onChange={(e) => set({ description: e.target.value })}
            rows={5} style={{ width: '100%' }} required
            placeholder="What happens now, and what should happen instead" />
        </Field>
        <Field label="Desired result (optional)">
          <textarea value={form.desired_result} onChange={(e) => set({ desired_result: e.target.value })}
            rows={2} style={{ width: '100%' }} />
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem' }}>
          <Field label="Type">
            <select value={form.request_type} onChange={(e) => set({ request_type: e.target.value })}>
              {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </Field>
          <Field label="Priority">
            <select value={form.priority} onChange={(e) => set({ priority: e.target.value })}>
              {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </Field>
        </div>

        {error && <div role="alert" style={{ color: '#a32a25' }}>{error}</div>}

        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button type="submit" disabled={busy}>{busy ? 'Submitting…' : 'Submit'}</button>
          <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
        </div>
      </form>
    </Card>
  );
}

function RequestDetail({ request, canChangeStatus, onBack, onChanged }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const act = async (fn) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await fn(); onChanged(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const setStatus = (status) =>
    act(() => api(`/${request.change_request_id}`, { method: 'PATCH', body: JSON.stringify({ status }) }));

  const addNote = () => {
    if (!note.trim()) return;
    return act(async () => {
      await api(`/${request.change_request_id}/notes`, {
        method: 'POST', body: JSON.stringify({ body: note.trim() }),
      });
      setNote('');
    });
  };

  return (
    <Card title={request.title}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
        <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" onClick={onBack}>← Back</button>
          <StatusPill value={request.status} />
          <span style={{ fontSize: '0.85rem', color: 'var(--text-muted, #6b7688)' }}>
            {labelOf(TYPES, request.request_type)} · {labelOf(PRIORITIES, request.priority)} priority ·
            {' '}{request.app}{request.page ? ` · ${request.page}` : ''}
          </span>
        </div>

        <div style={{ fontSize: '0.85rem', color: 'var(--text-muted, #6b7688)' }}>
          Raised by {request.requester_name || request.requester_email} on {when(request.created_at)}
        </div>

        <div style={{ whiteSpace: 'pre-wrap' }}>{request.description}</div>
        {request.desired_result && (
          <div>
            <SectionLabel>Desired result</SectionLabel>
            <div style={{ whiteSpace: 'pre-wrap' }}>{request.desired_result}</div>
          </div>
        )}

        {/* Only the development team sees these. The API enforces it independently —
            hiding a control is a courtesy, not a permission. */}
        {canChangeStatus && (
          <div>
            <SectionLabel>Set status</SectionLabel>
            <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
              {STATUSES.map((s) => (
                <button key={s.value} type="button" disabled={busy || s.value === request.status}
                  onClick={() => setStatus(s.value)}>{s.label}</button>
              ))}
            </div>
          </div>
        )}

        {request.files?.length > 0 && (
          <div>
            <SectionLabel>Attachments</SectionLabel>
            <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
              {request.files.map((f) => (
                <li key={f.change_request_file_id}>
                  <a href={`/api/change-requests/${request.change_request_id}/files/${f.change_request_file_id}`}>
                    {f.filename}
                  </a>
                  <span style={{ color: 'var(--text-muted, #6b7688)', fontSize: '0.82rem' }}>
                    {' '}· {f.file_role.replace('_', ' ')} · {Math.round(f.size_bytes / 1024)} KB
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div>
          <SectionLabel>Notes</SectionLabel>
          <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.6rem' }}>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
              style={{ flex: 1 }} placeholder="Add a note" />
            <button type="button" onClick={addNote} disabled={busy || !note.trim()}>Add</button>
          </div>
          {request.notes?.length === 0 && (
            <p style={{ margin: 0, color: 'var(--text-muted, #6b7688)' }}>No notes yet.</p>
          )}
          {request.notes?.map((n) => (
            <div key={n.change_request_note_id} style={{
              borderLeft: '3px solid var(--border, #d8dbe0)', paddingLeft: '0.6rem', marginBottom: '0.5rem',
            }}>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted, #6b7688)' }}>
                {n.author_name || n.author_email} · {when(n.created_at)}
                {n.note_type === 'status_change' && ' · status change'}
              </div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div>
            </div>
          ))}
        </div>

        {error && <div role="alert" style={{ color: '#a32a25' }}>{error}</div>}
      </div>
    </Card>
  );
}
