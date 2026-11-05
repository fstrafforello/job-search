// Thin client for LM Studio's OpenAI-compatible server (default http://localhost:1234/v1).
import { serverModels } from './lms.js';

const SYSTEM_BASE = `You are an expert career coach, recruiter and professional resume writer helping the user with their job search.
Rules:
- Be specific, practical and honest. Tailor everything to the target job when one is given.
- Never invent employers, job titles, degrees, certifications, dates or metrics the candidate does not have. If something useful is missing, say so or insert a clearly marked [placeholder].
- Prefer strong action verbs and quantified impact drawn from the candidate's real experience.
- Format answers in Markdown. When asked for a document (resume, cover letter, email), output only the document unless asked otherwise.`;

function baseUrl(settings) {
  return settings.lmUrl.replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1';
}

async function resolveModel(settings) {
  if (settings.model) return settings.model;
  const models = await serverModels(settings);
  if (!models) throw new Error(`Could not reach LM Studio at ${settings.lmUrl}. Click "Start LM Studio" in the sidebar.`);
  const chat = models.filter((m) => m.type !== 'embeddings');
  const pick = chat.find((m) => m.state === 'loaded') || chat.find((m) => m.state === 'unknown');
  if (!pick) throw new Error('No model is loaded in LM Studio. Pick one in the sidebar and click Load.');
  return pick.id;
}

export function stripThinking(text) {
  return text.replace(/<think>[\s\S]*?(<\/think>|$)\s*/g, '').trim();
}

export function buildSystemPrompt({ profile, job, jobs }) {
  const parts = [SYSTEM_BASE, `Today's date: ${new Date().toISOString().slice(0, 10)}.`];

  const p = [];
  if (profile.name) p.push(`Name: ${profile.name}`);
  if (profile.headline) p.push(`Headline: ${profile.headline}`);
  if (profile.resume) p.push(`### Current resume\n${profile.resume}`);
  if (profile.about) p.push(`### Additional background, achievements and goals\n${profile.about}`);
  if (profile.style) p.push(`### Writing style preferences\n${profile.style}`);
  parts.push(p.length ? `## Candidate profile\n${p.join('\n\n')}` : '## Candidate profile\n(The user has not filled in their profile yet. Ask for missing details when needed.)');

  if (job) {
    const meta = [
      ['Title', job.title], ['Company', job.company], ['Location', job.location],
      ['Work mode', job.workMode], ['Salary', job.salary], ['URL', job.url], ['Application status', job.status],
    ].filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n');
    parts.push(`## Target job\n${meta}\n\n### Job description\n${job.description || '(no description saved)'}` +
      (job.notes ? `\n\n### User's notes about this job\n${job.notes}` : ''));
  } else if (jobs?.length) {
    const list = jobs.slice(0, 50).map((j) =>
      `- ${j.title || 'Untitled'} @ ${j.company || '?'} — ${j.status}${j.matchScore != null ? `, match ${j.matchScore}/100` : ''}${j.appliedAt ? `, applied ${j.appliedAt}` : ''}`).join('\n');
    parts.push(`## Jobs the user is tracking\n${list}`);
  }
  return parts.join('\n\n');
}

function payload(settings, model, messages, extra = {}) {
  const body = { model, messages, temperature: Number(settings.temperature) || 0.7, ...extra };
  const max = Number(settings.maxTokens);
  if (max > 0) body.max_tokens = max;
  return body;
}

// Streams assistant text deltas to onDelta. Resolves with the full text.
export async function streamChat(settings, messages, { onDelta, signal }) {
  const model = await resolveModel(settings);
  const res = await fetch(baseUrl(settings) + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload(settings, model, messages, { stream: true })),
    signal,
  });
  if (!res.ok) throw new Error(`LM Studio error ${res.status}: ${await res.text()}`);

  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return full;
      try {
        const delta = JSON.parse(data).choices?.[0]?.delta?.content;
        if (delta) { full += delta; onDelta(delta); }
      } catch { /* ignore keep-alives / partial frames */ }
    }
  }
  return full;
}

export async function complete(settings, messages, extra) {
  const model = await resolveModel(settings);
  const res = await fetch(baseUrl(settings) + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload(settings, model, messages, extra)),
  });
  if (!res.ok) throw new Error(`LM Studio error ${res.status}: ${await res.text()}`);
  const body = await res.json();
  return stripThinking(body.choices?.[0]?.message?.content || '');
}

export async function extractJobFields(settings, description) {
  const text = await complete(settings, [
    { role: 'system', content: 'You extract structured data from job postings. Reply with a single JSON object and nothing else.' },
    {
      role: 'user',
      content: `Extract these fields from the job posting below. Use "" when unknown.
{"title": string, "company": string, "location": string, "workMode": "remote"|"hybrid"|"onsite"|"", "salary": string, "seniority": string, "keywords": string[] (up to 10 key skills/technologies)}

Job posting:
"""
${description.slice(0, 12000)}
"""`,
    },
  ], { temperature: 0.1, max_tokens: 2000 });
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The model did not return JSON. Try a different model or fill the fields manually.');
  return JSON.parse(text.slice(start, end + 1));
}
