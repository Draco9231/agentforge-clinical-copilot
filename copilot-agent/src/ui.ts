export function renderChatPage(openemrBaseUrl: string, apiSite: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Clinical Co-Pilot</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0; background: #f4f5f9; color: #1a1a2e; }
  .page-wrap { max-width: 1100px; margin: 0 auto; padding: 1.5rem 1rem 2rem; }
  .topbar .brand { font-size: 1.3rem; font-weight: 600; }
  .topbar .tagline { color: #666; font-size: 0.85rem; margin-top: 0.15rem; }

  .login-card { border: 1px solid #ddd; border-radius: 10px; padding: 1.25rem; margin: 2rem auto 0; max-width: 420px; background: #fff; }
  .login-card button { width: 100%; }

  button { cursor: pointer; background: #2b5fd9; color: white; border: none; border-radius: 6px; padding: 0.55rem 0.9rem; font-size: 0.95rem; }
  button:disabled { opacity: 0.6; cursor: default; }
  .btn-ghost { background: transparent; color: #555; border: 1px solid #ddd; padding: 0.3rem 0.7rem; font-size: 0.8rem; }
  textarea { font-size: 0.95rem; }
  .error-text { color: #b00020; font-size: 0.85rem; margin-top: 0.6rem; }
  .hint { color: #777; font-size: 0.85rem; }

  #app { display: none; gap: 1rem; height: calc(100vh - 8rem); min-height: 420px; margin-top: 1.25rem; }

  .sidebar { width: 260px; flex-shrink: 0; background: #fff; border: 1px solid #e3e3ea; border-radius: 10px; display: flex; flex-direction: column; overflow: hidden; }
  .sidebar-head { display: flex; align-items: center; justify-content: space-between; padding: 0.75rem 0.9rem; border-bottom: 1px solid #eee; font-weight: 600; font-size: 0.9rem; }
  .patient-list { overflow-y: auto; flex: 1; }
  .patient-item { display: flex; gap: 0.6rem; align-items: center; padding: 0.65rem 0.9rem; cursor: pointer; border-bottom: 1px solid #f2f2f5; border-left: 3px solid transparent; }
  .patient-item:hover { background: #f7f8fc; }
  .patient-item.active { background: #eef1ff; border-left-color: #2b5fd9; }
  .avatar { width: 34px; height: 34px; border-radius: 50%; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 0.8rem; font-weight: 600; flex-shrink: 0; }
  .patient-name { font-size: 0.9rem; font-weight: 600; }
  .patient-sub { font-size: 0.75rem; color: #777; margin-top: 0.1rem; }
  .empty-hint { padding: 0.9rem; color: #777; font-size: 0.85rem; }

  .chat-pane { flex: 1; display: flex; flex-direction: column; background: #fff; border: 1px solid #e3e3ea; border-radius: 10px; overflow: hidden; min-width: 0; }
  .chat-header { padding: 0.85rem 1rem; border-bottom: 1px solid #eee; }
  .chat-header-name { font-weight: 600; }
  .chat-header-sub { font-size: 0.78rem; color: #777; margin-top: 0.1rem; font-family: ui-monospace, monospace; }

  .messages { flex: 1; overflow-y: auto; padding: 1rem; }
  .day-divider { text-align: center; margin: 0.9rem 0; }
  .day-divider span { background: #eef0f6; color: #666; font-size: 0.72rem; padding: 0.2rem 0.6rem; border-radius: 10px; }

  .msg { padding: 0.6rem 0.8rem; border-radius: 10px; margin: 0.5rem 0; white-space: pre-wrap; max-width: 85%; }
  .msg.user { background: #2b5fd9; color: #fff; margin-left: auto; }
  .msg.assistant { background: #f4f4f4; }
  .badge { display: inline-block; font-size: 0.7rem; padding: 0.1rem 0.5rem; border-radius: 10px; margin-left: 0.4rem; }
  .badge.verified { background: #d6f5dd; color: #146c2e; }
  .badge.degraded { background: #fff3cd; color: #8a6300; }
  .cite { font-size: 0.78rem; color: #555; margin-top: 0.35rem; }

  .composer { display: flex; gap: 0.5rem; padding: 0.75rem; border-top: 1px solid #eee; }
  .composer textarea { flex: 1; resize: none; padding: 0.55rem; border: 1px solid #ddd; border-radius: 6px; }
  .composer button { align-self: flex-end; }

  .doc-upload { display: flex; align-items: center; gap: 0.5rem; padding: 0.6rem 1rem; border-bottom: 1px solid #eee; background: #fafbfe; }
  .doc-upload input[type=file] { flex: 1; font-size: 0.8rem; }
  .doc-upload button { flex-shrink: 0; }
  .doc-upload select { padding: 0.35rem; border: 1px solid #ddd; border-radius: 6px; font-size: 0.8rem; }
  .doc-section { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; color: #777; margin: 0.7rem 0 0.2rem; }
  .upload-status { font-size: 0.78rem; color: #777; }

  .msg.document { background: #fff; border: 1px solid #e3e3ea; max-width: 100%; padding: 0.8rem 1rem; }
  .doc-card-title { font-weight: 600; display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  .badge.high { background: #d6f5dd; color: #146c2e; }
  .badge.medium { background: #fff3cd; color: #8a6300; }
  .badge.low { background: #fde2e2; color: #a01818; }
  .doc-fact { display: flex; justify-content: space-between; gap: 0.6rem; padding: 0.35rem 0; border-bottom: 1px dashed #eee; font-size: 0.85rem; }
  .doc-fact:last-child { border-bottom: none; }
  .doc-fact-value.flag-high, .doc-fact-value.flag-low, .doc-fact-value.flag-critical { color: #b00020; font-weight: 600; }
  .doc-fact-value.flag-normal { color: #146c2e; }
  .doc-fact-cite { font-size: 0.72rem; color: #999; }

  @media (max-width: 720px) {
    #app { flex-direction: column; height: auto; }
    .sidebar { width: 100%; max-height: 220px; }
  }
</style>
</head>
<body>
<div class="page-wrap">
<header class="topbar">
  <div class="brand">🩺 Clinical Co-Pilot</div>
  <p class="tagline">Logs in as an OpenEMR user and asks only about that user's authorized patients — OpenEMR's own permissions apply.</p>
</header>

<div id="login" class="login-card">
  <strong>Log in with your OpenEMR account</strong>
  <p class="hint">You'll be taken to OpenEMR's own login page — this app never sees your password.</p>
  <button onclick="location.href='/login'">Log in with OpenEMR</button>
  <div id="loginError" class="error-text"></div>
</div>

<div id="app">
  <aside class="sidebar">
    <div class="sidebar-head">
      <span>Patients</span>
      <button class="btn-ghost" onclick="logout()">Logout</button>
    </div>
    <div id="patientList" class="patient-list"></div>
  </aside>
  <section class="chat-pane">
    <div id="chatHeader" class="chat-header"></div>
    <div class="doc-upload">
      <select id="docTypeSelect"><option value="lab_pdf">Lab PDF</option><option value="intake_form">Intake form</option></select>
      <input type="file" id="labPdfInput" accept="application/pdf" />
      <button id="uploadBtn" onclick="uploadLabPdf()">Upload</button>
      <span id="uploadStatus" class="upload-status"></span>
    </div>
    <div id="messages" class="messages"></div>
    <div class="composer">
      <textarea id="message" rows="2" placeholder="Ask about this patient's meds, conditions, recent labs..." onkeydown="handleComposerKey(event)"></textarea>
      <button id="askBtn" onclick="send()">Ask</button>
    </div>
  </section>
</div>
</div>

<script>
let token = null;
let patients = [];      // [{ id, name, dob }]
let order = [];         // patient ids, most-recently-selected first
let activePatientId = null;
let sessions = {};      // id -> { conversationId, history: [{role, content}], messages: [{role, text, meta, createdAt}], loaded }

// The /callback landing page (after OpenEMR's own login) stores the token here and redirects
// back to '/' — this just needs to notice it's there, not perform the login itself.
(function initFromSession() {
  const stored = sessionStorage.getItem('access_token');
  if (stored) {
    token = stored;
    document.getElementById('login').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    loadPatients();
  }
})();

function logout() {
  sessionStorage.removeItem('access_token');
  token = null;
  patients = []; order = []; sessions = {}; activePatientId = null;
  document.getElementById('patientList').innerHTML = '';
  document.getElementById('messages').innerHTML = '';
  document.getElementById('chatHeader').innerHTML = '';
  document.getElementById('app').style.display = 'none';
  document.getElementById('login').style.display = 'block';
  document.getElementById('loginError').textContent = '';
}

// A 401/403 from OpenEMR (stale token, or a login that granted less access than needed) hits
// the same reset path as an explicit logout — the difference is just the message shown.
function sessionExpired() {
  logout();
  document.getElementById('loginError').textContent = 'Your session expired — please log in again.';
}

// A physician has ~90 seconds between rooms — typing or memorizing a raw FHIR patient ID
// (a UUID) is not something anyone does in that window. This shows a name + DOB picker instead;
// the raw ID is still shown in the chat header for anyone who needs it for debugging or
// cross-referencing, just never something a user has to type or remember.
async function loadPatients() {
  const listEl = document.getElementById('patientList');
  try {
    const res = await fetch('/api/patients', { headers: { Authorization: 'Bearer ' + token } });
    if (res.status === 401) { sessionExpired(); return; }
    if (res.status === 403) {
      listEl.innerHTML = '<div class="empty-hint">Your OpenEMR account is not permitted to view patients.</div>';
      return;
    }
    const bundle = await res.json();
    const entries = (bundle.entry || []).map(function (e) { return e.resource; });
    if (!res.ok) {
      listEl.innerHTML = '<div class="empty-hint">Could not load patients (server error)</div>';
      return;
    }
    if (entries.length === 0) {
      listEl.innerHTML = '<div class="empty-hint">No patients found</div>';
      return;
    }
    patients = entries.map(function (p) {
      const name = p.name && p.name[0] ? [(p.name[0].given || []).join(' '), p.name[0].family].filter(Boolean).join(' ') : 'Unknown';
      return { id: p.id, name: name, dob: p.birthDate || '' };
    });
    order = patients.map(function (p) { return p.id; });
    renderSidebar();
    if (order.length) selectPatient(order[0]);
  } catch (e) {
    listEl.innerHTML = '<div class="empty-hint">Could not load patients</div>';
  }
}

function avatarColor(id) {
  const palette = ['#2b5fd9', '#c2410c', '#0f766e', '#6d28d9', '#be123c', '#0369a1'];
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return palette[hash % palette.length];
}

function initialsOf(name) {
  return (name || '?').split(' ').filter(Boolean).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase();
}

function renderSidebar() {
  const listEl = document.getElementById('patientList');
  listEl.innerHTML = order.map(function (id) {
    const p = patients.find(function (x) { return x.id === id; });
    if (!p) return '';
    const active = id === activePatientId ? ' active' : '';
    const shortId = id.length > 10 ? id.slice(0, 8) + '…' : id;
    return '<div class="patient-item' + active + '" onclick="selectPatient(\\'' + id + '\\')">' +
      '<div class="avatar" style="background:' + avatarColor(id) + '">' + initialsOf(p.name) + '</div>' +
      '<div class="patient-meta">' +
        '<div class="patient-name">' + p.name + '</div>' +
        '<div class="patient-sub">DOB ' + (p.dob || 'unknown') + ' &middot; ID ' + shortId + '</div>' +
      '</div></div>';
  }).join('');
}

function renderChatHeader(id) {
  const p = patients.find(function (x) { return x.id === id; });
  const el = document.getElementById('chatHeader');
  if (!p) { el.innerHTML = ''; return; }
  el.innerHTML = '<div class="chat-header-name">' + p.name + '</div>' +
    '<div class="chat-header-sub">DOB ' + (p.dob || 'unknown') + ' &middot; Patient ID: ' + p.id + '</div>';
}

// Switching patients used to leave every prior patient's messages sitting in the same #messages
// list — confusing and clinically risky (a claim could be misread as being about the wrong
// patient). Each patient now gets its own in-memory session; switching re-renders from that
// session's own message list instead of appending to a shared one.
async function selectPatient(id) {
  activePatientId = id;
  const idx = order.indexOf(id);
  if (idx > 0) { order.splice(idx, 1); order.unshift(id); }
  renderSidebar();
  renderChatHeader(id);
  if (!sessions[id]) sessions[id] = { conversationId: null, history: [], messages: [], loaded: false };
  const session = sessions[id];
  if (!session.loaded) {
    session.loaded = true;
    await loadHistory(id);
  }
  if (activePatientId === id) renderMessages(id);
}

// Every message is already persisted server-side per (user, patient) — this pulls it back so a
// patient's chat picks up where it left off, including across days, instead of starting blank
// every time the page reloads or a different patient is selected first.
async function loadHistory(id) {
  try {
    const res = await fetch('/api/history?patientId=' + encodeURIComponent(id), { headers: { Authorization: 'Bearer ' + token } });
    if (res.status === 401 || res.status === 403) { sessionExpired(); return; }
    if (!res.ok) return;
    const body = await res.json();
    const rows = body.messages || [];
    const session = sessions[id];
    rows.forEach(function (r) {
      session.messages.push({
        role: r.role,
        text: r.content,
        meta: r.verificationStatus ? { verificationStatus: r.verificationStatus } : null,
        createdAt: r.createdAt,
      });
      session.history.push({ role: r.role, content: r.content });
    });
  } catch (e) {
    // Best-effort: an empty/failed history load just means the chat starts blank for this patient.
  }
}

// Same "YYYY-MM-DD HH:MM:SS" UTC shape D1 stores (datetime('now')), so live messages and messages
// reloaded from history group under the same day dividers. Without this, anything created after
// page load had no timestamp and silently appeared under the previous day's divider.
function nowStamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function dayLabel(createdAt) {
  const d = new Date(createdAt.replace(' ', 'T') + 'Z');
  const now = new Date();
  const startOfDay = function (dt) { return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()); };
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
}

function renderMessages(id) {
  const container = document.getElementById('messages');
  container.innerHTML = '';
  const msgs = (sessions[id] && sessions[id].messages) || [];
  let lastLabel = null;
  msgs.forEach(function (m) {
    if (m.createdAt) {
      const label = dayLabel(m.createdAt);
      if (label !== lastLabel) {
        const divider = document.createElement('div');
        divider.className = 'day-divider';
        divider.innerHTML = '<span>' + label + '</span>';
        container.appendChild(divider);
        lastLabel = label;
      }
    }
    addMessageEl(container, m.role, m.text, m.meta);
  });
  container.scrollTop = container.scrollHeight;
}

// Week 2: upload a lab PDF for the active patient and show its extracted, cited results inline
// in the chat as a distinct card — not folded into a chat bubble, since this is structured
// extraction output, not a conversational answer.
async function uploadLabPdf() {
  const id = activePatientId;
  if (!id) return;
  const input = document.getElementById('labPdfInput');
  const file = input.files[0];
  const statusEl = document.getElementById('uploadStatus');
  if (!file) { statusEl.textContent = 'Choose a PDF first.'; return; }

  const btn = document.getElementById('uploadBtn');
  btn.disabled = true;
  statusEl.textContent = 'Extracting…';
  try {
    const form = new FormData();
    form.append('patientId', id);
    form.append('doc_type', document.getElementById('docTypeSelect').value);
    form.append('file', file);
    const res = await fetch('/api/documents/attach_and_extract', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token },
      body: form,
    });
    if (res.status === 401) { sessionExpired(); return; }
    const body = await res.json();
    if (!res.ok) {
      statusEl.textContent = 'Error: ' + (body.error || 'unknown error');
      return;
    }
    statusEl.textContent = '';
    input.value = '';
    const session = sessions[id];
    session.messages.push({ role: 'document', text: file.name, meta: body, createdAt: nowStamp() });
    if (activePatientId === id) renderMessages(id);
  } catch (e) {
    statusEl.textContent = 'Upload failed.';
  } finally {
    btn.disabled = false;
  }
}

function renderDocumentCard(container, fileName, meta) {
  const el = document.createElement('div');
  el.className = 'msg document';
  const confidence = meta.extraction_confidence || 'low';
  const storedNote = meta.openemrUploadOk
    ? '&#10003; stored in OpenEMR'
    : '&#9888; could not confirm OpenEMR storage (see chat)';
  let html = '<div class="doc-card-title">&#128196; ' + fileName +
    ' <span class="badge ' + confidence + '">' + confidence + ' confidence</span></div>' +
    '<div class="hint" style="margin:0.3rem 0 0.6rem">' + storedNote + '</div>';

  function row(label, value, cite) {
    return '<div class="doc-fact"><div>' + label + '</div><div class="doc-fact-value">' + (value || '') +
      '<div class="doc-fact-cite">p.' + cite.page_or_section + ': &ldquo;' + cite.quote_or_value + '&rdquo;</div></div></div>';
  }

  if (meta.doc_type === 'intake_form') {
    if (meta.chief_concern) {
      html += '<div class="doc-section">Chief concern</div>' + row('', meta.chief_concern.text, meta.chief_concern.citation);
    }
    html += '<div class="doc-section">Current medications (patient-reported)</div>';
    (meta.current_medications || []).forEach(function (m) {
      html += row(m.name, [m.dose, m.frequency].filter(Boolean).join(', '), m.citation);
    });
    html += '<div class="doc-section">Allergies</div>';
    (meta.allergies || []).forEach(function (a) { html += row(a.substance, a.reaction ? 'reaction: ' + a.reaction : '', a.citation); });
    html += '<div class="doc-section">Family history</div>';
    (meta.family_history || []).forEach(function (f) { html += row(f.condition, f.relative || '', f.citation); });
    html += '<div class="doc-section">Demographics</div>';
    (meta.demographics || []).forEach(function (d) { html += row(d.field, d.value, d.citation); });
  } else {
    (meta.results || []).forEach(function (r) {
      const flagClass = 'flag-' + (r.abnormal_flag || 'unknown');
      const valueText = r.value + (r.unit ? ' ' + r.unit : '') + (r.reference_range ? ' (ref ' + r.reference_range + ')' : '');
      html += '<div class="doc-fact">' +
        '<div>' + r.test_name + (r.collection_date ? '<div class="doc-fact-cite">' + r.collection_date + '</div>' : '') + '</div>' +
        '<div class="doc-fact-value ' + flagClass + '">' + valueText +
          '<div class="doc-fact-cite">p.' + r.citation.page_or_section + ': &ldquo;' + r.citation.quote_or_value + '&rdquo;</div>' +
        '</div></div>';
    });
  }
  if (meta.unparsed_notes && meta.unparsed_notes.length) {
    html += '<div class="cite" style="margin-top:0.5rem">Not extracted: ' + meta.unparsed_notes.join('; ') + '</div>';
  }
  el.innerHTML = html;
  container.appendChild(el);
}

function addMessageEl(container, role, text, meta) {
  if (role === 'document') { renderDocumentCard(container, text, meta); return; }
  const el = document.createElement('div');
  el.className = 'msg ' + role;
  let html = text;
  if (meta && meta.verificationStatus) {
    html += ' <span class="badge ' + meta.verificationStatus + '">' + meta.verificationStatus + '</span>';
  }
  el.innerHTML = html;
  if (meta && meta.citations && meta.citations.length) {
    const cite = document.createElement('div');
    cite.className = 'cite';
    cite.textContent = 'Sources: ' + meta.citations.map(function (c) { return c.source_field; }).join(', ');
    el.appendChild(cite);
  }
  if (meta && meta.uncertainAbout && meta.uncertainAbout.length) {
    const unc = document.createElement('div');
    unc.className = 'cite';
    unc.textContent = "Couldn't answer from chart: " + meta.uncertainAbout.join('; ');
    el.appendChild(unc);
  }
  if (meta && meta.unfaithfulClaims && meta.unfaithfulClaims.length) {
    const unfaithful = document.createElement('div');
    unfaithful.className = 'cite';
    unfaithful.style.color = '#b00020';
    unfaithful.textContent = 'Flagged as possibly inaccurate: ' + meta.unfaithfulClaims.join('; ');
    el.appendChild(unfaithful);
  }
  if (meta && meta.handoffs && meta.handoffs.length) {
    const route = document.createElement('div');
    route.className = 'cite';
    route.title = meta.handoffs.map(function (h) { return h.to + ': ' + h.reason; }).join('\\n');
    route.textContent = 'Routing: supervisor → ' + meta.handoffs.map(function (h) { return h.to; }).join(' → ');
    el.appendChild(route);
  }
  container.appendChild(el);
}

function handleComposerKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
}

async function send() {
  const id = activePatientId;
  if (!id) return;
  const message = document.getElementById('message').value.trim();
  if (!message) return;
  const session = sessions[id];
  document.getElementById('message').value = '';
  session.messages.push({ role: 'user', text: message, meta: null, createdAt: nowStamp() });
  if (activePatientId === id) renderMessages(id);

  const btn = document.getElementById('askBtn');
  const textarea = document.getElementById('message');
  btn.disabled = true; textarea.disabled = true;
  try {
    const requestBody = { patientId: id, message: message };
    if (session.conversationId) requestBody.conversationId = session.conversationId;
    if (session.history.length) requestBody.history = session.history;
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(requestBody),
    });
    // 401 = the token is no longer valid (re-login). 403 = the token is fine but OpenEMR's own
    // ACL says this user may not read this chart — a real, expected outcome for restricted roles
    // (e.g. Front Office), so it stays in the chat as an explicit denial instead of a logout.
    if (res.status === 401) { sessionExpired(); return; }
    const body = await res.json();
    if (res.status === 403) {
      session.messages.push({ role: 'assistant', text: '🔒 Access denied: your OpenEMR account is not authorized to view this patient\\'s chart. (correlation ' + body.correlationId + ')', meta: null, createdAt: nowStamp() });
      if (activePatientId === id) renderMessages(id);
      return;
    }
    if (!res.ok) {
      session.messages.push({ role: 'assistant', text: 'Error: ' + (body.error || 'unknown error') + ' (correlation ' + body.correlationId + ')', meta: null, createdAt: nowStamp() });
      if (activePatientId === id) renderMessages(id);
      return;
    }
    session.conversationId = body.conversationId;
    session.history.push({ role: 'user', content: message });
    session.history.push({ role: 'assistant', content: body.summary });
    session.messages.push({ role: 'assistant', text: body.summary, meta: body, createdAt: nowStamp() });
    if (activePatientId === id) renderMessages(id);
  } finally {
    btn.disabled = false; textarea.disabled = false;
  }
}
</script>
</body>
</html>`;
}
