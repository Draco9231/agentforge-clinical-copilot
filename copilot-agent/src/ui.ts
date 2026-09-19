export function renderChatPage(openemrBaseUrl: string, apiSite: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Clinical Co-Pilot</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; color: #1a1a2e; }
  h1 { font-size: 1.3rem; }
  #login, #app { border: 1px solid #ddd; border-radius: 8px; padding: 1rem; margin-top: 1rem; }
  input, select, button, textarea { font-size: 1rem; padding: 0.5rem; margin: 0.25rem 0; width: 100%; box-sizing: border-box; }
  button { cursor: pointer; background: #2b5fd9; color: white; border: none; border-radius: 6px; }
  .msg { padding: 0.6rem 0.8rem; border-radius: 8px; margin: 0.5rem 0; white-space: pre-wrap; }
  .msg.user { background: #eef1ff; }
  .msg.assistant { background: #f4f4f4; }
  .badge { display: inline-block; font-size: 0.75rem; padding: 0.1rem 0.5rem; border-radius: 10px; margin-left: 0.4rem; }
  .badge.verified { background: #d6f5dd; color: #146c2e; }
  .badge.degraded { background: #fff3cd; color: #8a6300; }
  .cite { font-size: 0.8rem; color: #555; margin-top: 0.4rem; }
  #app { display: none; }
  .hint { color: #777; font-size: 0.85rem; }
</style>
</head>
<body>
<h1>🩺 Clinical Co-Pilot (demo shell)</h1>
<p class="hint">Logs in as an OpenEMR user and asks only about that user's authorized patients — OpenEMR's own permissions apply.</p>

<div id="login">
  <strong>Log in with your OpenEMR account</strong>
  <p class="hint">You'll be taken to OpenEMR's own login page — this app never sees your password.</p>
  <button onclick="location.href='/login'">Log in with OpenEMR</button>
  <div id="loginError" style="color:#b00020"></div>
</div>

<div id="app">
  <label for="patientId">Patient</label>
  <select id="patientId" onchange="onPatientChange()"><option value="">Loading patients…</option></select>
  <div id="patientIdHint" class="hint"></div>
  <div id="messages"></div>
  <textarea id="message" rows="2" placeholder="Ask about this patient's meds, conditions, recent labs..."></textarea>
  <button onclick="send()">Ask</button>
</div>

<script>
let token = null;
let conversationId = null;
let history = [];

// The /callback landing page (after OpenEMR's own login) stores the token here and redirects
// back to '/' — this just needs to notice it's there, not perform the login itself.
(function initFromSession() {
  const stored = sessionStorage.getItem('access_token');
  if (stored) {
    token = stored;
    document.getElementById('login').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    loadPatients();
  }
})();

// A physician has ~90 seconds between rooms — typing or memorizing a raw FHIR patient ID
// (a UUID) is not something anyone does in that window. This replaces that with a name + DOB
// picker; the raw ID is still shown (loadPatients/onPatientChange below) for anyone who needs
// it for debugging or cross-referencing, just never something a user has to type or remember.
async function loadPatients() {
  const select = document.getElementById('patientId');
  try {
    const res = await fetch('/api/patients', { headers: { Authorization: 'Bearer ' + token } });
    const bundle = await res.json();
    const entries = (bundle.entry || []).map(e => e.resource);
    if (!res.ok || entries.length === 0) {
      select.innerHTML = '<option value="">No patients found</option>';
      return;
    }
    select.innerHTML = entries.map(function (p) {
      const name = p.name && p.name[0] ? [(p.name[0].given || []).join(' '), p.name[0].family].filter(Boolean).join(' ') : 'Unknown';
      const dob = p.birthDate ? ' — DOB ' + p.birthDate : '';
      return '<option value="' + p.id + '">' + name + dob + '</option>';
    }).join('');
    onPatientChange();
  } catch (e) {
    select.innerHTML = '<option value="">Could not load patients</option>';
  }
}

function onPatientChange() {
  const select = document.getElementById('patientId');
  const id = select.value;
  document.getElementById('patientIdHint').textContent = id ? 'Patient ID: ' + id : '';
}

function addMessage(role, text, meta) {
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
    cite.textContent = 'Sources: ' + meta.citations.map(c => c.source_field).join(', ');
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
  document.getElementById('messages').appendChild(el);
}

async function send() {
  const patientId = document.getElementById('patientId').value.trim();
  const message = document.getElementById('message').value.trim();
  if (!patientId || !message) return;
  addMessage('user', message);
  document.getElementById('message').value = '';

  const requestBody = { patientId: patientId, message: message };
  if (conversationId) requestBody.conversationId = conversationId;
  if (history.length) requestBody.history = history;
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(requestBody),
  });
  const body = await res.json();
  if (!res.ok) {
    addMessage('assistant', 'Error: ' + (body.error || 'unknown error') + ' (correlation ' + body.correlationId + ')');
    return;
  }
  conversationId = body.conversationId;
  history.push({ role: 'user', content: message });
  history.push({ role: 'assistant', content: body.summary });
  addMessage('assistant', body.summary, body);
}
</script>
</body>
</html>`;
}
