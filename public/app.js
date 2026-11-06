import { $, $$, esc, api, toast, fmtDate, daysSince, relTime, download, copy, slug, form, confirmBox, md, visibleText, readDocument, DOCUMENT_TYPES } from './util.js';
import { columnChart, barList, installTooltips } from './charts.js';
import { refreshLm, mountModelPicker, setLmActive } from './lmstudio.js';
import { refreshEngine, mountEnginePanel, setEngineActive, startSetup, chooseEngine } from './engine.js';
import { checkForUpdate } from './update.js';

const main = $('#main');
const state = { statuses: [], profile: {}, settings: {} };
let pending = null; // prompt to send once a workspace mounts: { threadId, prompt, label, action }

const STATUS_LABEL = { saved: 'Saved', applied: 'Applied', screening: 'Screening', interview: 'Interview', offer: 'Offer', rejected: 'Rejected', ghosted: 'Ghosted', withdrawn: 'Withdrawn' };
const statusColor = (s) => `var(--s-${s})`;
const pill = (s) => `<span class="pill" style="--c:${statusColor(s)}">${esc(STATUS_LABEL[s] || s)}</span>`;
const statusOptions = (cur) => state.statuses.map((s) => `<option value="${s}" ${s === cur ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`).join('');

const DOC_TYPES = [
  { value: 'resume', label: 'Resume' },
  { value: 'cover-letter', label: 'Cover letter' },
  { value: 'email', label: 'Email / message' },
  { value: 'interview', label: 'Interview prep' },
  { value: 'notes', label: 'Notes / analysis' },
  { value: 'other', label: 'Other' },
];
const docTypeLabel = (t) => DOC_TYPES.find((d) => d.value === t)?.label || 'Other';

// ---------- AI quick actions ----------

const JOB_ACTIONS = [
  { group: 'Evaluate' },
  { id: 'fit', label: 'Fit analysis & match score', doc: 'notes',
    prompt: 'Analyze how well my profile fits this job. Start your reply with exactly one line in the form "MATCH SCORE: NN/100" (be realistic, not generous). Then cover:\n1. Strongest matches, with evidence from my resume\n2. Gaps or risks, and how I could address each\n3. Important keywords from the posting missing from my resume\n4. Verdict: should I apply, and what to emphasize' },
  { id: 'keywords', label: 'ATS keyword gap check', doc: 'notes',
    prompt: 'Act as an applicant tracking system. List the most important hard skills, tools, qualifications and phrases from this job description in a table with columns: Keyword | In my resume? (Yes/Partial/No) | Suggested wording I could honestly use. Finish with my estimated keyword coverage as a percentage.' },
  { group: 'Write' },
  { id: 'resume', label: 'Tailor my resume', doc: 'resume',
    prompt: 'Rewrite my resume tailored to this job. Stay truthful: only reorder, rephrase, condense and emphasize my real experience. Mirror the job\'s key terms where they genuinely apply, lead with the most relevant achievements, and quantify impact where my resume supports it. Output the complete resume in Markdown, then a short "What I changed" list after a horizontal rule.' },
  { id: 'cover', label: 'Write a cover letter', doc: 'cover-letter',
    prompt: 'Write a concise, compelling cover letter (250–350 words) for this job. Open with a specific hook about the company or role (not "I am writing to apply"), connect 2–3 of my most relevant achievements to their needs, and close with a confident call to action. Output only the letter.' },
  { id: 'outreach', label: 'Recruiter / LinkedIn message', doc: 'email',
    prompt: 'Write a short LinkedIn connection note (under 300 characters) and a slightly longer InMail/email (under 120 words) to a recruiter or hiring manager for this role. Make them specific and human, not salesy.' },
  { id: 'followup', label: 'Application follow-up email', doc: 'email',
    prompt: 'Write a brief, polite follow-up email to check on my application for this role. Reaffirm one specific reason I am a strong fit. Include a subject line.' },
  { group: 'Prepare' },
  { id: 'interview', label: 'Interview prep', doc: 'interview',
    prompt: 'Prepare me for interviews for this role. Give 10 likely questions (behavioral, technical and role-specific). For each: why they ask it, and a suggested answer outline in STAR format drawn from my real experience. Flag any question where my background is weak and how to handle it.' },
  { id: 'questions', label: 'Questions to ask them', doc: 'interview',
    prompt: 'Suggest 8 insightful questions I should ask the interviewers for this role, grouped by interviewer type (recruiter, hiring manager, team/peer). Each should signal genuine interest and help me evaluate the job.' },
  { id: 'thankyou', label: 'Post-interview thank-you', doc: 'email',
    prompt: 'Write a warm, concise thank-you email to send after an interview for this role. Leave [placeholders] for the interviewer name and one specific topic we discussed. Include a subject line.' },
  { id: 'salary', label: 'Salary & negotiation', doc: 'notes',
    prompt: 'Help me with compensation for this role: estimate a realistic range based on the title, seniority, location and posting (state your uncertainty), then give me a negotiation strategy and exact phrases for responding to "What are your salary expectations?" and for negotiating an offer.' },
];

function generalActions() {
  const s = computeStats(state.jobsCache || []);
  return [
    { group: 'Profile' },
    { id: 'review', label: 'Review my resume', doc: 'notes',
      prompt: 'Review my resume like a senior recruiter. Score it out of 10 and give the top 10 concrete improvements (content, structure, impact, wording), each with a before/after example from my actual resume.' },
    { id: 'resume-general', label: 'Rewrite my base resume', doc: 'resume',
      prompt: 'Rewrite my resume into a strong general-purpose version: clear summary, achievement-focused bullets with action verbs, consistent formatting. Stay truthful and keep [placeholders] for any metrics I should add. Output Markdown.' },
    { id: 'linkedin', label: 'LinkedIn headline & About', doc: 'other',
      prompt: 'Write 3 LinkedIn headline options (under 220 characters) and a LinkedIn About section (around 200 words, first person, conversational) based on my profile.' },
    { id: 'pitch', label: 'Elevator pitch', doc: 'interview',
      prompt: 'Write a 30-second and a 60-second version of my "Tell me about yourself" answer, based on my profile.' },
    { group: 'Strategy' },
    { id: 'prioritize', label: 'Which saved jobs fit best?', doc: 'notes',
      prompt: 'Look at the jobs I am tracking and my profile. Rank the ones that are still open (saved/applied/screening/interview) by how well they fit me and how promising they are, with one sentence of reasoning each, and tell me where to focus my energy this week.' },
    { id: 'plan', label: 'Plan my week', doc: 'notes',
      prompt: `Here are my job search stats: ${s.tracked} jobs tracked, ${s.appliedCount} applications (${s.thisWeek} this week, goal ${state.settings.weeklyGoal}/week), response rate ${pct(s.responseRate)}, interview rate ${pct(s.interviewRate)}, ${s.offers} offers, ${s.followUps.length} applications waiting on a follow-up. Diagnose what is working and what is not, then give me a concrete day-by-day plan for this week.` },
  ];
}

// ---------- stats ----------

const ACTIVE = ['applied', 'screening', 'interview'];
const reached = (j, set) => set.includes(j.status) || (j.history || []).some((h) => set.includes(h.status));
const pct = (x) => (x === null ? '—' : `${Math.round(x * 100)}%`);
const lastChange = (j) => (j.history?.length ? j.history[j.history.length - 1].at : j.createdAt);

function weekStart(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

function computeStats(jobs) {
  const applied = jobs.filter((j) => j.appliedAt || reached(j, ['applied', 'screening', 'interview', 'offer']));
  const responded = applied.filter((j) => reached(j, ['screening', 'interview', 'offer', 'rejected']));
  const interviewed = applied.filter((j) => reached(j, ['interview', 'offer']));
  const offers = jobs.filter((j) => reached(j, ['offer'])).length;

  const responseDays = responded.map((j) => {
    const first = (j.history || []).find((h) => ['screening', 'interview', 'offer', 'rejected'].includes(h.status));
    if (!first || !j.appliedAt) return null;
    return Math.max(0, (new Date(first.at) - new Date(j.appliedAt + 'T00:00:00')) / 86400000);
  }).filter((d) => d !== null);

  const scored = jobs.filter((j) => j.matchScore !== null && j.matchScore !== undefined);

  const thisMonday = weekStart(new Date());
  const weeks = Array.from({ length: 12 }, (_, i) => {
    const start = new Date(thisMonday);
    start.setDate(start.getDate() - (11 - i) * 7);
    return { start, value: 0 };
  });
  for (const j of applied) {
    if (!j.appliedAt) continue;
    const ws = weekStart(new Date(j.appliedAt + 'T12:00:00')).getTime();
    const w = weeks.find((x) => x.start.getTime() === ws);
    if (w) w.value++;
  }

  const followUps = jobs
    .filter((j) => j.status === 'applied' && daysSince(lastChange(j)) >= 7)
    .sort((a, b) => new Date(lastChange(a)) - new Date(lastChange(b)));
  const upcoming = jobs
    .filter((j) => j.nextActionDate && daysSince(j.nextActionDate) >= -7 && !['rejected', 'withdrawn', 'ghosted'].includes(j.status))
    .sort((a, b) => a.nextActionDate.localeCompare(b.nextActionDate));

  return {
    tracked: jobs.length,
    appliedCount: applied.length,
    active: jobs.filter((j) => ACTIVE.includes(j.status)).length,
    responseRate: applied.length ? responded.length / applied.length : null,
    interviewRate: applied.length ? interviewed.length / applied.length : null,
    offers,
    avgResponseDays: responseDays.length ? responseDays.reduce((a, b) => a + b, 0) / responseDays.length : null,
    avgMatch: scored.length ? scored.reduce((a, j) => a + j.matchScore, 0) / scored.length : null,
    byStatus: state.statuses.map((s) => ({ status: s, count: jobs.filter((j) => j.status === s).length })),
    weeks,
    thisWeek: weeks[weeks.length - 1].value,
    followUps,
    upcoming,
  };
}

// ---------- views ----------

async function dashboard() {
  const jobs = await api('/jobs');
  state.jobsCache = jobs;
  const s = computeStats(jobs);
  const goal = state.settings.weeklyGoal || 0;

  if (!jobs.length) {
    main.innerHTML = `
      <div class="page-head"><div><h1>Dashboard</h1><p>Your job search at a glance.</p></div></div>
      <div class="card empty">
        <h2>Let's get your search set up</h2>
        <p>1. Paste your resume into <a href="#/profile">My Profile</a> so the AI knows your background.<br>
        2. ${state.settings.engine === 'lmstudio'
          ? 'Click <strong>Start LM Studio</strong> at the bottom left and load a model.'
          : 'Set up the AI at the bottom left: the built-in AI downloads once and then works offline. (Prefer <a href="https://lmstudio.ai" target="_blank" rel="noopener">LM Studio</a>? Switch in <a href="#/settings">Settings</a>.)'}<br>
        3. <a href="#/jobs/new">Add your first job</a> by pasting its description.</p>
      </div>`;
    return;
  }

  const tile = (k, v, sub = '', extra = '') => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${sub}</div>${extra}</div>`;
  const weekly = s.weeks.map((w, i) => ({
    label: w.start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    value: w.value,
    current: i === s.weeks.length - 1,
    tip: `Week of ${w.start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}: ${w.value} application${w.value === 1 ? '' : 's'}`,
  }));

  const actionItems = [
    ...s.upcoming.map((j) => ({ j, text: `${esc(j.nextAction || 'Next step')} · ${daysSince(j.nextActionDate) > 0 ? '<strong>overdue</strong> ' : ''}${fmtDate(j.nextActionDate)}` })),
    ...s.followUps.filter((j) => !s.upcoming.includes(j)).map((j) => ({ j, text: `Follow up — no update for ${daysSince(lastChange(j))} days` })),
  ].slice(0, 8);

  main.innerHTML = `
    <div class="page-head">
      <div><h1>Dashboard</h1><p>${s.active} active application${s.active === 1 ? '' : 's'} in progress.</p></div>
      <a class="btn primary" href="#/jobs/new">+ Add job</a>
    </div>
    <div class="tiles">
      ${tile('Jobs tracked', s.tracked, `${s.byStatus.find((x) => x.status === 'saved').count} not yet applied`)}
      ${tile('Applications', s.appliedCount, `${s.thisWeek} this week${goal ? ` · goal ${goal}` : ''}`,
        goal ? `<div class="meter" data-tip="${s.thisWeek} of ${goal} this week"><span style="width:${Math.min(100, (s.thisWeek / goal) * 100)}%"></span></div>` : '')}
      ${tile('Response rate', pct(s.responseRate), 'screening, interview, offer or rejection')}
      ${tile('Interview rate', pct(s.interviewRate), 'of applications reached interview')}
      ${tile('Offers', s.offers, s.offers ? '🎉' : 'keep going')}
      ${tile('Avg. days to reply', s.avgResponseDays === null ? '—' : s.avgResponseDays.toFixed(1), 'from applying to first response')}
      ${tile('Avg. match score', s.avgMatch === null ? '—' : Math.round(s.avgMatch), 'from AI fit analyses')}
    </div>
    <div class="grid cols-3">
      <div class="card"><div class="card-head"><h2>Applications per week</h2><span class="muted small">last 12 weeks</span></div>${columnChart(weekly)}</div>
      <div class="card"><h2>Pipeline</h2>${barList(s.byStatus.filter((x) => x.count || ['saved', 'applied', 'interview', 'offer'].includes(x.status))
        .map((x) => ({ label: STATUS_LABEL[x.status], value: x.count, color: statusColor(x.status) })))}</div>
    </div>
    <div class="grid cols-2" style="margin-top:16px">
      <div class="card"><h2>Action items</h2>
        ${actionItems.length ? `<ul class="list-plain">${actionItems.map(({ j, text }) => `
          <li><div style="flex:1;min-width:0"><a href="#/jobs/${j.id}">${esc(j.title || 'Untitled')}</a> <span class="muted">· ${esc(j.company)}</span><div class="small muted">${text}</div></div>${pill(j.status)}</li>`).join('')}</ul>`
          : '<p class="muted">Nothing due. Applications waiting 7+ days and upcoming next steps show up here.</p>'}
      </div>
      <div class="card"><h2>Recently updated</h2>
        <ul class="list-plain">${[...jobs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 6).map((j) => `
          <li><div style="flex:1;min-width:0"><a href="#/jobs/${j.id}">${esc(j.title || 'Untitled')}</a> <span class="muted">· ${esc(j.company)}</span>
          <div class="small muted">${relTime(j.updatedAt)}</div></div>${j.matchScore != null ? `<span class="score small" data-tip="Match score">${j.matchScore}</span>` : ''}${pill(j.status)}</li>`).join('')}</ul>
      </div>
    </div>`;
}

const listState = { q: '', status: 'all', sort: 'updatedAt', dir: -1 };

async function jobsList() {
  const jobs = await api('/jobs');
  state.jobsCache = jobs;
  const counts = Object.fromEntries(state.statuses.map((s) => [s, jobs.filter((j) => j.status === s).length]));

  main.innerHTML = `
    <div class="page-head"><div><h1>Jobs</h1><p>${jobs.length} job${jobs.length === 1 ? '' : 's'} tracked.</p></div>
      <a class="btn primary" href="#/jobs/new">+ Add job</a></div>
    <div class="toolbar">
      <input type="search" id="q" placeholder="Search title, company, tags…" value="${esc(listState.q)}">
      <div class="chips" id="chips">
        <button class="chip ${listState.status === 'all' ? 'on' : ''}" data-s="all">All<span class="c">${jobs.length}</span></button>
        ${state.statuses.filter((s) => counts[s]).map((s) => `<button class="chip ${listState.status === s ? 'on' : ''}" data-s="${s}">${STATUS_LABEL[s]}<span class="c">${counts[s]}</span></button>`).join('')}
      </div>
    </div>
    <div class="card table-wrap" id="table"></div>`;

  const cols = [
    ['title', 'Role'], ['status', 'Status'], ['matchScore', 'Match'], ['appliedAt', 'Applied'], ['updatedAt', 'Updated'], ['documents', 'Docs'],
  ];

  function renderTable() {
    const q = listState.q.toLowerCase();
    let rows = jobs.filter((j) => (listState.status === 'all' || j.status === listState.status) &&
      (!q || [j.title, j.company, j.location, ...(j.tags || [])].join(' ').toLowerCase().includes(q)));
    const key = listState.sort;
    const val = (j) => (key === 'documents' ? j.documents.length : key === 'status' ? state.statuses.indexOf(j.status) : j[key] ?? '');
    rows = rows.sort((a, b) => (val(a) > val(b) ? 1 : val(a) < val(b) ? -1 : 0) * listState.dir);

    $('#table').innerHTML = !jobs.length
      ? `<div class="empty"><h2>No jobs yet</h2><p>Paste a job description to start tracking it.</p><a class="btn primary" href="#/jobs/new">+ Add job</a></div>`
      : !rows.length ? '<div class="empty">No jobs match your filters.</div>'
      : `<table class="list"><thead><tr>${cols.map(([k, l]) => `<th data-k="${k}" class="${['matchScore', 'documents'].includes(k) ? 'num' : ''}">${l}${listState.sort === k ? (listState.dir > 0 ? ' ↑' : ' ↓') : ''}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((j) => `<tr data-id="${j.id}">
          <td><div class="t">${esc(j.title || 'Untitled')}</div><div class="small muted">${esc([j.company, j.location, j.workMode].filter(Boolean).join(' · '))}</div>
            ${(j.tags || []).slice(0, 5).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</td>
          <td>${pill(j.status)}</td>
          <td class="num">${j.matchScore ?? '<span class="muted">—</span>'}</td>
          <td>${j.appliedAt ? fmtDate(j.appliedAt) : '<span class="muted">—</span>'}</td>
          <td class="muted">${relTime(j.updatedAt)}</td>
          <td class="num">${j.documents.length || '<span class="muted">—</span>'}</td></tr>`).join('')}</tbody></table>`;

    $$('#table th').forEach((th) => th.addEventListener('click', () => {
      if (listState.sort === th.dataset.k) listState.dir *= -1;
      else { listState.sort = th.dataset.k; listState.dir = ['title'].includes(th.dataset.k) ? 1 : -1; }
      renderTable();
    }));
    $$('#table tbody tr').forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/jobs/${tr.dataset.id}`; }));
  }

  $('#q').addEventListener('input', (e) => { listState.q = e.target.value; renderTable(); });
  $$('#chips .chip').forEach((c) => c.addEventListener('click', () => {
    listState.status = c.dataset.s;
    $$('#chips .chip').forEach((x) => x.classList.toggle('on', x === c));
    renderTable();
  }));
  renderTable();
}

function jobFields(j = {}) {
  return `
    <label class="field">Job title<input type="text" name="title" value="${esc(j.title)}" required></label>
    <label class="field">Company<input type="text" name="company" value="${esc(j.company)}"></label>
    <label class="field">Location<input type="text" name="location" value="${esc(j.location)}"></label>
    <label class="field">Work mode<select name="workMode">${['', 'remote', 'hybrid', 'onsite'].map((m) => `<option value="${m}" ${j.workMode === m ? 'selected' : ''}>${m ? m[0].toUpperCase() + m.slice(1) : '—'}</option>`).join('')}</select></label>
    <label class="field">Salary<input type="text" name="salary" value="${esc(j.salary)}" placeholder="e.g. €60–70k"></label>
    <label class="field">Seniority<input type="text" name="seniority" value="${esc(j.seniority)}"></label>
    <label class="field">Posting URL<input type="url" name="url" value="${esc(j.url)}" placeholder="https://"></label>
    <label class="field">Source<input type="text" name="source" value="${esc(j.source)}" placeholder="LinkedIn, referral, company site…" list="sources"></label>
    <label class="field">Contact<input type="text" name="contact" value="${esc(j.contact)}" placeholder="Recruiter name / email"></label>
    <label class="field">Applied on<input type="date" name="appliedAt" value="${esc(j.appliedAt)}"></label>
    <label class="field">Match score (0–100)<input type="number" name="matchScore" min="0" max="100" value="${j.matchScore ?? ''}"></label>
    <label class="field">Tags (comma separated)<input type="text" name="tags" value="${esc((j.tags || []).join(', '))}"></label>
    <label class="field">Next action<input type="text" name="nextAction" value="${esc(j.nextAction)}" placeholder="e.g. Prepare for tech interview"></label>
    <label class="field">Next action date<input type="date" name="nextActionDate" value="${esc(j.nextActionDate)}"></label>
    <datalist id="sources"><option>LinkedIn</option><option>Indeed</option><option>Company website</option><option>Referral</option><option>Recruiter</option><option>Glassdoor</option></datalist>`;
}

/*
 * Lets the user fill `textarea` from a PDF / Word / text file, via a file `input` or by dropping
 * the file onto the textarea. Asks before replacing existing text.
 */
function fileImport({ input, textarea, what, onLoaded }) {
  async function load(file) {
    if (!file) return;
    if (textarea.value.trim() && !(await confirmBox(`Replace the current ${what} with the text from "${file.name}"?`, { ok: 'Replace', danger: false }))) return;
    const before = textarea.placeholder;
    textarea.disabled = true;
    textarea.placeholder = `Reading ${file.name}…`;
    try {
      const { text, format } = await readDocument(file);
      textarea.value = text;
      toast(format === 'pdf'
        ? `Loaded ${file.name}. PDFs can lose some formatting, so give it a quick check.`
        : `Loaded ${file.name}`);
      onLoaded?.();
    } catch (e) {
      toast(e.message, true);
    } finally {
      textarea.disabled = false;
      textarea.placeholder = before;
      input.value = '';
    }
  }
  input.accept = DOCUMENT_TYPES;
  input.addEventListener('change', () => load(input.files[0]));
  textarea.addEventListener('dragover', (e) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    textarea.classList.add('drop');
  });
  textarea.addEventListener('dragleave', () => textarea.classList.remove('drop'));
  textarea.addEventListener('drop', (e) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    textarea.classList.remove('drop');
    load(e.dataTransfer.files[0]);
  });
}

function readJobForm(formEl) {
  const data = Object.fromEntries(new FormData(formEl));
  data.tags = String(data.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
  data.matchScore = data.matchScore === '' ? null : Number(data.matchScore);
  return data;
}

function newJob() {
  main.innerHTML = `
    <div class="page-head"><div><h1>Add a job</h1><p>Paste the job description — the AI can fill in the details for you.</p></div></div>
    <form id="job-form" class="grid">
      <div class="card">
        <div class="card-head"><h2>Job description</h2>
          <div class="row"><label class="btn">From a file…<input type="file" id="jd-file" hidden></label>
          <button type="button" class="btn" id="extract">✨ Auto-fill with AI</button></div></div>
        <textarea name="description" class="tall" placeholder="Paste the full job posting here, or drop a PDF / Word file…" autofocus></textarea>
      </div>
      <div class="card">
        <h2>Details</h2>
        <div class="form-grid">
          <label class="field">Status<select name="status">${statusOptions('saved')}</select></label>
          ${jobFields()}
          <label class="field wide">Notes<textarea name="notes" placeholder="Why this role, referral info, anything else…"></textarea></label>
        </div>
      </div>
      <div class="row">
        <button class="btn primary" value="save">Save job</button>
        <button class="btn" value="analyze">Save & run fit analysis</button>
        <a class="btn ghost" href="#/jobs">Cancel</a>
      </div>
    </form>`;

  const f = $('#job-form');
  fileImport({ input: $('#jd-file'), textarea: f.description, what: 'job description' });
  $('#extract').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const description = f.description.value;
    if (!description.trim()) return toast('Paste a job description first', true);
    btn.disabled = true;
    btn.textContent = 'Reading posting…';
    try {
      const x = await api('/llm/extract', { method: 'POST', body: { description } });
      for (const k of ['title', 'company', 'location', 'salary', 'seniority']) if (x[k] && !f[k].value) f[k].value = x[k];
      if (['remote', 'hybrid', 'onsite'].includes(String(x.workMode).toLowerCase()) && !f.workMode.value) f.workMode.value = x.workMode.toLowerCase();
      if (Array.isArray(x.keywords) && !f.tags.value) f.tags.value = x.keywords.slice(0, 10).join(', ');
      toast('Details filled in — review them before saving');
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = '✨ Auto-fill with AI';
    }
  });

  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = readJobForm(f);
    if (!data.title && !data.company) return toast('Give the job at least a title or company', true);
    try {
      const job = await api('/jobs', { method: 'POST', body: data });
      toast('Job saved');
      if (e.submitter?.value === 'analyze') {
        const a = JOB_ACTIONS.find((x) => x.id === 'fit');
        pending = { threadId: job.id, prompt: a.prompt, label: a.label, action: a.id };
        location.hash = `#/jobs/${job.id}/ai`;
      } else {
        location.hash = `#/jobs/${job.id}`;
      }
    } catch (err) { toast(err.message, true); }
  });
}

async function jobDetail(id, tab = 'overview', docId) {
  let job;
  try { job = await api(`/jobs/${id}`); } catch {
    main.innerHTML = '<div class="card empty"><h2>Job not found</h2><a href="#/jobs">Back to jobs</a></div>';
    return;
  }

  const renderHead = () => `
    <div class="job-head">
      <div>
        <a href="#/jobs" class="small" style="text-decoration:none">← All jobs</a>
        <h1 style="margin-top:6px">${esc(job.title || 'Untitled role')}</h1>
        <div class="meta">${esc([job.company, job.location, job.workMode, job.salary].filter(Boolean).join(' · '))}
          ${job.url ? ` · <a href="${esc(job.url)}" target="_blank" rel="noopener">View posting ↗</a>` : ''}</div>
      </div>
      <div class="row">
        ${job.matchScore != null ? `<span class="tile" style="padding:6px 12px" data-tip="AI match score"><span class="k">Match</span> <strong>${job.matchScore}</strong></span>` : ''}
        <select id="status" aria-label="Status">${statusOptions(job.status)}</select>
        <button class="btn ghost danger" id="del" title="Delete job">Delete</button>
      </div>
    </div>
    <nav class="tabs">
      <a href="#/jobs/${id}" class="${tab === 'overview' ? 'active' : ''}">Overview</a>
      <a href="#/jobs/${id}/ai" class="${tab === 'ai' ? 'active' : ''}">AI Workspace${job.chat.length ? ` (${job.chat.length / 2 | 0})` : ''}</a>
      <a href="#/jobs/${id}/docs" class="${tab === 'docs' ? 'active' : ''}">Documents (${job.documents.length})</a>
    </nav>
    <div id="tab"></div>`;

  main.innerHTML = renderHead();
  $('#status').addEventListener('change', async (e) => {
    job = { ...job, ...(await api(`/jobs/${id}`, { method: 'PUT', body: { status: e.target.value } })) };
    toast(`Status: ${STATUS_LABEL[job.status]}`);
    if (tab === 'overview') jobDetail(id, tab);
  });
  $('#del').addEventListener('click', async () => {
    if (!(await confirmBox(`Delete "${job.title || 'this job'}" and all its documents?`))) return;
    await api(`/jobs/${id}`, { method: 'DELETE' });
    toast('Job deleted');
    location.hash = '#/jobs';
  });

  const el = $('#tab');
  if (tab === 'ai') {
    workspace(el, {
      threadId: id,
      actions: JOB_ACTIONS,
      placeholder: `Ask anything about this ${job.title || 'job'} — e.g. "Rewrite my summary for this role" or "What would a typical day look like?"`,
      onReply: async (text, action) => {
        const m = action === 'fit' && text.match(/MATCH SCORE:\s*\**\s*(\d{1,3})/i);
        if (m) {
          await api(`/jobs/${id}`, { method: 'PUT', body: { matchScore: Number(m[1]) } });
          toast(`Match score saved: ${m[1]}/100`);
        }
      },
      onDocSaved: () => { location.hash = `#/jobs/${id}/docs`; },
    });
  } else if (tab === 'docs') {
    documents(el, { threadId: id, docs: job.documents, docId, base: `#/jobs/${id}/docs`, aiHash: `#/jobs/${id}/ai`, context: job });
  } else {
    overview(el, job);
  }
}

function overview(el, job) {
  el.innerHTML = `
    <form id="ov" class="grid cols-3">
      <div class="grid">
        <div class="card"><h2>Job description</h2><textarea name="description" class="tall">${esc(job.description)}</textarea></div>
        <div class="card"><h2>Notes</h2><textarea name="notes" placeholder="Interview notes, people you talked to, impressions…">${esc(job.notes)}</textarea></div>
      </div>
      <div class="grid" style="align-content:start">
        <div class="card"><h2>Details</h2><div class="grid">${jobFields(job)}</div>
          <div class="row" style="margin-top:14px"><button class="btn primary" id="save">Save changes</button><span class="muted small" id="dirty"></span></div></div>
        <div class="card"><h2>Timeline</h2><ul class="timeline">
          <li><span>Added</span><span class="muted">${fmtDate(job.createdAt)}</span></li>
          ${(job.history || []).slice(1).map((h) => `<li><span>${pill(h.status)}</span><span class="muted">${fmtDate(h.at)}</span></li>`).join('')}
        </ul></div>
      </div>
    </form>`;
  const f = $('#ov');
  f.addEventListener('input', () => { $('#dirty').textContent = 'Unsaved changes'; });
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`/jobs/${job.id}`, { method: 'PUT', body: readJobForm(f) });
      toast('Saved');
      jobDetail(job.id, 'overview');
    } catch (err) { toast(err.message, true); }
  });
}

// ---------- AI workspace (chat + quick actions) ----------

async function workspace(el, { threadId, actions, placeholder, onReply, onDocSaved }) {
  const { chat } = await api(`/threads/${threadId}`);
  let busy = null; // AbortController while streaming

  el.innerHTML = `
    <div class="workspace">
      <div class="card chat">
        <div class="messages" id="messages"></div>
        <form class="composer" id="composer">
          <textarea name="prompt" rows="2" placeholder="${esc(placeholder)}"></textarea>
          <div class="grid" style="gap:6px">
            <button class="btn primary" id="send">Send</button>
            <button type="button" class="btn sm ghost" id="clear" title="Clear conversation">Clear</button>
          </div>
        </form>
      </div>
      <aside class="card quick">
        ${actions.map((a) => (a.group ? `<h3>${esc(a.group)}</h3>` : `<button class="btn" data-a="${a.id}">${esc(a.label)}</button>`)).join('')}
        <p class="small muted" style="margin:8px 0 0">Your profile${threadId === 'general' ? ' and tracked jobs are' : ' and this job description are'} sent to the model automatically.</p>
      </aside>
    </div>`;

  const box = $('#messages', el);
  const composer = $('#composer', el);
  const ta = composer.prompt;

  function msgActions(text, action) {
    const wrap = document.createElement('div');
    wrap.className = 'actions';
    wrap.innerHTML = `<button class="btn sm ghost" data-x="copy">Copy</button><button class="btn sm ghost" data-x="save">Save as document</button>`;
    wrap.addEventListener('click', async (e) => {
      const x = e.target.dataset.x;
      if (x === 'copy') copy(text);
      if (x === 'save') {
        const a = actions.find((y) => y.id === action);
        const vals = await form('Save as document', [
          { name: 'title', label: 'Title', value: a ? a.label.replace(/^(Write a |Tailor my )/i, '') : 'AI answer', required: true },
          { name: 'type', label: 'Type', type: 'select', value: a?.doc || 'other', options: DOC_TYPES },
        ]);
        if (!vals) return;
        await api(`/threads/${threadId}/documents`, { method: 'POST', body: { ...vals, content: text } });
        toast('Document saved');
        onDocSaved?.();
      }
    });
    return wrap;
  }

  function addMessage(m) {
    const div = document.createElement('div');
    div.className = `msg ${m.role}`;
    if (m.role === 'user') {
      div.textContent = m.label ? `⚡ ${m.label}` : m.content;
      if (!m.label && m.content.length > 400) {
        div.classList.add('collapsed');
        div.title = 'Click to expand';
        div.addEventListener('click', () => div.classList.remove('collapsed'), { once: true });
      }
    } else {
      div.innerHTML = `<div class="body md">${md(m.content)}</div>`;
      div.append(msgActions(m.content, m.action));
    }
    box.append(div);
    return div;
  }

  function renderAll() {
    box.innerHTML = chat.length ? '' : `<div class="empty"><h2>How can I help?</h2><p>Pick a quick action on the right or ask your own question.</p></div>`;
    chat.forEach(addMessage);
    box.scrollTop = box.scrollHeight;
  }

  async function send(prompt, { label = null, action = null } = {}) {
    if (busy) return;
    if (!chat.length) box.innerHTML = '';
    chat.push({ role: 'user', content: prompt, label });
    addMessage(chat[chat.length - 1]);
    const out = document.createElement('div');
    out.className = 'msg assistant';
    out.innerHTML = '<div class="body md"><span class="thinking">Thinking…</span></div>';
    box.append(out);
    box.scrollTop = box.scrollHeight;
    const body = $('.body', out);

    busy = new AbortController();
    $('#send', el).textContent = 'Stop';
    let raw = '';
    let frame = 0;
    const paint = () => {
      frame = 0;
      const v = visibleText(raw);
      const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
      body.innerHTML = v.text ? md(v.text) : '<span class="thinking">Thinking…</span>';
      if (v.thinking && v.text) body.insertAdjacentHTML('beforeend', '<p class="thinking">Thinking…</p>');
      if (nearBottom) box.scrollTop = box.scrollHeight;
    };
    try {
      const res = await fetch('/api/llm/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId, prompt, label, action }),
        signal: busy.signal,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Error ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        raw += dec.decode(value, { stream: true });
        if (!frame) frame = requestAnimationFrame(paint);
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        body.innerHTML = `<p><strong>Couldn't get a reply.</strong> ${esc(err.message)}</p>`;
        chat.pop();
        busy = null;
        $('#send', el).textContent = 'Send';
        return;
      }
    }
    cancelAnimationFrame(frame);
    paint();
    const text = visibleText(raw).text.trim();
    busy = null;
    $('#send', el).textContent = 'Send';
    if (!text) { chat.pop(); return; }
    chat.push({ role: 'assistant', content: text, action });
    out.append(msgActions(text, action));
    onReply?.(text, action);
  }

  composer.addEventListener('submit', (e) => {
    e.preventDefault();
    if (busy) { busy.abort(); return; }
    const p = ta.value.trim();
    if (!p) return;
    ta.value = '';
    send(p);
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!busy) composer.requestSubmit(); }
  });
  $('#clear', el).addEventListener('click', async () => {
    if (!chat.length || !(await confirmBox('Clear this conversation? Saved documents are kept.', { ok: 'Clear' }))) return;
    await api(`/threads/${threadId}/chat`, { method: 'DELETE' });
    chat.length = 0;
    renderAll();
  });
  $$('[data-a]', el).forEach((b) => b.addEventListener('click', () => {
    const a = actions.find((x) => x.id === b.dataset.a);
    send(a.prompt, { label: a.label, action: a.id });
  }));

  renderAll();
  if (pending?.threadId === threadId) {
    const p = pending;
    pending = null;
    send(p.prompt, p);
  } else {
    ta.focus();
  }
}

// ---------- documents ----------

function printDoc(title, content) {
  const w = window.open('', '_blank');
  if (!w) return toast('Allow pop-ups to print', true);
  w.document.write(`<!doctype html><html><head><title>${esc(title)}</title><style>
    body{font:11pt/1.45 Calibri,"Segoe UI",Arial,sans-serif;max-width:720px;margin:40px auto;color:#111;padding:0 24px}
    h3{font-size:18pt;margin:0 0 4pt}h4{font-size:12.5pt;margin:14pt 0 4pt;border-bottom:1px solid #999}h5,h6{font-size:11pt;margin:10pt 0 2pt}
    ul{margin:4pt 0;padding-left:18pt}p{margin:0 0 6pt}table{border-collapse:collapse}td,th{border:1px solid #bbb;padding:3pt 6pt}a{color:#111}
    </style></head><body>${md(content)}</body></html>`);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 200);
}

function documents(el, { threadId, docs, docId, base, aiHash, context }) {
  const doc = docs.find((d) => d.id === docId) || docs[0];
  if (!docs.length) {
    el.innerHTML = `<div class="card empty"><h2>No documents yet</h2>
      <p>Generate a resume, cover letter or anything else in the AI Workspace, then click "Save as document".</p>
      <div class="row" style="justify-content:center"><a class="btn primary" href="${aiHash}">Open AI Workspace</a><button class="btn" id="blank">Write one manually</button></div></div>`;
    $('#blank', el).addEventListener('click', newBlank);
    return;
  }

  async function newBlank() {
    const vals = await form('New document', [
      { name: 'title', label: 'Title', value: '', required: true },
      { name: 'type', label: 'Type', type: 'select', value: 'other', options: DOC_TYPES },
    ], { submit: 'Create' });
    if (!vals) return;
    const d = await api(`/threads/${threadId}/documents`, { method: 'POST', body: { ...vals, content: '' } });
    location.hash = `${base}/${d.id}`;
  }

  el.innerHTML = `
    <div class="docs">
      <div class="card doc-list">
        ${docs.map((d) => `<a href="${base}/${d.id}" class="${d.id === doc.id ? 'active' : ''}"><div>${esc(d.title)}</div><div class="dt">${docTypeLabel(d.type)} · ${relTime(d.updatedAt)}</div></a>`).join('')}
        <button class="btn ghost block" id="blank" style="margin-top:6px">+ New document</button>
      </div>
      <div class="card">
        <div class="row" style="margin-bottom:12px">
          <input type="text" id="d-title" value="${esc(doc.title)}" style="flex:1;min-width:200px;font-weight:600">
          <select id="d-type" style="width:auto">${DOC_TYPES.map((t) => `<option value="${t.value}" ${t.value === doc.type ? 'selected' : ''}>${t.label}</option>`).join('')}</select>
        </div>
        <div class="row no-print" style="margin-bottom:12px">
          <button class="btn sm" id="mode">Edit</button>
          <button class="btn sm primary" id="d-save" hidden>Save</button>
          <span class="spacer"></span>
          <button class="btn sm ghost" id="d-copy">Copy</button>
          <button class="btn sm ghost" id="d-dl">Download .md</button>
          <button class="btn sm ghost" id="d-print">Print / PDF</button>
          <button class="btn sm ghost danger" id="d-del">Delete</button>
        </div>
        <div id="d-view" class="md doc-preview">${md(doc.content) || '<p class="muted">Empty document. Click Edit to write.</p>'}</div>
        <textarea id="d-edit" class="tall mono" hidden>${esc(doc.content)}</textarea>
        <div class="no-print" style="margin-top:16px;border-top:1px solid var(--border);padding-top:14px">
          <label class="field">Ask the AI to revise this document
            <div class="row" style="flex-wrap:nowrap"><input type="text" id="d-ai" placeholder='e.g. "Make it shorter and more confident" or "Emphasize leadership"'>
            <button class="btn" id="d-ai-go">Revise</button></div></label>
        </div>
      </div>
    </div>`;

  const view = $('#d-view', el);
  const edit = $('#d-edit', el);
  let editing = false;
  const current = () => (editing ? edit.value : doc.content);

  const save = async () => {
    const body = { title: $('#d-title', el).value, type: $('#d-type', el).value, content: current() };
    Object.assign(doc, await api(`/threads/${threadId}/documents/${doc.id}`, { method: 'PUT', body }));
    toast('Document saved');
  };

  $('#mode', el).addEventListener('click', () => {
    editing = !editing;
    if (!editing) { doc.content = edit.value; view.innerHTML = md(doc.content); }
    view.hidden = editing;
    edit.hidden = !editing;
    $('#d-save', el).hidden = !editing;
    $('#mode', el).textContent = editing ? 'Preview' : 'Edit';
    if (editing) edit.focus();
  });
  $('#d-save', el).addEventListener('click', save);
  $('#d-title', el).addEventListener('change', save);
  $('#d-type', el).addEventListener('change', save);
  $('#d-copy', el).addEventListener('click', () => copy(current()));
  $('#d-dl', el).addEventListener('click', () => download(`${slug([context?.company, $('#d-title', el).value].filter(Boolean).join(' '))}.md`, current()));
  $('#d-print', el).addEventListener('click', () => printDoc($('#d-title', el).value, current()));
  $('#d-del', el).addEventListener('click', async () => {
    if (!(await confirmBox(`Delete "${doc.title}"?`))) return;
    await api(`/threads/${threadId}/documents/${doc.id}`, { method: 'DELETE' });
    toast('Document deleted');
    if (location.hash === base) route();
    else location.hash = base;
  });
  $('#blank', el).addEventListener('click', newBlank);
  const revise = () => {
    const instr = $('#d-ai', el).value.trim();
    if (!instr) return toast('Describe how to revise it', true);
    pending = {
      threadId,
      label: `Revise "${$('#d-title', el).value}": ${instr}`,
      action: null,
      prompt: `Revise the following ${docTypeLabel(doc.type).toLowerCase()} according to this instruction: ${instr}\n\nReturn the full revised document only.\n\n---\n${current()}`,
    };
    location.hash = aiHash;
  };
  $('#d-ai-go', el).addEventListener('click', revise);
  $('#d-ai', el).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); revise(); } });
}

// ---------- general assistant ----------

async function assistant(tab = 'chat', docId) {
  const [{ documents: docs }, jobs] = await Promise.all([api('/threads/general'), api('/jobs')]);
  state.jobsCache = jobs;
  main.innerHTML = `
    <div class="page-head"><div><h1>AI Assistant</h1><p>General career help — not tied to a single job. Uses your profile and the jobs you're tracking.</p></div></div>
    <nav class="tabs">
      <a href="#/assistant" class="${tab === 'chat' ? 'active' : ''}">Chat</a>
      <a href="#/assistant/docs" class="${tab === 'docs' ? 'active' : ''}">Documents (${docs.length})</a>
    </nav>
    <div id="tab"></div>`;
  const el = $('#tab');
  if (tab === 'docs') documents(el, { threadId: 'general', docs, docId, base: '#/assistant/docs', aiHash: '#/assistant' });
  else workspace(el, {
    threadId: 'general',
    actions: generalActions(),
    placeholder: 'Ask anything — resume tips, career change advice, how to explain a gap…',
    onDocSaved: () => { location.hash = '#/assistant/docs'; },
  });
}

// ---------- profile & settings ----------

function profile() {
  const p = state.profile;
  main.innerHTML = `
    <div class="page-head"><div><h1>My Profile</h1><p>Everything here is given to the AI as context for every request. More detail = better results.</p></div></div>
    <form id="pf" class="grid">
      <div class="card"><div class="form-grid">
        <label class="field">Full name<input type="text" name="name" value="${esc(p.name)}"></label>
        <label class="field">Headline / target role<input type="text" name="headline" value="${esc(p.headline)}" placeholder="e.g. Senior Data Engineer moving into ML"></label>
      </div></div>
      <div class="card">
        <div class="card-head"><h2>Resume</h2>
          <label class="btn sm">Load from PDF or Word…<input type="file" id="file" hidden></label></div>
        <textarea name="resume" class="tall mono" placeholder="Click &quot;Load from PDF or Word…&quot;, drop your resume file here, or paste it as text.">${esc(p.resume)}</textarea>
      </div>
      <div class="grid cols-2">
        <div class="card"><h2>Additional background</h2>
          <textarea name="about" rows="8" placeholder="Achievements not on your resume, metrics, projects, what you want next, deal-breakers, visa status, preferred locations…">${esc(p.about)}</textarea></div>
        <div class="card"><h2>Writing style</h2>
          <textarea name="style" rows="8" placeholder="e.g. British English, concise, warm but professional, avoid buzzwords, one-page resume…">${esc(p.style)}</textarea></div>
      </div>
      <div class="row"><button class="btn primary">Save profile</button><span class="muted small" id="dirty"></span></div>
    </form>`;
  const f = $('#pf');
  f.addEventListener('input', () => { $('#dirty').textContent = 'Unsaved changes'; });
  fileImport({
    input: $('#file'),
    textarea: f.resume,
    what: 'resume',
    onLoaded: () => { $('#dirty').textContent = 'Unsaved changes. Click Save profile'; },
  });
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    state.profile = await api('/profile', { method: 'PUT', body: Object.fromEntries(new FormData(f)) });
    $('#dirty').textContent = '';
    toast('Profile saved');
  });
}

async function settings() {
  const s = state.settings;
  main.innerHTML = `
    <div class="page-head"><div><h1>Settings</h1></div></div>
    <form id="sf" class="grid" style="max-width:760px">
      <div class="card">
        <h2>AI</h2>
        <div class="segmented" role="radiogroup" aria-label="How the AI runs">
          <label><input type="radio" name="engine" value="builtin" ${s.engine === 'builtin' ? 'checked' : ''}><span>Built-in AI</span></label>
          <label><input type="radio" name="engine" value="lmstudio" ${s.engine === 'lmstudio' ? 'checked' : ''}><span>LM Studio</span></label>
        </div>
        ${s.engine === 'builtin' ? `
          <p class="small muted">Runs a model that comes with the app, with nothing else to install.</p>
          <div class="lm-panel" id="engine-settings"></div>`
        : s.engine === 'lmstudio' ? `
          <p class="small muted">Uses your own <a href="https://lmstudio.ai" target="_blank" rel="noopener">LM Studio</a> app and any model you've downloaded in it.</p>
          <div class="form-grid">
            <label class="field wide">Server URL
              <div class="row" style="flex-wrap:nowrap"><input type="text" name="lmUrl" value="${esc(s.lmUrl)}" placeholder="http://localhost:1234"><button type="button" class="btn" id="save-url">Apply</button></div></label>
            <div class="field wide">Model<div class="lm-panel" id="lm-settings"></div></div>
          </div>
          <p class="small muted">"Start LM Studio" starts its local server, opening the LM Studio app if needed. "Load model" unloads other models first to free memory.
            Use <em>Custom model ID…</em> for any model identifier LM Studio accepts.</p>`
        : '<p class="small muted">Pick how the AI should run. Both are free and stay on this computer.</p>'}
        <h3 style="margin-top:18px">Options for both</h3>
        <div class="form-grid">
          <label class="field">Context length (0 = default, 8k for the built-in AI)<input type="number" name="contextLength" min="0" step="1024" value="${s.contextLength}"></label>
          <label class="field">Temperature<input type="number" name="temperature" step="0.1" min="0" max="2" value="${s.temperature}"></label>
          <label class="field">Max reply tokens (0 = model default)<input type="number" name="maxTokens" min="0" step="256" value="${s.maxTokens}"></label>
          <label class="field">Chat memory (messages)<input type="number" name="historyLimit" min="0" max="50" value="${s.historyLimit}"></label>
        </div>
        <p class="small muted">A resume plus a job description needs a context length of 8k tokens or more. Longer contexts use more memory.</p>
      </div>
      <div class="card"><h2>Goals</h2>
        <div class="form-grid"><label class="field">Weekly application goal<input type="number" name="weeklyGoal" min="0" value="${s.weeklyGoal}"></label></div></div>
      <div class="row"><button class="btn primary">Save settings</button></div>
      <div class="card"><h2>Updates</h2>
        <p class="small muted" style="margin-top:0">You have version ${esc(state.version)}. Updates are free and come from the app's GitHub page. Checking only asks GitHub for the latest version number; none of your data is sent.</p>
        <div class="row">
          <button type="button" class="btn" id="check-updates">Check for updates</button>
          <label class="row small" style="gap:6px"><input type="checkbox" id="auto-updates" ${s.checkUpdates ? 'checked' : ''}> Check automatically when the app starts</label>
        </div>
      </div>
      <div class="card"><h2>Your data</h2>
        <p class="small muted" style="margin-top:0">${state.customDataDir ? 'Saved in the folder you chose' : 'Saved on this computer'}: <code>${esc(state.dataDir)}</code>.
          Updating the app keeps your data, and a copy from before each update is kept in the same folder.</p>
        <p class="small muted">To use the same data on more than one computer, put it in a folder that OneDrive, Google Drive or Dropbox keeps in sync,
          and choose that folder on each computer. Use the app on one computer at a time: close it on one before opening it on the other.</p>
        <div class="row"><button type="button" class="btn" id="change-folder">Change folder…</button>
          ${state.customDataDir ? '<button type="button" class="btn ghost" id="default-folder">Back to this computer only</button>' : ''}
          <button type="button" class="btn ghost" id="open-folder">Open data folder</button></div>
        <div class="row" style="margin-top:10px"><button type="button" class="btn" id="export">Export JSON</button>
          <label class="btn">Import JSON…<input type="file" id="import" accept=".json,application/json" hidden></label></div>
      </div>
      <div class="card"><h2>About</h2>
        <p class="small muted" style="margin-top:0">Job Search Dashboard ${esc(state.version)} · Copyright 2026 Francesco Strafforello.
          Free and open source under the <a href="https://www.apache.org/licenses/LICENSE-2.0" target="_blank" rel="noopener">Apache License 2.0</a>.
          Source code: <a href="https://github.com/fstrafforello/job-search" target="_blank" rel="noopener">github.com/fstrafforello/job-search</a>.</p>
        <p class="small muted">It includes the Node.js runtime, mammoth (Word files) and pdf.js through unpdf (PDF files), each under its own licence.</p>
        <div class="row"><a class="btn ghost" href="/third-party-licenses.txt" target="_blank" rel="noopener">View all licences</a></div>
      </div>
    </form>`;

  const f = $('#sf');
  f.querySelectorAll('input[name="engine"]').forEach((r) => r.addEventListener('change', () => switchEngine(r.value).then(settings)));
  if (s.engine === 'builtin') {
    mountEnginePanel($('#engine-settings'), {
      getSettings: () => state.settings,
      onPickModel: async (builtinModel) => {
        state.settings = await api('/settings', { method: 'PUT', body: { builtinModel } });
        refreshEngine();
      },
      onGpuChange: async (on) => {
        state.settings = await api('/settings', { method: 'PUT', body: { builtinGpu: on } });
        toast(on ? 'The AI will use the graphics card when possible' : 'The AI will run on the CPU only');
        refreshEngine();
      },
    });
  }
  if (s.engine === 'lmstudio') {
    mountModelPicker($('#lm-settings'), modelBinding);
    $('#save-url').addEventListener('click', async () => {
      state.settings = await api('/settings', { method: 'PUT', body: { lmUrl: f.lmUrl.value } });
      toast('Server URL saved');
      refreshLm();
    });
  }
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(f));
    delete body.builtinGpu; // saved when ticked; an unticked box isn't in the form data
    state.settings = await api('/settings', { method: 'PUT', body });
    toast('Settings saved');
    if (state.settings.engine === 'lmstudio') refreshLm(); else refreshEngine();
  });
  $('#check-updates').addEventListener('click', () => checkForUpdate({ force: true, quiet: false }));
  $('#auto-updates').addEventListener('change', async (e) => {
    state.settings = await api('/settings', { method: 'PUT', body: { checkUpdates: e.target.checked } });
    toast(e.target.checked ? 'Will check for updates automatically' : 'Automatic update checks turned off');
  });
  $('#open-folder').addEventListener('click', () => api('/open-data-folder', { method: 'POST' }));
  $('#change-folder').addEventListener('click', () => changeDataFolder());
  $('#default-folder')?.addEventListener('click', async () => {
    const { default: dir } = await api('/data-folder');
    changeDataFolder(dir);
  });
  $('#export').addEventListener('click', async () => {
    download(`job-search-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(await api('/export'), null, 2), 'application/json');
  });
  $('#import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!(await confirmBox('Replace ALL current data with this backup?', { ok: 'Replace' }))) return;
    try {
      const r = await api('/import', { method: 'POST', body: JSON.parse(await file.text()) });
      toast(`Imported ${r.jobs} jobs`);
      await boot();
      mountAiSidebar();
    } catch (err) { toast(err.message, true); }
  });
}

// Shows a dialog with the given buttons ([value, label, primary?]) and resolves with the clicked value ('' if dismissed).
function ask(html, buttons) {
  const dlg = $('#dialog');
  dlg.innerHTML = `<form method="dialog">${html}<div class="row">${buttons.map(([v, label, primary]) =>
    `<button class="btn ${primary ? 'primary' : ''}" value="${esc(v)}">${esc(label)}</button>`).join('')}</div></form>`;
  dlg.onclose = null;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((r) => dlg.addEventListener('close', () => r(dlg.returnValue), { once: true }));
}

// Moves the data to another folder, or switches to the data already there (e.g. synced from another computer).
// `preset` skips the folder question (used by "Back to this computer only").
async function changeDataFolder(preset) {
  let dir = preset;
  if (!dir) {
    const info = await api('/data-folder');
    const dlg = $('#dialog');
    dlg.innerHTML = `<form method="dialog"><h2>Where should your data be kept?</h2>
      <p class="small muted" style="margin-top:0">To use the same data on several computers, pick a folder that OneDrive, Google Drive or Dropbox keeps in sync, then pick the same folder on the other computers.</p>
      ${info.suggestions.length ? `<div class="row" style="gap:6px;margin-bottom:10px;justify-content:flex-start"><span class="small muted">Synced folders on this computer:</span>${info.suggestions.map((s) =>
        `<button type="button" class="chip" data-dir="${esc(s.dir)}">${esc(s.label)}</button>`).join('')}</div>` : ''}
      <label class="field">Folder
        <div class="row" style="flex-wrap:nowrap"><input type="text" name="dir" value="${esc(info.current)}" spellcheck="false"><button type="button" class="btn" id="browse">Browse…</button></div></label>
      <div class="row"><button class="btn" value="cancel">Cancel</button><button class="btn primary" value="ok">Continue</button></div></form>`;
    const input = $('input[name="dir"]', dlg);
    dlg.querySelectorAll('[data-dir]').forEach((b) => b.addEventListener('click', () => { input.value = b.dataset.dir; }));
    $('#browse', dlg).addEventListener('click', async () => {
      try {
        const r = await api('/pick-folder', { method: 'POST' });
        if (r.dir) input.value = r.dir;
      } catch (e) { toast(e.message, true); }
    });
    dlg.onclose = null;
    dlg.returnValue = '';
    dlg.showModal();
    await new Promise((r) => dlg.addEventListener('close', r, { once: true }));
    if (dlg.returnValue !== 'ok') return;
    dir = input.value;
  }

  let check;
  try {
    check = await api('/data-folder/check', { method: 'POST', body: { dir } });
  } catch (e) { toast(e.message, true); return; }
  if (check.same) { toast('That is already your data folder'); return; }

  let mode;
  if (check.existing?.unreadable) {
    mode = await ask(`<h2>That folder has a data file the app can't read</h2>
      <p>Replace it with the data on this computer? The old file is kept next to it as a copy.</p>`,
    [['', 'Cancel'], ['move', 'Replace it', true]]);
  } else if (check.existing) {
    const n = check.existing.jobs;
    mode = await ask(`<h2>That folder already has Job Search data</h2>
      <p><strong>${n} job${n === 1 ? '' : 's'}</strong>, last changed ${esc(fmtDate(check.existing.modified))}. It may come from another computer.</p>
      <p class="small muted">"Use that data" shows the data from that folder here. Your data on this computer stays where it is, untouched.
        "Replace it" overwrites that folder's data with this computer's (a copy of the old file is kept).</p>`,
    [['', 'Cancel'], ['move', "Replace it with this computer's data"], ['use', 'Use that data', true]]);
  } else {
    mode = await ask(`<h2>Move your data?</h2><p>Your jobs, documents and settings will be saved in <code>${esc(check.dir)}</code> from now on.</p>
      <p class="small muted">The current file stays where it is as a backup.</p>`,
    [['', 'Cancel'], ['move', 'Move my data', true]]);
  }
  if (!mode) return;
  try {
    await api('/data-folder', { method: 'POST', body: { dir: check.dir, mode } });
  } catch (e) { toast(e.message, true); return; }
  toast(mode === 'use' ? 'Now using the data in that folder' : 'Your data is now saved in that folder');
  await boot();
  mountAiSidebar();
}

// Warnings about where the data is, shown once when the app opens.
function showDataNotices() {
  if (state.locationProblem) {
    ask(`<h2>Your data folder isn't available</h2>
      <p><code>${esc(state.locationProblem)}</code> can't be reached. Is the drive connected and OneDrive / Google Drive / Dropbox running?</p>
      <p class="small muted">For now the app shows the data saved on this computer, and changes are saved there. Restart the app once the folder is back.</p>`,
    [['ok', 'OK', true]]);
  } else if (state.openElsewhere) {
    ask(`<h2>This data is open on another computer</h2>
      <p>It looks like the app is also open on <strong>${esc(state.openElsewhere)}</strong>. Close it there first: if both make changes at the same time, some changes can be lost.</p>`,
    [['ok', 'OK', true]]);
  }
}

// ---------- shell ----------

// The sidebar's AI panel follows the chosen engine; only that engine's status is polled.
function mountAiSidebar() {
  const el = $('#ai-sidebar');
  const engine = state.settings.engine;
  $('#ai-title').textContent = engine === 'builtin' ? 'Built-in AI' : engine === 'lmstudio' ? 'LM Studio' : 'AI';
  setEngineActive(engine === 'builtin');
  setLmActive(engine === 'lmstudio');
  if (engine === 'builtin') mountEnginePanel(el, { getSettings: () => state.settings, compact: true });
  else if (engine === 'lmstudio') mountModelPicker(el, { ...modelBinding, compact: true });
  else {
    el.innerHTML = `<div class="lm-job">Choose how the AI runs to use the AI features.</div>
      <div class="lm-actions"><button class="btn sm primary" id="choose-ai">Set up AI</button></div>`;
    $('#choose-ai', el).addEventListener('click', () => askEngine());
  }
}

async function switchEngine(engine) {
  state.settings = await api('/settings', { method: 'PUT', body: { engine } });
  mountAiSidebar();
  if (engine === 'builtin') {
    const s = await refreshEngine();
    const model = s?.models.find((m) => m.id === state.settings.builtinModel);
    if (s?.supported && (!s.runtime || !model?.installed) && s.download?.state !== 'running') startSetup();
  }
}

async function askEngine() {
  const choice = await chooseEngine({ current: state.settings.engine });
  if (!choice) return;
  await switchEngine(choice);
  toast(choice === 'builtin' ? 'Setting up the built-in AI. You can keep working while it downloads.' : 'Using LM Studio. Start it from the sidebar.');
  if (location.hash === '#/settings') settings();
}

// Shared by the sidebar and Settings pickers; both re-render from the same LM Studio state.
const modelBinding = {
  getModel: () => state.settings.model || '',
  setModel: async (model) => {
    state.settings = await api('/settings', { method: 'PUT', body: { model } });
    refreshLm();
  },
};

const ROUTES = [
  [/^#\/jobs\/new$/, () => newJob()],
  [/^#\/jobs\/([^/]+)(?:\/(ai|docs))?(?:\/([^/]+))?$/, (m) => jobDetail(m[1], m[2] || 'overview', m[3])],
  [/^#\/jobs$/, () => jobsList()],
  [/^#\/assistant(?:\/(docs))?(?:\/([^/]+))?$/, (m) => assistant(m[1] ? 'docs' : 'chat', m[2])],
  [/^#\/profile$/, () => profile()],
  [/^#\/settings$/, () => settings()],
  [/^.*$/, () => dashboard()],
];

async function route() {
  const hash = location.hash || '#/dashboard';
  const section = hash.split('/')[1] || 'dashboard';
  $$('.sidebar nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === section));
  for (const [re, fn] of ROUTES) {
    const m = hash.match(re);
    if (m) {
      try { await fn(m); } catch (e) { main.innerHTML = `<div class="card empty"><h2>Something went wrong</h2><p>${esc(e.message)}</p></div>`; }
      break;
    }
  }
  main.focus({ preventScroll: true });
}

async function boot() {
  const b = await api('/bootstrap');
  Object.assign(state, { statuses: b.statuses, profile: b.profile, settings: b.settings, jobsCache: b.jobs, version: b.version, dataDir: b.dataDir, recovery: b.recovery,
    customDataDir: b.customDataDir, locationProblem: b.locationProblem, openElsewhere: b.openElsewhere });
  $('#app-version').textContent = `v${b.version}`;
  await route();
}

// Keeps the app running while this page is open (it quits when its window closes),
// and tells the user if the app has stopped behind an open page.
function keepAlive() {
  const es = new EventSource('/api/alive');
  let lost = null;
  es.onopen = () => { clearTimeout(lost); $('#closed').hidden = true; };
  // A sync client (OneDrive, Google Drive…) brought in changes from another computer.
  es.addEventListener('data-changed', async () => {
    await boot();
    toast('Updated with changes from another computer');
  });
  es.onerror = () => {
    clearTimeout(lost);
    lost = setTimeout(() => { if (!document.body.dataset.updating) $('#closed').hidden = false; }, 8000);
  };
}

function showRecoveryNotice(r) {
  const dlg = $('#dialog');
  dlg.innerHTML = `<form method="dialog"><h2>Your data was restored from a backup</h2>
    <p>${r.restored
      ? `The data file was damaged, so the copy saved on ${esc(fmtDate(r.backupDate))} was restored. Changes made after that may be missing.`
      : 'The data file was damaged and no backup was available, so the app started empty.'}</p>
    <p class="small muted">The damaged file was kept as <code>${esc(r.damaged)}</code>.</p>
    <div class="row"><button class="btn primary" value="ok">OK</button></div></form>`;
  dlg.onclose = null;
  dlg.showModal();
}

installTooltips();
window.addEventListener('hashchange', route);
boot().then(() => {
  mountAiSidebar();
  keepAlive();
  if (state.recovery) showRecoveryNotice(state.recovery);
  else if (state.locationProblem || state.openElsewhere) showDataNotices();
  else if (!state.settings.engine) askEngine();
  if (state.settings.checkUpdates) {
    checkForUpdate();
    setInterval(() => { if (state.settings.checkUpdates) checkForUpdate(); }, 6 * 60 * 60 * 1000);
  }
});
