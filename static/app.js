let current = null;
let pending = false;
let csrfToken = null;
const $ = id => document.getElementById(id);
async function api(path, body, csrfRetried = false) {
  if (body !== undefined && !csrfToken) await api('/api/auth');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 65000);
  try {
    const response = await fetch(path, {signal: controller.signal, ...(body === undefined ? {} : {method: 'POST', headers: {'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken}, body: JSON.stringify(body)})});
    let data;
    try { data = await response.json(); } catch { throw new Error('The server returned an unreadable response. Please retry.'); }
    if (response.status === 403 && data.error === 'CSRF token missing or invalid' && body !== undefined && !csrfRetried) {
      await api('/api/auth');
      return await api(path, body, true);
    }
    if (data.csrf_token) csrfToken = data.csrf_token;
    if (response.status === 401) showLogin(true);
    if (!response.ok) throw new Error(data.error || 'Request failed. Please retry.');
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The request timed out. Refresh history before retrying; the server may have saved the result.');
    if (error instanceof TypeError) throw new Error('Cannot reach RemoteView AI Lab. Check the local server or SSH tunnel, then retry.');
    throw error;
  } finally { clearTimeout(timeout); }
}

async function run(task, message = 'Working…') {
  if (pending) return;
  pending = true;
  $('error').hidden = true;
  $('busy').textContent = message;
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
    node.append(element('strong', entry.role === 'user' ? 'You' : entry.offline ? 'Guidance · offline prompt' : 'AI monitor'), element('p', entry.content));
    if (entry.timestamp) node.append(element('small', entry.timestamp, 'muted'));
    $('transcript').append(node);
  }
  const active = session.state === 'active';
  $('impressionForm').hidden = !active;
  $('guidance').hidden = !active;
  $('finalize').hidden = !active;
  $('reveal').hidden = session.state !== 'finalized';
  $('beginJudging').hidden = session.state !== 'finalized';
  $('judgingLink').replaceChildren();
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
}, action === 'guidance' ? 'Waiting for neutral Ollama guidance…' : 'Saving session…');
$('download').onclick = () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(current, null, 2)], {type: 'application/json'}));
  const link = document.createElement('a'); link.href = url; link.download = `remoteview-${current.code}.json`; link.click(); URL.revokeObjectURL(url);
};


function mode(name) {
  for (const value of ['human', 'experiment', 'dashboard']) {
    $(`${value}Panel`).hidden = value !== name;
    $(`${value}Mode`).classList.toggle('selected', value === name);
  }
}
$('humanMode').onclick = () => mode('human');
$('experimentMode').onclick = () => run(async () => { mode('experiment'); await experiments(); });
$('dashboardMode').onclick = () => run(async () => { mode('dashboard'); await dashboard(); });
$('refreshDashboard').onclick = () => run(dashboard);
function judgingLink(assignment) {
  const link = element('a', assignment.submitted_at ? 'View submitted ranking' : 'Open blind judging');
  link.href = assignment.url;
  link.target = '_blank';
  link.rel = 'noopener';
  return link;
}
$('beginJudging').onclick = () => run(async () => {
  const assignment = await api(`/api/sessions/${current.id}/judging`, {});
  $('judgingLink').replaceChildren(judgingLink(assignment), element('span', ' · Share this link with an independent judge. Answer reveal is blocked until submission.'));
});
function experimentResult(trial) {
  const box = $('experimentResult'); box.replaceChildren();
  box.append(element('h3', `${trial.condition} · ${trial.state}`));
  if (trial.error) box.append(element('p', trial.error));
  if (trial.response) box.append(element('p', trial.response, 'entry preserve'));
  if (trial.judging) box.append(judgingLink(trial.judging));
  if (trial.target) box.append(element('p', `Reference target: ${trial.target.title} · ${trial.target.description}`));
  const details = document.createElement('details');
  details.append(element('summary', 'Recorded model settings, prompts, timestamps, and hashes'), element('pre', JSON.stringify(trial, null, 2)));
  box.append(details);
}
async function experiments() {
  const trials = await api('/api/experiments');
  $('experimentHistory').replaceChildren();
  for (const trial of trials) {
    const button = element('button', `${trial.created_at} · ${trial.condition} · ${trial.model} · ${trial.state}`);
    button.onclick = () => run(async () => experimentResult(await api(`/api/experiments/${trial.id}`)));
    $('experimentHistory').append(button);
  }
  if (!trials.length) $('experimentHistory').append(element('p', 'No AI experiments yet.', 'muted'));
}
$('experimentForm').onsubmit = event => {
  event.preventDefault();
  run(async () => {
    const body = {condition: $('condition').value, temperature: Number($('temperature').value)};
    if ($('seed').value !== '') body.seed = Number($('seed').value);
    experimentResult(await api('/api/experiments', body)); await experiments();
  }, 'Running a blinded AI experiment. Ollama may take up to 45 seconds…');
};
const percent = value => value === null ? '—' : `${(value * 100).toFixed(1)}%`;
function table(headers, rows) {
  const node = document.createElement('table');
  const head = document.createElement('thead'); const tr = document.createElement('tr');
  for (const header of headers) tr.append(element('th', header));
  head.append(tr); node.append(head);
  const body = document.createElement('tbody');
  for (const row of rows) { const tr = document.createElement('tr'); for (const cell of row) tr.append(element('td', String(cell))); body.append(tr); }
  node.append(body); const wrap = element('div', '', 'table-wrap'); wrap.append(node); return wrap;
}
function drawAccuracy(rows) {
  const canvas = $('accuracyChart'), context = canvas.getContext('2d');
  const width = canvas.width, height = canvas.height, left = 60, right = width - 25, top = 20, bottom = height - 45;
  context.clearRect(0, 0, width, height); context.font = '14px system-ui';
  context.fillStyle = '#91a8b2'; context.strokeStyle = '#36515b';
  for (let step = 0; step <= 5; step++) {
    const y = bottom - step / 5 * (bottom - top);
    context.beginPath(); context.moveTo(left, y); context.lineTo(right, y); context.stroke(); context.fillText(`${step * 20}%`, 8, y + 5);
  }
  const baseline = bottom - .2 * (bottom - top);
  context.strokeStyle = '#e9c38b'; context.setLineDash([7, 5]); context.beginPath(); context.moveTo(left, baseline); context.lineTo(right, baseline); context.stroke(); context.setLineDash([]);
  context.fillStyle = '#e9c38b'; context.fillText('20% chance', right - 100, baseline - 8);
  if (!rows.length) { context.fillStyle = '#dfe9ec'; context.fillText('Submit blind rankings to populate this chart.', 100, 100); return; }
  let hits = 0; context.strokeStyle = '#98dfc9'; context.lineWidth = 3; context.beginPath();
  rows.forEach((row, index) => {
    hits += row.hit; const x = left + (index / Math.max(1, rows.length - 1)) * (right - left);
    const y = bottom - hits / (index + 1) * (bottom - top);
    if (!index) context.moveTo(x, y); else context.lineTo(x, y);
  }); context.stroke(); context.lineWidth = 1;
  // A single observation must be visible too.
  if (rows.length === 1) { context.fillStyle = '#98dfc9'; context.beginPath(); context.arc(left, bottom - rows[0].hit * (bottom - top), 5, 0, Math.PI * 2); context.fill(); }
  context.fillStyle = '#91a8b2'; context.fillText(`Submitted trials: 1–${rows.length}`, left, height - 12);
}
function drawComparisons(groups) {
  const rows = [['kind', 'Participant'], ['model', 'Model'], ['condition', 'Condition']].flatMap(([key, title]) => groups[key].map(group => ({...group, label: `${title}: ${group.label}`})));
  const canvas = $('comparisonChart'); canvas.height = Math.max(150, 70 + rows.length * 40);
  const context = canvas.getContext('2d'), left = 260, right = canvas.width - 50, top = 30;
  context.clearRect(0, 0, canvas.width, canvas.height); context.font = '14px system-ui';
  const x = p => left + p * (right - left);
  context.strokeStyle = '#e9c38b'; context.setLineDash([7, 5]); context.beginPath(); context.moveTo(x(.2), top); context.lineTo(x(.2), canvas.height - 30); context.stroke(); context.setLineDash([]);
  context.fillStyle = '#e9c38b'; context.fillText('20% chance', x(.2) - 30, 18);
  if (!rows.length) { context.fillStyle = '#91a8b2'; context.fillText('No scored groups yet.', 30, 70); return; }
  rows.forEach((row, index) => {
    const y = top + 20 + index * 40;
    context.fillStyle = '#dfe9ec'; context.fillText(row.label, 15, y + 5, left - 30);
    context.strokeStyle = '#98dfc9'; context.lineWidth = 3;
    context.beginPath(); context.moveTo(x(row.ci95[0]), y); context.lineTo(x(row.ci95[1]), y); context.stroke();
    context.fillStyle = '#98dfc9'; context.beginPath(); context.arc(x(row.accuracy), y, 5, 0, Math.PI * 2); context.fill();
  });
  context.fillStyle = '#91a8b2'; context.fillText('0%', left, canvas.height - 8); context.fillText('100%', right - 30, canvas.height - 8);
}
async function dashboard() {
  const data = await api('/api/dashboard');
  $('summary').replaceChildren();
  for (const [label, value] of [['Scored trials', data.overall.n], ['First-place accuracy', percent(data.overall.accuracy)], ['Chance baseline', '20%'], ['Awaiting judging', data.pending_judgments], ['Completed AI trials', data.experiments.completed || 0], ['Failed AI trials', data.experiments.failed || 0], ['Running AI trials', data.experiments.running || 0]]) {
    const metric = element('div', '', 'metric'); metric.append(element('strong', String(value)), element('span', label)); $('summary').append(metric);
  }
  $('comparisons').replaceChildren();
  for (const [key, title] of [['kind', 'Human versus AI'], ['model', 'Model comparisons'], ['condition', 'Experiment conditions']]) {
    $('comparisons').append(element('h3', title), table(['Group', 'Trials', 'First place', 'Accuracy', '95% confidence interval'], data.groups[key].map(g => [g.label, g.n, g.hits, percent(g.accuracy), g.ci95.map(percent).join(' – ')])));
  }
  $('intervalNote').textContent = `${data.interval_method}. Small samples, a reusable five-image pool, and self-judging limit interpretation. Overall interval: ${data.overall.ci95 ? data.overall.ci95.map(percent).join(' – ') : 'no scored trials'}.`;
  $('trialHistory').replaceChildren(table(['Submitted (UTC)', 'Participant', 'Model', 'Condition', 'First place'], data.history.map(row => [row.submitted_at, row.kind, row.model || '—', row.condition || 'human', row.hit ? 'Correct' : 'Incorrect'])));
  drawAccuracy(data.history);
  drawComparisons(data.groups);
}
const judgeToken = new URLSearchParams(location.search).get('judge');
let judgment = null;
function showJudgment(data) {
  judgment = data;
  $('judgeObservations').textContent = data.observations;
  $('candidates').replaceChildren();
  data.candidates.forEach((candidate, index) => {
    const card = element('div', '', 'candidate');
    const image = document.createElement('img'); image.src = candidate.image_url; image.alt = `Candidate ${index + 1} landscape illustration`;
    const label = element('label', `Candidate ${index + 1} rank`); label.htmlFor = `rank-${candidate.id}`;
    const select = document.createElement('select'); select.id = label.htmlFor; select.dataset.candidate = candidate.id; select.required = true;
    select.append(new Option('Choose rank', ''));
    for (let rank = 1; rank <= 5; rank++) select.append(new Option(String(rank), String(rank)));
    if (data.submitted_at) { select.value = String(data.ranking.indexOf(candidate.id) + 1); select.disabled = true; }
    card.append(image, label, select);
    if (data.answer === candidate.id) card.append(element('p', 'Assigned target', 'eyebrow'));
    $('candidates').append(card);
  });
  $('submitRanking').hidden = Boolean(data.submitted_at);
  $('judgeOutcome').textContent = data.submitted_at ? `Ranking sealed. First place: ${data.hit ? 'correct' : 'incorrect'}. Chance baseline: 20%.` : 'Submission is final. No answer key is available before submission.';
}
$('judgeForm').onsubmit = event => {
  event.preventDefault();
  run(async () => {
    const selections = [...$('candidates').querySelectorAll('select')];
    if (new Set(selections.map(s => s.value)).size !== 5 || selections.some(s => !s.value)) throw new Error('Assign each rank from 1 to 5 exactly once.');
    const ranking = selections.sort((a, b) => Number(a.value) - Number(b.value)).map(s => s.dataset.candidate);
    showJudgment(await api(`/api/judge/${encodeURIComponent(judgeToken)}`, {ranking}));
  });
};
function showLogin(required) {
  $('loginPanel').hidden = !required;
  if (required) {
    for (const id of ['humanPanel', 'experimentPanel', 'dashboardPanel', 'judgePanel', 'settings']) $(id).hidden = true;
    document.querySelector('.mode-tabs').hidden = true;
    $('settingsToggle').hidden = true; $('logout').hidden = true;
    // Don't leave private content in the page after expiry or logout.
    for (const id of ['transcript', 'target', 'experimentResult', 'experimentHistory', 'trialHistory', 'comparisons', 'summary', 'candidates', 'judgeObservations', 'sessions']) $(id).replaceChildren();
    $('impression').value = ''; $('seal').textContent = ''; $('judgeOutcome').textContent = '';
    for (const id of ['accuracyChart', 'comparisonChart']) { const canvas = $(id); canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height); }
    current = null; judgment = null;
  }
}
async function initialize() {
  const state = await api('/api/auth');
  showLogin(state.login_required && !state.authenticated);
  if (state.login_required && !state.authenticated) return;
  $('logout').hidden = !state.login_required;
  if (judgeToken) {
    document.querySelector('.mode-tabs').hidden = true; $('humanPanel').hidden = true; $('settingsToggle').hidden = true; $('judgePanel').hidden = false;
    showJudgment(await api(`/api/judge/${encodeURIComponent(judgeToken)}`));
  } else {
    document.querySelector('.mode-tabs').hidden = false; $('settingsToggle').hidden = false;
    mode('human'); $('empty').hidden = false; $('workspace').hidden = true;
    await list(); await settings();
  }
}
$('loginForm').onsubmit = event => {
  event.preventDefault();
  run(async () => { const password = $('password').value; $('password').value = ''; await api('/api/login', {password}); await initialize(); }, 'Signing in…');
};
$('logout').onclick = () => run(async () => { await api('/api/logout', {}); location.reload(); });
run(initialize);
