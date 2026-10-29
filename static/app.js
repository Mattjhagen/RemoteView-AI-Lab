let current = null;
let pending = false;
let csrfToken = null;
// Drafts stay in this tab's memory, never in shared browser storage.
const drafts = new Map();
let selectedModel = '';
let modelAvailable = false;
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
    if (!response.ok) throw new Error(data.error === 'Invalid credentials' ? 'That password didn’t match. Try again or ask the site owner for the application password.' : data.error || 'Request failed. Please retry.');
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The request timed out. Refresh history before retrying; the server may have saved the result.');
    if (error instanceof TypeError) throw new Error('Cannot reach RemoteView AI Lab. Check your connection, then try again. Your saved notes are kept on the server.');
    throw error;
  } finally { clearTimeout(timeout); }
}

async function run(task, message = 'Working…') {
  if (pending) return;
  pending = true;
  $('error').hidden = true;
  $('busy').textContent = message;
  document.querySelectorAll('button').forEach(button => button.disabled = true);
  $('main').setAttribute('aria-busy', 'true');
  try { await task(); } catch (error) { $('error').textContent = error.message || 'Connection failed. Please retry.'; $('error').hidden = false; $('error').scrollIntoView({block: 'center'}); }
  finally { pending = false; $('busy').textContent = ''; $('main').setAttribute('aria-busy', 'false'); document.querySelectorAll('button').forEach(button => button.disabled = false); updateControls(); }
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
    const button = element('button', `${session.code} · ${{active: 'Writing notes', finalized: session.judging?.submitted_at ? 'Ready to reveal' : session.judging ? 'Waiting for ranking' : 'Notes locked', revealed: 'Scene revealed'}[session.state]}`, current?.id === session.id ? 'selected' : '');
    button.onclick = () => run(async () => { render(await api(`/api/sessions/${session.id}`)); await list(); });
    if (current?.id === session.id) button.setAttribute('aria-current', 'true');
    $('sessions').append(button);
  }
  $('sessionListHelp').textContent = sessions.length ? 'Select a session to continue or review it. Your history is private to this browser.' : 'No sessions yet. Start your first one—no AI setup is needed.';
}
function rememberDraft() {
  if (current?.state === 'active') {
    const text = $('impression').value;
    if (text.trim()) drafts.set(current.id, text); else drafts.delete(current.id);
  }
}
function updateControls() {
  const hasDraft = Boolean($('impression').value.trim());
  const hasNotes = Boolean(current?.transcript.some(entry => entry.role === 'user'));
  $('record').disabled = pending || !hasDraft;
  $('finalize').disabled = pending || !hasNotes;
  $('experimentForm').querySelector('button[type="submit"]').disabled = pending || !modelAvailable;
  if (current?.state === 'active') $('draftStatus').textContent = hasDraft ? 'Not saved yet. Press Save observation to add these words to your notes.' : hasNotes ? 'Observation saved. You can add more, or finish & lock your notes.' : 'Nothing typed yet. Use Save observation to record your words.';
}
$('impression').addEventListener('input', () => { rememberDraft(); updateControls(); });
window.addEventListener('beforeunload', event => {
  rememberDraft();
  if (drafts.size) { event.preventDefault(); event.returnValue = ''; }
});
function render(session) {
  rememberDraft();
  current = session;
  const active = session.state === 'active';
  const revealed = session.state === 'revealed';
  const assignment = session.judging;
  const waiting = assignment && !assignment.submitted_at;
  $('impression').value = drafts.get(session.id) || '';
  $('empty').hidden = true;
  $('workspace').hidden = false;
  $('code').textContent = `SESSION ${session.code} · YOU WRITE THE OBSERVATIONS`;
  $('phase').textContent = active ? 'Start with what comes to mind.' : revealed ? 'Here is your assigned scene.' : waiting ? 'Your picture comparison is ready.' : 'Your notes are locked.';
  const count = session.transcript.filter(entry => entry.role === 'user').length;
  let step = active ? (count ? 1 : 0) : revealed ? 3 : assignment?.submitted_at ? 3 : 2;
  document.querySelectorAll('#workspace .steps li').forEach((item, index) => {
    item.classList.toggle('complete', index < step);
    if (index === step) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current');
  });
  $('nextTitle').textContent = active ? (count ? 'Keep exploring, or finish your notes' : 'Write your first observation') : revealed ? 'Look for differences as well as similarities' : waiting ? 'Open the comparison and rank all five pictures' : assignment?.submitted_at ? 'Your ranking is saved. You can reveal the scene.' : 'Choose how you want to compare';
  $('nextHelp').textContent = active ? (count ? `${count} observation${count === 1 ? '' : 's'} saved. Add anything else you notice. When you’re done, Finish & lock notes permanently ends writing.` : 'A hidden scene has been selected. Take a moment, then describe whatever comes to mind. You are not expected to see an image or guess a specific place. Save your words before continuing.') : revealed ? 'Review what you actually wrote before the reveal. Broad descriptions can fit several scenes; a match alone does not show unusual ability.' : waiting ? 'The comparison opens in another tab. Submit one ranking using each number 1–5 once. Then come back and check for the submitted ranking before revealing.' : assignment?.submitted_at ? 'The comparison is already scored. Show hidden scene to review it with your notes, or open Dashboard to see your results.' : 'For a scored session, choose Compare 5 pictures and rank them before seeing the answer. For personal reflection only, choose Show hidden scene. Revealing now means this session cannot be scored later.';
  $('transcript').replaceChildren();
  for (const entry of session.transcript) {
    const node = element('div', '', `entry ${entry.role}`);
    node.append(element('strong', entry.role === 'user' ? 'Your observation' : entry.offline ? 'Optional prompt · AI unavailable' : 'Optional AI question'), element('p', entry.content));
    if (entry.timestamp) node.append(element('small', entry.timestamp, 'muted'));
    $('transcript').append(node);
  }
  $('notesHelp').textContent = count ? `${count} saved observation${count === 1 ? '' : 's'}. AI questions help you reflect; only your own words are used for judging.` : 'No observations saved yet. Write above and press Save observation.';
  $('impressionForm').hidden = !active;
  $('guidance').hidden = !active;
  $('finalize').hidden = !active;
  $('reveal').hidden = active || revealed || Boolean(waiting);
  $('beginJudging').hidden = active || revealed || Boolean(assignment);
  $('refreshSession').hidden = !waiting;
  $('judgingLink').replaceChildren();
  if (assignment) $('judgingLink').append(judgingLink(assignment), element('span', ' · Opens in a new tab. You can also share this private link with an independent judge who can sign in.'));
  $('download').hidden = active;
  $('anotherSession').hidden = !revealed;
  $('sessionFeedback').textContent = '';
  $('seal').textContent = active ? 'Your saved observations are recorded in order. Finish & lock notes permanently ends editing.' : `Finalized ${session.finalized_at} · SHA-256: ${session.digest}`;
  $('target').hidden = !session.target;
  $('target').replaceChildren();
  if (session.target) $('target').append(element('p', 'YOUR ASSIGNED SCENE', 'eyebrow'), element('h2', session.target.title), element('p', session.target.description), element('p', assignment?.submitted_at ? 'Your picture ranking is saved in Dashboard.' : 'This was a reflection-only session. It has no submitted ranking, so it is not included in dashboard accuracy.', 'muted'));
  updateControls();
}
async function settings() {
  const data = await api('/api/settings');
  selectedModel = data.selected_model;
  modelAvailable = data.connected && data.models.includes(selectedModel);
  $('connection').textContent = data.connected ? `Connected · ${data.models.length} available model(s)` : 'AI is unavailable right now. You can still write a human session. Try Refresh models to check again.';
  $('experimentModel').textContent = modelAvailable ? `Using ${selectedModel}. Change it in Model settings if you wish.` : 'Choose an available AI in Model settings before running a trial. Human sessions do not require AI.';
  $('models').replaceChildren();
  for (const model of data.models) {
    const option = element('option', model); option.value = model; $('models').append(option);
  }
  if (data.models.includes(data.selected_model)) $('models').value = data.selected_model;
  else $('models').prepend(new Option(data.selected_model ? `${data.selected_model} (unavailable)` : 'Select a model', '', true, true));
}
$('settingsToggle').onclick = () => { $('settings').hidden = !$('settings').hidden; $('settingsToggle').setAttribute('aria-expanded', String(!$('settings').hidden)); };
$('refreshModels').onclick = () => run(settings);
$('saveModel').onclick = () => run(async () => { await api('/api/settings', {model: $('models').value}); await settings(); $('modelSaved').textContent = 'Model saved. It will be used for your next AI request.'; });
function focusWorkspace() { $('phase').focus(); }
function startSession() {
  return run(async () => { mode('human'); render(await api('/api/sessions', {})); await list(); focusWorkspace(); }, 'Selecting a hidden scene…');
}
for (const id of ['newSession', 'startFirst', 'anotherSession', 'dashboardStart']) $(id).onclick = startSession;
$('impressionForm').onsubmit = event => { event.preventDefault(); run(async () => {
  const session = await api(`/api/sessions/${current.id}/impressions`, {text: $('impression').value});
  drafts.delete(current.id); $('impression').value = ''; render(session);
  $('sessionFeedback').textContent = 'Observation saved. Add more or finish & lock notes when you’re ready.';
  await list();
}); };
for (const action of ['guidance', 'finalize', 'reveal']) $(action).onclick = () => run(async () => {
  if (action === 'finalize') {
    if ($('impression').value.trim()) { $('impression').focus(); throw new Error('Save your observation before locking your notes, or clear the unsaved text.'); }
    if (!confirm('Finish and permanently lock your saved notes? You won’t be able to add or change observations. You can compare pictures before revealing the scene.')) return;
  }
  if (action === 'reveal') {
    // Recheck server state in case judging changed in another tab.
    render(await api(`/api/sessions/${current.id}`));
    if (current.judging && !current.judging.submitted_at) throw new Error('Submit the picture ranking in the comparison tab first. Then choose Check for submitted ranking.');
    if (!current.judging && !confirm('Show the hidden scene without a score? This session can’t enter blind judging after you reveal it. Choose Cancel, then Compare 5 pictures if you want a scored session.')) return;
  }
  render(await api(`/api/sessions/${current.id}/${action}`, {})); await list();
  if (action !== 'guidance') focusWorkspace();
}, action === 'guidance' ? 'Getting an optional AI question. It has no access to the hidden scene…' : 'Saving your session…');
$('refreshSession').onclick = () => run(async () => {
  render(await api(`/api/sessions/${current.id}`)); await list();
  $('sessionFeedback').textContent = current.judging?.submitted_at ? 'Ranking received. You can now show the hidden scene.' : 'No ranking submitted yet. Open the picture comparison and submit all five ranks.';
});
$('download').onclick = () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(current, null, 2)], {type: 'application/json'}));
  const link = document.createElement('a'); link.href = url; link.download = `remoteview-${current.code}.json`; link.click(); URL.revokeObjectURL(url);
};


function mode(name) {
  for (const value of ['human', 'experiment', 'dashboard']) {
    $(`${value}Panel`).hidden = value !== name;
    $(`${value}Mode`).classList.toggle('selected', value === name);
    $(`${value}Mode`).setAttribute('aria-pressed', String(value === name));
  }
}
$('humanMode').onclick = () => mode('human');
$('experimentMode').onclick = () => run(async () => { mode('experiment'); await settings(); await experiments(); });
$('tryAI').onclick = $('experimentMode').onclick;
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
  await api(`/api/sessions/${current.id}/judging`, {});
  render(await api(`/api/sessions/${current.id}`)); await list();
  $('judgingLink').querySelector('a').focus();
});
const conditions = {before: 'Scene chosen before writing', after: 'Scene chosen after writing', control: 'Imagined-scene control'};
const trialStates = {completed: 'Ready to compare', invalid_response: 'No usable observations', failed: 'AI request failed', running: 'AI is writing'};
function experimentResult(trial) {
  const box = $('experimentResult'); box.replaceChildren();
  box.append(element('h3', `${conditions[trial.condition]} · ${trial.judging?.submitted_at ? 'Ranking saved' : trialStates[trial.state]}`));
  box.append(element('p', `Model: ${trial.model} · Temperature: ${trial.options.temperature} · Inference seed: ${trial.options.seed}`));
  if (trial.state === 'invalid_response') box.append(element('p', 'Experiment completed technically, but the AI did not generate usable experimental impressions. This trial is excluded from accuracy scoring.'));
  if (trial.error) box.append(element('p', trial.error));
  if (trial.response) box.append(element('p', trial.response, 'entry preserve'));
  if (trial.judging) {
    box.append(element('p', trial.judging.submitted_at ? 'Your ranking is saved. Open Dashboard to see the score.' : 'Next: open the picture comparison, read the sealed description and rank all five pictures. The trial is not scored until a ranking is submitted.'));
    box.append(judgingLink(trial.judging));
    const refresh = element('button', 'Refresh this trial');
    refresh.onclick = () => run(async () => experimentResult(await api(`/api/experiments/${trial.id}`)));
    box.append(refresh);
  }
  if (trial.state === 'failed') box.append(element('p', 'This trial has no score. Check Model settings and try a new experiment when the model is available.'));
  if (trial.state === 'running') box.append(element('p', 'Check Experiment history again before starting another run.'));
  if (trial.target) box.append(element('p', `Assigned scene: ${trial.target.title} · ${trial.target.description}`));
  const details = document.createElement('details');
  details.append(element('summary', 'Recorded model settings, prompts, timestamps, and hashes'), element('pre', JSON.stringify(trial, null, 2)));
  box.append(details);
}
function explainCondition() {
  $('conditionHelp').textContent = {
    before: 'The lab picks the hidden scene first, then the AI writes without seeing it. “Before” describes selection timing, not what the AI sees.',
    after: 'The AI writes first. Only after its response is sealed does the lab pick the hidden scene. The AI receives no scene information.',
    control: 'The AI is asked to imagine a scene. A reference is independently chosen afterward and compared in the same way. This is a comparison condition.'
  }[$('condition').value];
}
let instructionDefaults;
function restoreInstructions() {
  $('systemPrompt').value = instructionDefaults.system;
  $('userPrompt').value = $('condition').value === 'control' ? instructionDefaults.control : instructionDefaults.user;
}
$('restoreInstructions').onclick = () => run(async () => {
  instructionDefaults = await api('/api/experiment-instructions'); restoreInstructions();
});
$('condition').onchange = () => { if (instructionDefaults) restoreInstructions(); explainCondition(); };
async function experiments() {
  explainCondition();
  if (!instructionDefaults) {
    instructionDefaults = await api('/api/experiment-instructions'); restoreInstructions();
  }
  const trials = await api('/api/experiments');
  $('experimentHistory').replaceChildren();
  for (const trial of trials) {
    const button = element('button', `${trial.created_at} · ${conditions[trial.condition]} · ${trial.model} · ${trial.judging?.submitted_at ? 'Ranking saved' : trialStates[trial.state]}`);
    button.onclick = () => run(async () => experimentResult(await api(`/api/experiments/${trial.id}`)));
    $('experimentHistory').append(button);
  }
  if (!trials.length) $('experimentHistory').append(element('p', 'No AI experiments yet. Use Run AI experiment above to create your first trial.', 'muted'));
}
$('experimentForm').onsubmit = event => {
  event.preventDefault();
  run(async () => {
    const body = {condition: $('condition').value, temperature: Number($('temperature').value), system_prompt: $('systemPrompt').value, user_prompt: $('userPrompt').value};
    if ($('seed').value !== '') body.seed = Number($('seed').value);
    experimentResult(await api('/api/experiments', body)); await experiments();
  }, 'The AI is writing without seeing the scene. Allow up to 45 seconds; please don’t start another run…');
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
  const rows = [['kind', 'Participant'], ['model', 'Model'], ['condition', 'Condition']].flatMap(([key, title]) => groups[key].map(group => ({...group, label: `${title}: ${conditions[group.label] || group.label}`})));
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
  $('dashboardEmpty').hidden = data.overall.n > 0;
  $('summary').replaceChildren();
  for (const [label, value] of [['Scored trials', data.overall.n], ['First-place accuracy', percent(data.overall.accuracy)], ['Chance baseline', '20%'], ['Awaiting judging', data.pending_judgments], ['Completed AI trials', data.experiments.completed || 0], ['Invalid AI responses', data.experiments.invalid_response || 0], ['Failed AI trials', data.experiments.failed || 0], ['Running AI trials', data.experiments.running || 0]]) {
    const metric = element('div', '', 'metric'); metric.append(element('strong', String(value)), element('span', label)); $('summary').append(metric);
  }
  $('comparisons').replaceChildren();
  for (const [key, title] of [['kind', 'Human versus AI'], ['model', 'Model comparisons'], ['condition', 'Experiment conditions']]) {
    $('comparisons').append(element('h3', title), table(['Group', 'Trials', 'First place', 'Accuracy', '95% confidence interval'], data.groups[key].map(g => [conditions[g.label] || g.label, g.n, g.hits, percent(g.accuracy), g.ci95.map(percent).join(' – ')])));
  }
  $('intervalNote').textContent = `${data.interval_method}. Small samples, a reusable five-image pool, and self-judging limit interpretation. Overall interval: ${data.overall.ci95 ? data.overall.ci95.map(percent).join(' – ') : 'no scored trials'}.`;
  $('trialHistory').replaceChildren(table(['Submitted (UTC)', 'Participant', 'Model', 'Condition', 'First place'], data.history.map(row => [row.submitted_at, row.kind, row.model || '—', conditions[row.condition] || 'Human session', row.hit ? 'Correct' : 'Incorrect'])));
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
    for (let rank = 1; rank <= 5; rank++) select.append(new Option(rank === 1 ? '1 · Best match' : rank === 5 ? '5 · Weakest match' : String(rank), String(rank)));
    select.addEventListener('change', updateRankProgress);
    if (data.submitted_at) { select.value = String(data.ranking.indexOf(candidate.id) + 1); select.disabled = true; }
    card.append(image, label, select);
    if (data.answer === candidate.id) card.append(element('p', 'Assigned target', 'eyebrow'));
    $('candidates').append(card);
  });
  $('submitRanking').hidden = Boolean(data.submitted_at);
  $('rankingWarning').hidden = Boolean(data.submitted_at);
  $('rankProgress').hidden = Boolean(data.submitted_at);
  updateRankProgress();
  $('judgeOutcome').textContent = data.submitted_at ? `Ranking saved. ${data.hit ? 'Hit: you ranked the assigned scene first.' : 'Miss: you did not rank the assigned scene first.'} A random first choice has a 20% chance of a hit. One result does not establish paranormal ability or AI consciousness. Return to your session to reveal it, or check Dashboard.` : 'The assigned scene is still hidden. Submit your final ranking to see which picture was selected.';
}
function updateRankProgress() {
  const values = [...$('candidates').querySelectorAll('select')].map(select => select.value);
  const used = values.filter(Boolean);
  const duplicates = new Set(used).size !== used.length;
  $('rankProgress').textContent = duplicates ? 'A rank is used more than once. Use each number 1–5 exactly once.' : `${used.length} of 5 pictures ranked. ${used.length === 5 ? 'Review your choices, then submit the final ranking.' : 'Use 1 for the best match and 5 for the weakest.'}`;
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
    drafts.clear();
    for (const id of ['judgingLink', 'sessionFeedback', 'nextTitle', 'nextHelp', 'code', 'phase', 'draftStatus', 'notesHelp', 'experimentModel']) $(id).replaceChildren();
    current = null; judgment = null; selectedModel = ''; modelAvailable = false;
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
$('logout').onclick = () => run(async () => { await api('/api/logout', {}); showLogin(true); location.reload(); });
run(initialize);
