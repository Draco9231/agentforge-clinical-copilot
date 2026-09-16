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
  <input id="username" placeholder="username (e.g. admin)" value="admin" />
  <input id="password" type="password" placeholder="password (e.g. pass)" value="pass" />
  <button onclick="login()">Log in</button>
  <div id="loginError" style="color:#b00020"></div>
</div>

<div id="app">
  <label for="patientId">Patient ID</label>
  <input id="patientId" placeholder="e.g. 1" />
  <div id="messages"></div>
  <textarea id="message" rows="2" placeholder="Ask about this patient's meds, conditions, recent labs..."></textarea>
  <button onclick="send()">Ask</button>
</div>

<script>
let token = null;
let conversationId = null;
let history = [];

async function login() {
  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await res.json();
  if (!res.ok) {
    document.getElementById('loginError').textContent = body.error || 'Login failed';
    return;
  }
  token = body.access_token;
  document.getElementById('login').style.display = 'none';
  document.getElementById('app').style.display = 'block';
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
  document.getElementById('messages').appendChild(el);
}

async function send() {
  const patientId = document.getElementById('patientId').value.trim();
  const message = document.getElementById('message').value.trim();
  if (!patientId || !message) return;
  addMessage('user', message);
  document.getElementById('message').value = '';

  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ patientId, message, conversationId, history }),
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
