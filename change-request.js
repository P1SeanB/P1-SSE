// paste-test line 1
// paste-test line 2
/* =====================================================================
 * P1 Change Request & Suggestion Log — drop-in widget
 * ---------------------------------------------------------------------
 * Add one line to any P1 app, after the supabase-js script tag:
 *
 *   <script src="https://<your-user>.github.io/<repo>/change-request.js"></script>
 *
 * Then either let it add its own header button (default), or wire your
 * own Data/Tools menu item to:
 *
 *   onclick="P1CR.open()"
 *
 * Optional per-app settings — set BEFORE this script loads:
 *
 *   <script>
 *     window.P1CR_CONFIG = {
 *       app: 'P1-SSE',                       // shown on every request
 *       page: function(){ return 'Quote Builder'; },
 *       autoButton: true,                    // false = you place your own
 *       mount: 'header .header-right'        // where the button goes
 *     };
 *   </script>
 *
 * Optional export handoff — define anywhere in the app:
 *
 *   window.getCurrentExport = function(){
 *     return { blob: <Blob>, filename: 'x.p1est',
 *              mimeType: 'application/json', generatedAt: new Date().toISOString() };
 *   };
 *
 * Requires: @supabase/supabase-js v2 already on the page, and the user
 * already signed in to the host app (it reuses that session).
 * ===================================================================== */
(function () {
  'use strict';

  if (window.P1CR) return; // already loaded

  // ── Config ─────────────────────────────────────────────────────────
  var CFG = window.P1CR_CONFIG || {};
  var SUPA_URL = CFG.url || 'https://xiykhxpuapzaddkbeboz.supabase.co';
  var SUPA_KEY = CFG.key || 'sb_publishable_omA3WyIF1xRZHmCDf-hYAA_f5SXimU9';
  var BUCKET   = 'change-requests';
  var MAX_FILE = 25 * 1024 * 1024; // 25 MB, matches the bucket limit

  var APP_NAME = CFG.app || (document.title || 'App').split('—')[0].trim() || 'App';

  var TYPES = [
    ['change',     'Change'],
    ['suggestion', 'Suggestion'],
    ['bug',        'Bug']
  ];
  var PRIORITIES = [
    ['low',    'Low'],
    ['normal', 'Normal'],
    ['high',   'High']
  ];
  var STATUSES = [
    ['open',        'Open',        '#1954b0', '#e8effd'],
    ['in_progress', 'In Progress', '#8a5a00', '#fef3da'],
    ['done',        'Done',        '#1a6b4a', '#e8f5ef'],
    ['wont_do',     "Won't Do",    '#6b6b6b', '#eeeeee']
  ];

  function labelOf(list, v) {
    for (var i = 0; i < list.length; i++) if (list[i][0] === v) return list[i][1];
    return v;
  }
  function statusMeta(v) {
    for (var i = 0; i < STATUSES.length; i++) if (STATUSES[i][0] === v) return STATUSES[i];
    return [v, v, '#6b6b6b', '#eeeeee'];
  }

  // ── State ──────────────────────────────────────────────────────────
  var sb = null;
  var me = null;          // { id, email, display_name, is_developer }
  var view = 'list';      // list | form | detail
  var rows = [];
  var current = null;     // open request
  var pending = [];       // files staged on the form: {file, role, name, size, url}
  var filters = { q: '', status: '', app: '', type: '' };
  var showClosed = false;
  var busy = false;

  // ── Helpers ────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d)) return '—';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) +
           '  ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function fmtSize(n) {
    if (n == null) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function safeName(name) {
    return String(name || 'file')
      .replace(/[^a-zA-Z0-9._-]/g, '-')
      .replace(/-+/g, '-')
      .slice(-120);
  }

  function el(id) { return document.getElementById(id); }

  function toast(msg, bad) {
    var t = el('p1cr-toast');
    if (!t) return;
    t.textContent = msg;
    t.style.background = bad ? '#8a1f1f' : '#1c1c1c';
    t.style.opacity = '1';
    t.style.transform = 'translateX(-50%) translateY(0)';
    clearTimeout(t._h);
    t._h = setTimeout(function () {
      t.style.opacity = '0';
      t.style.transform = 'translateX(-50%) translateY(8px)';
    }, 3200);
  }

  function currentPage() {
    try {
      if (typeof CFG.page === 'function') return CFG.page() || null;
      if (typeof CFG.page === 'string') return CFG.page;
      // Best guess: an active tab in the header.
      var a = document.querySelector('header .view-tab.active, .view-toggle .active, [role="tab"][aria-selected="true"]');
      if (a && a.textContent.trim()) return a.textContent.trim();
    } catch (e) {}
    return null;
  }

  // ── Styles ─────────────────────────────────────────────────────────
  var CSS = [
    '#p1cr-root{position:fixed;inset:0;z-index:99999;display:none;font-family:"DM Sans",system-ui,-apple-system,Segoe UI,sans-serif;font-size:14px;color:#1c1c1c;line-height:1.5;}',
    '#p1cr-root.on{display:block;}',
    '#p1cr-scrim{position:absolute;inset:0;background:rgba(0,0,0,.45);}',
    '#p1cr-panel{position:absolute;top:3vh;left:50%;transform:translateX(-50%);width:min(1120px,94vw);height:94vh;background:#fff;border-radius:12px;box-shadow:0 24px 60px rgba(0,0,0,.35);display:flex;flex-direction:column;overflow:hidden;}',
    '#p1cr-head{background:#1c1c1c;color:#fff;border-bottom:3px solid #e8620a;padding:0 18px;height:54px;display:flex;align-items:center;gap:12px;flex:0 0 auto;}',
    '#p1cr-head h2{font-size:14px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;margin:0;}',
    '#p1cr-head .sp{flex:1 1 auto;}',
    '#p1cr-body{flex:1 1 auto;overflow:auto;padding:18px;background:#f4f4f4;}',
    // Defensive resets — host apps style bare label/input/button/h3 tags.
    '#p1cr-root label{display:inline;margin:0;padding:0;font:inherit;font-size:inherit;font-weight:inherit;letter-spacing:normal;text-transform:none;color:inherit;}',
    '#p1cr-root input,#p1cr-root select,#p1cr-root textarea,#p1cr-root button{margin:0;font-family:inherit;}',
    '#p1cr-root input[type=checkbox]{width:auto;height:auto;margin:0;padding:0;}',
    '#p1cr-root h2,#p1cr-root h3{font-family:inherit;}',
    '.p1cr-lbl{display:block;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#555;margin:0 0 5px;}',
    '.p1cr-btn{font:inherit;font-size:12px;font-weight:600;border-radius:6px;padding:7px 13px;cursor:pointer;border:1px solid transparent;white-space:nowrap;}',
    '.p1cr-btn:disabled{opacity:.5;cursor:default;}',
    '.p1cr-primary{background:#e8620a;color:#fff;}',
    '.p1cr-primary:hover:not(:disabled){background:#cf5709;}',
    '.p1cr-ghost{background:rgba(255,255,255,.16);color:#fff;border-color:rgba(255,255,255,.2);}',
    '.p1cr-ghost:hover{background:rgba(255,255,255,.26);}',
    '.p1cr-quiet{background:#fff;color:#1c1c1c;border-color:#cccccc;}',
    '.p1cr-quiet:hover:not(:disabled){background:#f4f4f4;}',
    '.p1cr-card{background:#fff;border:1px solid #e0e0e0;border-radius:10px;padding:16px;margin-bottom:14px;}',
    '.p1cr-card h3{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#6b6b6b;margin:0 0 12px;}',
    '.p1cr-in,.p1cr-ta,.p1cr-sel{width:100%;font:inherit;font-size:13px;padding:8px 10px;border:1px solid #cccccc;border-radius:6px;background:#fff;color:#1c1c1c;}',
    '.p1cr-in:focus,.p1cr-ta:focus,.p1cr-sel:focus{outline:2px solid #e8620a;outline-offset:-1px;border-color:#e8620a;}',
    '.p1cr-ta{resize:vertical;min-height:72px;}',
    '.p1cr-row{display:flex;gap:12px;flex-wrap:wrap;}',
    '.p1cr-row>*{flex:1 1 180px;min-width:0;}',
    '.p1cr-fld{margin-bottom:14px;}',
    '.p1cr-req{color:#8a1f1f;}',
    '.p1cr-drop{border:2px dashed #cccccc;border-radius:8px;padding:18px;text-align:center;color:#6b6b6b;font-size:12px;cursor:pointer;background:#fafafa;}',
    '.p1cr-drop.hot{border-color:#e8620a;background:#fff0e8;color:#e8620a;}',
    '.p1cr-thumbs{display:flex;flex-wrap:wrap;gap:10px;margin-top:12px;}',
    '.p1cr-thumb{position:relative;width:104px;border:1px solid #e0e0e0;border-radius:8px;overflow:hidden;background:#fff;}',
    '.p1cr-thumb img{width:100%;height:70px;object-fit:cover;display:block;cursor:zoom-in;}',
    '.p1cr-thumb .nm{font-size:9px;color:#6b6b6b;padding:4px 5px;word-break:break-all;line-height:1.3;max-height:32px;overflow:hidden;}',
    '.p1cr-x{position:absolute;top:3px;right:3px;width:19px;height:19px;border-radius:50%;border:none;background:rgba(0,0,0,.66);color:#fff;font-size:12px;line-height:19px;padding:0;cursor:pointer;}',
    '.p1cr-file{display:flex;align-items:center;gap:10px;border:1px solid #e0e0e0;border-radius:8px;padding:9px 12px;margin-bottom:8px;background:#fff;}',
    '.p1cr-file .fn{flex:1 1 auto;min-width:0;font-size:12px;word-break:break-all;}',
    '.p1cr-file .mt{font-size:10px;color:#6b6b6b;}',
    '.p1cr-tag{display:inline-block;font-size:9px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:2px 6px;border-radius:4px;background:#eaeaea;color:#555;}',
    '.p1cr-tag.fx{background:#e8f5ef;color:#1a6b4a;}',
    '.p1cr-tag.og{background:#e8effd;color:#1954b0;}',
    'table.p1cr-tbl{width:100%;border-collapse:collapse;background:#fff;}',
    'table.p1cr-tbl th{font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#6b6b6b;text-align:left;padding:9px 10px;border-bottom:1px solid #e0e0e0;background:#fafafa;position:sticky;top:0;}',
    'table.p1cr-tbl td{padding:10px;border-bottom:1px solid #f0f0f0;font-size:12.5px;vertical-align:top;}',
    'table.p1cr-tbl tr.rw{cursor:pointer;}',
    'table.p1cr-tbl tr.rw:hover td{background:#fff7f2;}',
    '.p1cr-ref{font-family:"DM Mono",ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:#6b6b6b;white-space:nowrap;}',
    '.p1cr-chip{display:inline-block;font-size:10px;font-weight:700;padding:3px 8px;border-radius:11px;white-space:nowrap;}',
    '.p1cr-tl{border-left:2px solid #e0e0e0;margin-left:6px;padding-left:16px;}',
    '.p1cr-ev{position:relative;padding-bottom:16px;}',
    '.p1cr-ev:last-child{padding-bottom:0;}',
    '.p1cr-ev:before{content:"";position:absolute;left:-21px;top:5px;width:8px;height:8px;border-radius:50%;background:#cccccc;border:2px solid #fff;}',
    '.p1cr-ev.note:before{background:#e8620a;}',
    '.p1cr-ev .wh{font-size:10.5px;color:#6b6b6b;font-family:"DM Mono",ui-monospace,monospace;}',
    '.p1cr-ev .who{font-size:11px;font-weight:700;color:#1c1c1c;}',
    '.p1cr-ev .bd{font-size:12.5px;margin-top:2px;white-space:pre-wrap;word-break:break-word;}',
    '.p1cr-ev.sys .bd{color:#555;font-style:italic;}',
    '.p1cr-empty{text-align:center;color:#6b6b6b;font-size:13px;padding:40px 20px;}',
    '#p1cr-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%) translateY(8px);background:#1c1c1c;color:#fff;font-size:12.5px;padding:10px 18px;border-radius:8px;z-index:100001;opacity:0;transition:opacity .2s,transform .2s;pointer-events:none;max-width:80vw;text-align:center;}',
    '#p1cr-light{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.85);display:none;align-items:center;justify-content:center;padding:24px;cursor:zoom-out;}',
    '#p1cr-light.on{display:flex;}',
    '#p1cr-light img{max-width:100%;max-height:100%;border-radius:6px;}',
    '.p1cr-bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px;}',
    '.p1cr-bar .p1cr-in,.p1cr-bar .p1cr-sel{width:auto;font-size:12px;padding:6px 9px;}',
    '.p1cr-bar .grow{flex:1 1 220px;}',
    '.p1cr-spin{display:inline-block;width:13px;height:13px;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:p1crspin .7s linear infinite;vertical-align:-2px;margin-right:6px;}',
    '@keyframes p1crspin{to{transform:rotate(360deg);}}',
    '@media(max-width:700px){#p1cr-panel{top:0;height:100vh;width:100vw;border-radius:0;}.p1cr-hide-sm{display:none;}}'
  ].join('\n');

  // ── Shell ──────────────────────────────────────────────────────────
  function buildShell() {
    var s = document.createElement('style');
    s.id = 'p1cr-style';
    s.textContent = CSS;
    document.head.appendChild(s);

    var root = document.createElement('div');
    root.id = 'p1cr-root';
    root.innerHTML =
      '<div id="p1cr-scrim"></div>' +
      '<div id="p1cr-panel" role="dialog" aria-modal="true" aria-label="Change requests">' +
        '<div id="p1cr-head">' +
          '<h2 id="p1cr-title">Change Requests</h2>' +
          '<span class="sp"></span>' +
          '<span id="p1cr-who" style="font-size:11px;color:rgba(255,255,255,.6);" class="p1cr-hide-sm"></span>' +
          '<button class="p1cr-btn p1cr-ghost" id="p1cr-back" style="display:none;">&larr; Back to log</button>' +
          '<button class="p1cr-btn p1cr-primary" id="p1cr-new">+ New Request</button>' +
          '<button class="p1cr-btn p1cr-ghost" id="p1cr-close" aria-label="Close">&#10005;</button>' +
        '</div>' +
        '<div id="p1cr-body"></div>' +
      '</div>';
    document.body.appendChild(root);

    var t = document.createElement('div');
    t.id = 'p1cr-toast';
    document.body.appendChild(t);

    var lb = document.createElement('div');
    lb.id = 'p1cr-light';
    lb.innerHTML = '<img alt="">';
    lb.addEventListener('click', function () { lb.classList.remove('on'); });
    document.body.appendChild(lb);

    el('p1cr-scrim').addEventListener('click', close);
    el('p1cr-close').addEventListener('click', close);
    el('p1cr-new').addEventListener('click', function () { showForm(); });
    el('p1cr-back').addEventListener('click', function () { showList(); });

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (el('p1cr-light').classList.contains('on')) { el('p1cr-light').classList.remove('on'); return; }
      if (el('p1cr-root').classList.contains('on')) close();
    });

    // Paste a snip straight into the open form.
    document.addEventListener('paste', function (e) {
      if (view !== 'form' || !el('p1cr-root').classList.contains('on')) return;
      var items = (e.clipboardData || {}).items || [];
      var got = 0;
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind === 'file' && /^image\//.test(items[i].type)) {
          var f = items[i].getAsFile();
          if (f) { addPending(f, 'screenshot'); got++; }
        }
      }
      if (got) { e.preventDefault(); toast(got + ' snip' + (got > 1 ? 's' : '') + ' pasted'); }
    });
  }

  function lightbox(src) {
    var lb = el('p1cr-light');
    lb.querySelector('img').src = src;
    lb.classList.add('on');
  }

  // ── Launcher button ────────────────────────────────────────────────
  function mountButton() {
    if (CFG.autoButton === false) return;
    if (document.getElementById('p1cr-launch')) return;

    var host = document.querySelector(CFG.mount || 'header .header-right') ||
               document.querySelector('header');
    if (!host) return;

    var b = document.createElement('button');
    b.id = 'p1cr-launch';
    b.type = 'button';
    b.textContent = 'Request a Change';
    b.title = 'Request a change or make a suggestion about this app';
    b.className = host.querySelector('.btn-ghost') ? 'btn-ghost' : '';
    if (!b.className) {
      b.style.cssText = 'font:inherit;font-size:12px;font-weight:600;border-radius:6px;padding:7px 13px;' +
        'cursor:pointer;background:rgba(255,255,255,.18);color:#fff;border:1px solid rgba(255,255,255,.2);white-space:nowrap;';
    } else {
      b.style.background = 'rgba(255,255,255,0.18)';
    }
    b.addEventListener('click', open);
    host.appendChild(b);
  }

  // ── Supabase ───────────────────────────────────────────────────────
  function client() {
    if (sb) return sb;
    if (!window.supabase || !window.supabase.createClient) return null;
    sb = window.supabase.createClient(SUPA_URL, SUPA_KEY);
    return sb;
  }

  function loadMe() {
    var c = client();
    if (!c) return Promise.resolve(null);
    return c.auth.getUser().then(function (r) {
      var u = r && r.data ? r.data.user : null;
      if (!u) { me = null; return null; }
      return c.from('cr_profiles').select('*').eq('id', u.id).maybeSingle().then(function (p) {
        if (p.data) { me = p.data; return me; }
        // First time this user has touched the log — make their profile row.
        var row = {
          id: u.id,
          email: u.email,
          display_name: (u.user_metadata && (u.user_metadata.full_name || u.user_metadata.name)) ||
                        String(u.email || '').split('@')[0]
        };
        return c.from('cr_profiles').insert(row).select().single().then(function (ins) {
          me = ins.data || row;
          return me;
        }).catch(function () { me = row; return me; });
      });
    }).catch(function () { me = null; return null; });
  }

  // ── Views ──────────────────────────────────────────────────────────
  function setHeadButtons() {
    el('p1cr-back').style.display = (view === 'detail' || view === 'form') ? '' : 'none';
    el('p1cr-new').style.display  = (view === 'list') ? '' : 'none';
    el('p1cr-title').textContent  =
      view === 'form'   ? 'New Request' :
      view === 'detail' ? (current ? current.ref : 'Request') :
                          'Change Requests';
    el('p1cr-who').textContent = me ? (me.display_name || me.email) + (me.is_developer ? ' · developer' : '') : '';
  }

  function signInPrompt() {
    view = 'list';
    setHeadButtons();
    el('p1cr-new').style.display = 'none';
    el('p1cr-body').innerHTML =
      '<div class="p1cr-empty">You need to be signed in to this app before you can use the change request log.' +
      '<br><br>Close this window, sign in, and open it again.</div>';
  }

  // ---- List ----
  function showList(force) {
    view = 'list';
    current = null;
    setHeadButtons();

    if (!me) { signInPrompt(); return; }

    if (!force && rows.length) { renderList(); return; }

    el('p1cr-body').innerHTML = '<div class="p1cr-empty">Loading…</div>';
    client().from('cr_list_view').select('*').order('created_at', { ascending: false }).limit(500)
      .then(function (r) {
        if (r.error) {
          el('p1cr-body').innerHTML = '<div class="p1cr-empty">Could not load requests.<br><br>' +
            esc(r.error.message) + '</div>';
          return;
        }
        rows = r.data || [];
        renderList();
      });
  }

  function renderList() {
    var apps = [];
    rows.forEach(function (r) { if (apps.indexOf(r.app) < 0) apps.push(r.app); });
    apps.sort();

    var shown = rows.filter(function (r) {
      if (!showClosed && (r.status === 'done' || r.status === 'wont_do')) return false;
      if (filters.status && r.status !== filters.status) return false;
      if (filters.app && r.app !== filters.app) return false;
      if (filters.type && r.request_type !== filters.type) return false;
      if (filters.q) {
        var hay = [r.ref, r.title, r.description, r.desired_result, r.requester_name, r.app, r.page]
          .join(' ').toLowerCase();
        if (hay.indexOf(filters.q.toLowerCase()) < 0) return false;
      }
      return true;
    });

    var h = [];
    h.push('<div class="p1cr-bar">');
    h.push('<input class="p1cr-in grow" id="p1cr-q" placeholder="Search requests…" value="' + esc(filters.q) + '">');
    h.push('<select class="p1cr-sel" id="p1cr-fs"><option value="">Any status</option>' +
      STATUSES.map(function (s) {
        return '<option value="' + s[0] + '"' + (filters.status === s[0] ? ' selected' : '') + '>' + s[1] + '</option>';
      }).join('') + '</select>');
    h.push('<select class="p1cr-sel" id="p1cr-fa"><option value="">Any app</option>' +
      apps.map(function (a) {
        return '<option value="' + esc(a) + '"' + (filters.app === a ? ' selected' : '') + '>' + esc(a) + '</option>';
      }).join('') + '</select>');
    h.push('<select class="p1cr-sel" id="p1cr-ft"><option value="">Any type</option>' +
      TYPES.map(function (t) {
        return '<option value="' + t[0] + '"' + (filters.type === t[0] ? ' selected' : '') + '>' + t[1] + '</option>';
      }).join('') + '</select>');
    h.push('<label style="font-size:12px;display:flex;align-items:center;gap:6px;white-space:nowrap;cursor:pointer;">' +
      '<input type="checkbox" id="p1cr-sc"' + (showClosed ? ' checked' : '') + '> Show closed</label>');
    h.push('<button class="p1cr-btn p1cr-quiet" id="p1cr-refresh">Refresh</button>');
    h.push('</div>');

    if (!shown.length) {
      h.push('<div class="p1cr-card"><div class="p1cr-empty">' +
        (rows.length ? 'No requests match those filters.' :
          'No requests yet. Use <strong>+ New Request</strong> to add the first one.') +
        '</div></div>');
    } else {
      h.push('<div class="p1cr-card" style="padding:0;overflow:hidden;">');
      h.push('<table class="p1cr-tbl"><thead><tr>' +
        '<th>Ref</th><th>Submitted</th><th class="p1cr-hide-sm">App / Page</th><th>Type</th>' +
        '<th>Title</th><th class="p1cr-hide-sm">Requester</th><th>Files</th><th>Status</th>' +
        '<th class="p1cr-hide-sm">Last activity</th></tr></thead><tbody>');
      shown.forEach(function (r) {
        var sm = statusMeta(r.status);
        var files = [];
        if (r.snip_count > 0) files.push('&#9634;' + r.snip_count);
        if (r.file_count > 0) files.push('&#8659;' + r.file_count);
        h.push('<tr class="rw" data-id="' + r.id + '">' +
          '<td class="p1cr-ref">' + esc(r.ref) + '</td>' +
          '<td style="white-space:nowrap;">' + esc(fmtDate(r.created_at)) + '</td>' +
          '<td class="p1cr-hide-sm">' + esc(r.app) + (r.page ? '<div class="mt" style="font-size:10.5px;color:#6b6b6b;">' + esc(r.page) + '</div>' : '') + '</td>' +
          '<td>' + esc(labelOf(TYPES, r.request_type)) + '</td>' +
          '<td><strong>' + esc(r.title) + '</strong>' +
            (r.priority === 'high' ? ' <span class="p1cr-tag" style="background:#fdeaea;color:#8a1f1f;">High</span>' : '') + '</td>' +
          '<td class="p1cr-hide-sm">' + esc(r.requester_name || r.requester_email) + '</td>' +
          '<td style="white-space:nowrap;color:#6b6b6b;font-size:11px;">' + (files.join(' &nbsp;') || '—') + '</td>' +
          '<td><span class="p1cr-chip" style="color:' + sm[2] + ';background:' + sm[3] + ';">' + esc(sm[1]) + '</span></td>' +
          '<td class="p1cr-hide-sm" style="white-space:nowrap;color:#6b6b6b;">' + esc(fmtDate(r.last_activity)) + '</td>' +
          '</tr>');
      });
      h.push('</tbody></table></div>');
      h.push('<div style="font-size:11px;color:#6b6b6b;padding:0 2px 8px;">' + shown.length +
        ' of ' + rows.length + ' request' + (rows.length === 1 ? '' : 's') + '</div>');
    }

    el('p1cr-body').innerHTML = h.join('');

    el('p1cr-q').addEventListener('input', function () { filters.q = this.value; renderList(); focusSearch(); });
    el('p1cr-fs').addEventListener('change', function () { filters.status = this.value; renderList(); });
    el('p1cr-fa').addEventListener('change', function () { filters.app = this.value; renderList(); });
    el('p1cr-ft').addEventListener('change', function () { filters.type = this.value; renderList(); });
    el('p1cr-sc').addEventListener('change', function () { showClosed = this.checked; renderList(); });
    el('p1cr-refresh').addEventListener('click', function () { rows = []; showList(true); });

    Array.prototype.forEach.call(el('p1cr-body').querySelectorAll('tr.rw'), function (tr) {
      tr.addEventListener('click', function () { showDetail(+tr.getAttribute('data-id')); });
    });
  }

  function focusSearch() {
    var q = el('p1cr-q');
    if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
  }

  // ---- Form ----
  function showForm() {
    if (!me) { signInPrompt(); return; }
    view = 'form';
    pending = [];
    setHeadButtons();

    var page = currentPage();

    el('p1cr-body').innerHTML =
      '<div class="p1cr-card">' +
        '<h3>Where this came from</h3>' +
        '<div style="font-size:12.5px;color:#555;">' +
          '<strong>' + esc(APP_NAME) + '</strong>' + (page ? ' &rsaquo; ' + esc(page) : '') +
          '<div style="font-size:11px;color:#6b6b6b;margin-top:3px;word-break:break-all;">' + esc(location.href) + '</div>' +
          '<div style="font-size:11px;color:#6b6b6b;margin-top:3px;">' +
            esc(me.display_name || me.email) + ' &middot; ' + esc(fmtDate(new Date().toISOString())) + '</div>' +
        '</div>' +
      '</div>' +

      '<div class="p1cr-card">' +
        '<h3>Your request</h3>' +
        '<div class="p1cr-row">' +
          '<div class="p1cr-fld"><label class="p1cr-lbl" for="p1cr-type">Type <span class="p1cr-req">*</span></label>' +
            '<select class="p1cr-sel" id="p1cr-type">' +
            TYPES.map(function (t) { return '<option value="' + t[0] + '">' + t[1] + '</option>'; }).join('') +
            '</select></div>' +
          '<div class="p1cr-fld"><label class="p1cr-lbl" for="p1cr-pri">Priority</label>' +
            '<select class="p1cr-sel" id="p1cr-pri">' +
            PRIORITIES.map(function (p) {
              return '<option value="' + p[0] + '"' + (p[0] === 'normal' ? ' selected' : '') + '>' + p[1] + '</option>';
            }).join('') + '</select></div>' +
        '</div>' +
        '<div class="p1cr-fld"><label class="p1cr-lbl" for="p1cr-t">Title <span class="p1cr-req">*</span></label>' +
          '<input class="p1cr-in" id="p1cr-t" maxlength="140" placeholder="One line — what this is about"></div>' +
        '<div class="p1cr-fld"><label class="p1cr-lbl" for="p1cr-d">What is happening / what you are asking for <span class="p1cr-req">*</span></label>' +
          '<textarea class="p1cr-ta" id="p1cr-d" rows="5" placeholder="Describe it the way you would say it out loud."></textarea></div>' +
        '<div class="p1cr-fld" style="margin-bottom:0;"><label class="p1cr-lbl" for="p1cr-w">What you would like it to do instead</label>' +
          '<textarea class="p1cr-ta" id="p1cr-w" rows="3" placeholder="Optional."></textarea></div>' +
      '</div>' +

      '<div class="p1cr-card">' +
        '<h3>Screen snips</h3>' +
        '<div class="p1cr-drop" id="p1cr-snipdrop">' +
          '<strong>Paste a snip with Ctrl+V</strong>, drag images here, or click to browse' +
        '</div>' +
        '<input type="file" id="p1cr-snipin" accept="image/*" multiple style="display:none;">' +
        '<div class="p1cr-thumbs" id="p1cr-snips"></div>' +
      '</div>' +

      '<div class="p1cr-card">' +
        '<h3>Export / attachments</h3>' +
        '<div id="p1cr-exportcard"></div>' +
        '<div class="p1cr-drop" id="p1cr-filedrop" style="margin-top:10px;">Drag a file here, or click to browse</div>' +
        '<input type="file" id="p1cr-filein" multiple style="display:none;">' +
        '<div id="p1cr-files" style="margin-top:12px;"></div>' +
      '</div>' +

      '<div style="display:flex;gap:10px;justify-content:flex-end;padding-bottom:10px;">' +
        '<button class="p1cr-btn p1cr-quiet" id="p1cr-cancel">Cancel</button>' +
        '<button class="p1cr-btn p1cr-primary" id="p1cr-submit">Submit request</button>' +
      '</div>';

    wireDrop('p1cr-snipdrop', 'p1cr-snipin', 'screenshot', true);
    wireDrop('p1cr-filedrop', 'p1cr-filein', 'export', false);
    el('p1cr-cancel').addEventListener('click', function () { showList(); });
    el('p1cr-submit').addEventListener('click', submit);
    el('p1cr-t').focus();

    offerExport();
    renderPending();
  }

  function wireDrop(dropId, inputId, role, imagesOnly) {
    var d = el(dropId), inp = el(inputId);
    d.addEventListener('click', function () { inp.click(); });
    inp.addEventListener('change', function () {
      Array.prototype.forEach.call(inp.files || [], function (f) { addPending(f, role); });
      inp.value = '';
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      d.addEventListener(ev, function (e) { e.preventDefault(); d.classList.add('hot'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      d.addEventListener(ev, function (e) { e.preventDefault(); d.classList.remove('hot'); });
    });
    d.addEventListener('drop', function (e) {
      var fl = (e.dataTransfer || {}).files || [];
      Array.prototype.forEach.call(fl, function (f) {
        if (imagesOnly && !/^image\//.test(f.type)) return;
        addPending(f, role);
      });
    });
  }

  function offerExport() {
    var card = el('p1cr-exportcard');
    if (!card) return;
    var ex = null;
    try { if (typeof window.getCurrentExport === 'function') ex = window.getCurrentExport(); } catch (e) { ex = null; }

    if (!ex || !ex.blob) {
      card.innerHTML = '<div style="font-size:11.5px;color:#6b6b6b;">' +
        'This app is not handing over an export automatically. Drag the file in below if you have one.</div>';
      return;
    }

    var fname = ex.filename || 'export.dat';
    card.innerHTML =
      '<label style="display:flex;gap:10px;align-items:flex-start;border:1px solid #e8620a;background:#fff0e8;' +
      'border-radius:8px;padding:11px 13px;cursor:pointer;">' +
        '<input type="checkbox" id="p1cr-useexport" checked style="margin-top:2px;">' +
        '<span><strong style="font-size:12.5px;">Include the current export</strong>' +
        '<div style="font-size:11.5px;color:#555;word-break:break-all;">' + esc(fname) +
          ' &middot; ' + esc(fmtSize(ex.blob.size)) +
          (ex.generatedAt ? ' &middot; generated ' + esc(fmtDate(ex.generatedAt)) : '') + '</div></span>' +
      '</label>';

    var f = new File([ex.blob], fname, { type: ex.mimeType || ex.blob.type || 'application/octet-stream' });
    f._auto = true;
    addPending(f, 'export');

    el('p1cr-useexport').addEventListener('change', function () {
      if (this.checked) { addPending(f, 'export'); }
      else {
        pending = pending.filter(function (p) { return p.file !== f; });
        renderPending();
      }
    });
  }

  function addPending(file, role) {
    if (!file) return;
    if (file.size > MAX_FILE) { toast(file.name + ' is over 25 MB', true); return; }
    for (var i = 0; i < pending.length; i++) {
      if (pending[i].file === file) return;
      if (pending[i].file.name === file.name && pending[i].file.size === file.size) return;
    }
    var name = file.name || ('snip-' + (pending.length + 1) + '.png');
    pending.push({
      file: file,
      role: role,
      name: name,
      url: /^image\//.test(file.type) ? URL.createObjectURL(file) : null
    });
    renderPending();
  }

  function renderPending() {
    var snips = pending.filter(function (p) { return p.role === 'screenshot'; });
    var files = pending.filter(function (p) { return p.role !== 'screenshot'; });

    var sw = el('p1cr-snips');
    if (sw) {
      sw.innerHTML = snips.map(function (p, i) {
        return '<div class="p1cr-thumb"><img src="' + p.url + '" alt="" data-i="' + i + '">' +
          '<div class="nm">' + esc(p.name) + '</div>' +
          '<button class="p1cr-x" data-rm="' + pending.indexOf(p) + '" title="Remove">&#10005;</button></div>';
      }).join('');
      Array.prototype.forEach.call(sw.querySelectorAll('img'), function (im) {
        im.addEventListener('click', function () { lightbox(im.src); });
      });
    }

    var fw = el('p1cr-files');
    if (fw) {
      fw.innerHTML = files.map(function (p) {
        return '<div class="p1cr-file">' +
          '<span class="p1cr-tag og">Export</span>' +
          '<span class="fn">' + esc(p.name) + '<div class="mt">' + esc(fmtSize(p.file.size)) +
            (p.file._auto ? ' &middot; from the app' : '') + '</div></span>' +
          '<button class="p1cr-x" style="position:static;" data-rm="' + pending.indexOf(p) + '" title="Remove">&#10005;</button>' +
          '</div>';
      }).join('');
    }

    Array.prototype.forEach.call(el('p1cr-body').querySelectorAll('[data-rm]'), function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        var idx = +b.getAttribute('data-rm');
        var p = pending[idx];
        if (p && p.url) URL.revokeObjectURL(p.url);
        pending.splice(idx, 1);
        var chk = el('p1cr-useexport');
        if (p && p.file && p.file._auto && chk) chk.checked = false;
        renderPending();
      });
    });
  }

  function submit() {
    if (busy) return;
    var title = el('p1cr-t').value.trim();
    var desc  = el('p1cr-d').value.trim();
    if (!title) { toast('Give it a title', true); el('p1cr-t').focus(); return; }
    if (!desc)  { toast('Describe what you are asking for', true); el('p1cr-d').focus(); return; }

    busy = true;
    var btn = el('p1cr-submit');
    btn.disabled = true;
    btn.innerHTML = '<span class="p1cr-spin"></span>Submitting…';

    var c = client();
    var row = {
      app: APP_NAME,
      page: currentPage(),
      url: location.href.slice(0, 1000),
      request_type: el('p1cr-type').value,
      priority: el('p1cr-pri').value,
      title: title,
      description: desc,
      desired_result: el('p1cr-w').value.trim() || null,
      requester_id: me.id
    };

    c.from('cr_requests').insert(row).select('id').single().then(function (r) {
      if (r.error) throw r.error;
      return uploadAll(r.data.id).then(function (failed) {
        return { id: r.data.id, failed: failed };
      });
    }).then(function (res) {
      busy = false;
      rows = [];
      if (res.failed.length) {
        toast('Request saved, but ' + res.failed.length + ' file(s) did not upload', true);
      } else {
        toast('Request submitted');
      }
      pending.forEach(function (p) { if (p.url) URL.revokeObjectURL(p.url); });
      pending = [];
      showDetail(res.id, true);
    }).catch(function (err) {
      busy = false;
      btn.disabled = false;
      btn.textContent = 'Submit request';
      toast('Could not submit: ' + (err && err.message ? err.message : 'unknown error'), true);
    });
  }

  function uploadAll(requestId) {
    var c = client();
    var failed = [];
    var chain = Promise.resolve();

    pending.forEach(function (p, i) {
      chain = chain.then(function () {
        var path = requestId + '/' + Date.now() + '-' + i + '-' + safeName(p.name);
        return c.storage.from(BUCKET).upload(path, p.file, {
          contentType: p.file.type || 'application/octet-stream',
          upsert: false
        }).then(function (up) {
          if (up.error) { failed.push(p.name); return; }
          return c.from('cr_files').insert({
            request_id: requestId,
            file_role: p.role,
            storage_path: path,
            filename: p.name,
            mime_type: p.file.type || null,
            size_bytes: p.file.size,
            uploaded_by: me.id
          }).then(function (ins) { if (ins.error) failed.push(p.name); });
        }).catch(function () { failed.push(p.name); });
      });
    });

    return chain.then(function () { return failed; });
  }

  // ---- Detail ----
  function showDetail(id, fresh) {
    view = 'detail';
    setHeadButtons();
    el('p1cr-body').innerHTML = '<div class="p1cr-empty">Loading…</div>';

    var c = client();
    Promise.all([
      c.from('cr_list_view').select('*').eq('id', id).single(),
      c.from('cr_files').select('*').eq('request_id', id).order('uploaded_at', { ascending: true }),
      c.from('cr_notes_view').select('*').eq('request_id', id).order('created_at', { ascending: false })
    ]).then(function (res) {
      if (res[0].error) {
        el('p1cr-body').innerHTML = '<div class="p1cr-empty">Could not load that request.<br><br>' +
          esc(res[0].error.message) + '</div>';
        return;
      }
      current = res[0].data;
      setHeadButtons();
      renderDetail(current, res[1].data || [], res[2].data || [], fresh);
    });
  }

  function renderDetail(r, files, notes, fresh) {
    var sm = statusMeta(r.status);
    var snips = files.filter(function (f) { return f.file_role === 'screenshot'; });
    var docs  = files.filter(function (f) { return f.file_role !== 'screenshot'; });
    var mine  = me && r.requester_id === me.id;
    var dev   = me && me.is_developer;

    var h = [];

    if (fresh) {
      h.push('<div style="background:#e8f5ef;border:1px solid #1a6b4a;color:#1a6b4a;border-radius:8px;' +
        'padding:10px 14px;font-size:12.5px;margin-bottom:14px;">' +
        'Submitted as <strong>' + esc(r.ref) + '</strong>. The developer can see it now.</div>');
    }

    // Summary
    h.push('<div class="p1cr-card">');
    h.push('<div style="display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;">');
    h.push('<div style="flex:1 1 300px;min-width:0;">' +
      '<div class="p1cr-ref">' + esc(r.ref) + ' &middot; ' + esc(labelOf(TYPES, r.request_type)) +
      ' &middot; ' + esc(labelOf(PRIORITIES, r.priority)) + ' priority</div>' +
      '<div style="font-size:17px;font-weight:600;margin:3px 0 6px;word-break:break-word;">' + esc(r.title) + '</div>' +
      '<div style="font-size:11.5px;color:#6b6b6b;">' +
        esc(r.app) + (r.page ? ' &rsaquo; ' + esc(r.page) : '') +
        ' &middot; submitted by ' + esc(r.requester_name || r.requester_email) +
        ' &middot; ' + esc(fmtDate(r.created_at)) +
        (r.completed_at ? ' &middot; completed ' + esc(fmtDate(r.completed_at)) : '') +
      '</div></div>');

    h.push('<div style="flex:0 0 auto;text-align:right;">');
    if (dev) {
      h.push('<label class="p1cr-lbl" for="p1cr-st">Status</label>' +
        '<select class="p1cr-sel" id="p1cr-st" style="width:auto;min-width:150px;">' +
        STATUSES.map(function (s) {
          return '<option value="' + s[0] + '"' + (r.status === s[0] ? ' selected' : '') + '>' + s[1] + '</option>';
        }).join('') + '</select>');
    } else {
      h.push('<span class="p1cr-chip" style="color:' + sm[2] + ';background:' + sm[3] + ';font-size:11.5px;padding:5px 12px;">' +
        esc(sm[1]) + '</span>');
    }
    h.push('</div></div>');

    h.push('<div style="margin-top:14px;padding-top:14px;border-top:1px solid #f0f0f0;">');
    h.push('<div class="p1cr-lbl">What is happening / what is being asked for</div>' +
      '<div style="white-space:pre-wrap;font-size:13px;word-break:break-word;">' + esc(r.description) + '</div>');
    if (r.desired_result) {
      h.push('<div class="p1cr-lbl" style="margin-top:12px;">Desired result</div>' +
        '<div style="white-space:pre-wrap;font-size:13px;word-break:break-word;">' + esc(r.desired_result) + '</div>');
    }
    if (r.url) {
      h.push('<div class="p1cr-lbl" style="margin-top:12px;">Page</div>' +
        '<div style="font-size:11.5px;color:#6b6b6b;word-break:break-all;">' + esc(r.url) + '</div>');
    }
    h.push('</div></div>');

    // Evidence
    h.push('<div class="p1cr-card"><h3>Screen snips &amp; files</h3>');
    if (!snips.length && !docs.length) {
      h.push('<div style="font-size:12px;color:#6b6b6b;">Nothing was attached to this request.</div>');
    }
    if (snips.length) {
      h.push('<div class="p1cr-thumbs" id="p1cr-dsnips">' + snips.map(function (f) {
        return '<div class="p1cr-thumb"><img data-path="' + esc(f.storage_path) + '" alt="' + esc(f.filename) + '">' +
          '<div class="nm">' + esc(f.filename) + '</div></div>';
      }).join('') + '</div>');
    }
    if (docs.length) {
      h.push('<div style="margin-top:' + (snips.length ? '14px' : '0') + ';">' + docs.map(function (f) {
        var fixed = f.file_role === 'fixed_export';
        return '<div class="p1cr-file">' +
          '<span class="p1cr-tag ' + (fixed ? 'fx' : 'og') + '">' + (fixed ? 'Fixed export' : 'Original export') + '</span>' +
          '<span class="fn">' + esc(f.filename) +
            '<div class="mt">' + esc(fmtSize(f.size_bytes)) + ' &middot; ' + esc(fmtDate(f.uploaded_at)) + '</div></span>' +
          '<button class="p1cr-btn p1cr-quiet" data-dl="' + esc(f.storage_path) + '" data-fn="' + esc(f.filename) + '">Download</button>' +
          '</div>';
      }).join('') + '</div>');
    }
    if (dev) {
      h.push('<div style="margin-top:12px;padding-top:12px;border-top:1px solid #f0f0f0;">' +
        '<button class="p1cr-btn p1cr-quiet" id="p1cr-addfixed">Attach fixed export</button>' +
        '<input type="file" id="p1cr-fixedin" style="display:none;">' +
        '<span style="font-size:11px;color:#6b6b6b;margin-left:10px;">' +
        'Adds the corrected file next to the original.</span></div>');
    }
    h.push('</div>');

    // Timeline
    h.push('<div class="p1cr-card"><h3>History</h3>');
    h.push('<div style="margin-bottom:16px;">' +
      '<textarea class="p1cr-ta" id="p1cr-note" rows="3" placeholder="' +
      (dev ? 'Note what you changed or fixed — it is stamped with the date, time, and your name.'
           : 'Add a note for the developer.') + '"></textarea>' +
      '<div style="display:flex;justify-content:flex-end;margin-top:8px;">' +
      '<button class="p1cr-btn p1cr-primary" id="p1cr-addnote">Add note</button></div></div>');

    h.push('<div class="p1cr-tl">');
    notes.forEach(function (n) {
      var sys = n.note_type !== 'note';
      h.push('<div class="p1cr-ev ' + (sys ? 'sys' : 'note') + '">' +
        '<div class="wh">' + esc(fmtDate(n.created_at)) + '</div>' +
        '<div class="who">' + esc(n.author_name || n.author_email) + '</div>' +
        '<div class="bd">' + esc(n.body) + '</div></div>');
    });
    h.push('</div></div>');

    if (mine && r.status === 'open') {
      h.push('<div style="font-size:11px;color:#6b6b6b;padding-bottom:10px;">' +
        'This is your request and it is still Open, so you can add notes to correct or add to it. ' +
        'The original text stays as submitted.</div>');
    }

    el('p1cr-body').innerHTML = h.join('');
    el('p1cr-body').scrollTop = 0;

    // Signed URLs for the snips
    if (snips.length) {
      var c = client();
      Array.prototype.forEach.call(el('p1cr-body').querySelectorAll('#p1cr-dsnips img'), function (im) {
        var path = im.getAttribute('data-path');
        c.storage.from(BUCKET).createSignedUrl(path, 3600).then(function (s) {
          if (s.data && s.data.signedUrl) {
            im.src = s.data.signedUrl;
            im.addEventListener('click', function () { lightbox(s.data.signedUrl); });
          }
        });
      });
    }

    // Downloads
    Array.prototype.forEach.call(el('p1cr-body').querySelectorAll('[data-dl]'), function (b) {
      b.addEventListener('click', function () { download(b.getAttribute('data-dl'), b.getAttribute('data-fn'), b); });
    });

    if (dev) {
      el('p1cr-st').addEventListener('change', function () { setStatus(r.id, this.value); });
      el('p1cr-addfixed').addEventListener('click', function () { el('p1cr-fixedin').click(); });
      el('p1cr-fixedin').addEventListener('change', function () {
        var f = (this.files || [])[0];
        this.value = '';
        if (f) attachFixed(r.id, f);
      });
    }
    el('p1cr-addnote').addEventListener('click', function () { addNote(r.id); });
  }

  function download(path, filename, btn) {
    var old = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Preparing…'; }
    client().storage.from(BUCKET).createSignedUrl(path, 60, { download: filename }).then(function (s) {
      if (btn) { btn.disabled = false; btn.textContent = old; }
      if (s.error || !s.data) { toast('Could not prepare that download', true); return; }
      var a = document.createElement('a');
      a.href = s.data.signedUrl;
      a.download = filename || '';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { document.body.removeChild(a); }, 300);
    }).catch(function () {
      if (btn) { btn.disabled = false; btn.textContent = old; }
      toast('Could not prepare that download', true);
    });
  }

  function setStatus(id, status) {
    var sel = el('p1cr-st');
    if (sel) sel.disabled = true;
    client().from('cr_requests').update({ status: status }).eq('id', id).then(function (r) {
      if (sel) sel.disabled = false;
      if (r.error) { toast('Could not change status: ' + r.error.message, true); return; }
      rows = [];
      toast('Status updated');
      showDetail(id);
    });
  }

  function addNote(id) {
    var ta = el('p1cr-note');
    var body = (ta.value || '').trim();
    if (!body) { ta.focus(); return; }
    var btn = el('p1cr-addnote');
    btn.disabled = true;
    btn.innerHTML = '<span class="p1cr-spin"></span>Saving…';
    client().from('cr_notes').insert({ request_id: id, body: body, author_id: me.id, note_type: 'note' })
      .then(function (r) {
        btn.disabled = false;
        btn.textContent = 'Add note';
        if (r.error) { toast('Could not add the note: ' + r.error.message, true); return; }
        rows = [];
        showDetail(id);
        toast('Note added');
      });
  }

  function attachFixed(id, file) {
    if (file.size > MAX_FILE) { toast('That file is over 25 MB', true); return; }
    var btn = el('p1cr-addfixed');
    btn.disabled = true;
    btn.innerHTML = '<span class="p1cr-spin"></span>Uploading…';
    var c = client();
    var path = id + '/fixed-' + Date.now() + '-' + safeName(file.name);
    c.storage.from(BUCKET).upload(path, file, {
      contentType: file.type || 'application/octet-stream', upsert: false
    }).then(function (up) {
      if (up.error) throw up.error;
      return c.from('cr_files').insert({
        request_id: id, file_role: 'fixed_export', storage_path: path,
        filename: file.name, mime_type: file.type || null,
        size_bytes: file.size, uploaded_by: me.id
      });
    }).then(function (ins) {
      if (ins && ins.error) throw ins.error;
      return c.from('cr_notes').insert({
        request_id: id, note_type: 'note', author_id: me.id,
        body: 'Fixed export attached: ' + file.name
      });
    }).then(function () {
      rows = [];
      toast('Fixed export attached');
      showDetail(id);
    }).catch(function (err) {
      btn.disabled = false;
      btn.textContent = 'Attach fixed export';
      toast('Upload failed: ' + (err && err.message ? err.message : 'unknown error'), true);
    });
  }

  // ── Open / close ───────────────────────────────────────────────────
  function open(opts) {
    if (!document.getElementById('p1cr-root')) buildShell();
    el('p1cr-root').classList.add('on');
    document.documentElement.style.overflow = 'hidden';

    if (!client()) {
      el('p1cr-body').innerHTML = '<div class="p1cr-empty">The Supabase library did not load, ' +
        'so the change request log is unavailable. Reload the page and try again.</div>';
      return;
    }

    loadMe().then(function (u) {
      if (!u) { signInPrompt(); return; }
      if (opts && opts.newRequest) showForm();
      else showList(true);
    });
  }

  function close() {
    var root = el('p1cr-root');
    if (root) root.classList.remove('on');
    document.documentElement.style.overflow = '';
    pending.forEach(function (p) { if (p.url) URL.revokeObjectURL(p.url); });
    pending = [];
  }

  // ── Boot ───────────────────────────────────────────────────────────
  function boot() {
    buildShell();
    mountButton();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.P1CR = {
    open: open,
    close: close,
    newRequest: function () { open({ newRequest: true }); },
    mountButton: mountButton,
    version: '1.0.0'
  };
})();
