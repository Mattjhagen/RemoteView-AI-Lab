let current = null;
let pending = false;
const $ = id => document.getElementById(id);
async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}
async function run(task) {
  if (pending) return;
  pending = true;
  $('error').hidden = true;
  $('busy').textContent = 'Working…';
  document.querySelectorAll('button').forEach(button => button.disabled = true);
  try { await task(); } catch (error) { $('error').textContent = error.message || 'Connection failed. Please retry.'; $('error').hidden = false; }
  finally { pending = false; $('busy').textContent = ''; document.querySelectorAll('button').forEach(button => button.disabled = false); }
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}
async function list() {
  const sessions = await api('/api/sessions');
  $('sessions').replaceChildren();
  for (const session of sessions) {
    const button = element('button', `${session.code} · ${session.state}`, current?.id === session.id ? 'selected' : '');
    button.onclick = () => run(async () => { render(await api(`/api/sessions/${session.id}`)); await list(); });
    $('sessions').append(button);
  }
}
function render(session) {
  current = session;
  $('empty').hidden = true;
  $('workspace').hidden = false;
  $('code').textContent = `SESSION ${session.code}`;
  $('phase').textContent = {active: 'What do you notice?', finalized: 'Your observations are sealed.', revealed: 'The target is open.'}[session.state];
  $('transcript').replaceChildren();
  for (const entry of session.transcript) {
    const node = element('div', '', `entry ${entry.role}`);
    node.append(element('strong', entry.role === 'user' ? 'You' : entry.offline ? 'Guidance · offline prompt' : 'AI guide'), element('p', entry.content));
    $('transcript').append(node);
  }
  const active = session.state === 'active';
  $('impressionForm').hidden = !active;
  $('guidance').hidden = !active;
  $('finalize').hidden = !active;
  $('reveal').hidden = session.state !== 'finalized';
  $('download').hidden = active;
  $('seal').textContent = active ? 'Record impressions before finalizing. Finalization permanently locks the transcript.' : `Finalized ${session.finalized_at} · SHA-256: ${session.digest}`;
  $('target').hidden = !session.target;
  $('target').replaceChildren();
  if (session.target) $('target').append(element('p', 'REVEALED TARGET', 'eyebrow'), element('h2', session.target.title), element('p', session.target.description), element('p', 'Compare your recorded impressions with the target. Consider both similarities and differences.', 'muted'));
}
async function settings() {
  const data = await api('/api/settings');
  $('connection').textContent = data.connected ? `Connected · ${data.models.length} installed model(s)` : data.error;
  $('models').replaceChildren();
  for (const model of data.models) {
    const option = element('option', model); option.value = model; $('models').append(option);
  }
  if (data.models.includes(data.selected_model)) $('models').value = data.selected_model;
  else $('models').prepend(new Option(data.selected_model ? `${data.selected_model} (unavailable)` : 'Select a model', '', true, true));
}
$('settingsToggle').onclick = () => { $('settings').hidden = !$('settings').hidden; $('settingsToggle').setAttribute('aria-expanded', String(!$('settings').hidden)); };
$('refreshModels').onclick = () => run(settings);
$('saveModel').onclick = () => run(async () => { await api('/api/settings', {model: $('models').value}); await settings(); });
$('newSession').onclick = () => run(async () => { render(await api('/api/sessions', {})); $('impression').value = ''; await list(); });
$('impressionForm').onsubmit = event => { event.preventDefault(); run(async () => { render(await api(`/api/sessions/${current.id}/impressions`, {text: $('impression').value})); $('impression').value = ''; }); };
for (const action of ['guidance', 'finalize', 'reveal']) $(action).onclick = () => run(async () => {
  if (action === 'finalize') {
    if ($('impression').value.trim()) throw new Error('Record or clear your unsaved impression before finalizing.');
    if (!confirm('Permanently lock this transcript? You can reveal the target afterward.')) return;
  }
  render(await api(`/api/sessions/${current.id}/${action}`, {})); await list();
});
$('download').onclick = () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(current, null, 2)], {type: 'application/json'}));
  const link = document.createElement('a'); link.href = url; link.download = `remoteview-${current.code}.json`; link.click(); URL.revokeObjectURL(url);
};
run(async () => { await list(); await settings(); });
