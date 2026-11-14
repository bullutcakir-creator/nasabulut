// Route explanations: deterministic templates + optional Gemma 4 rewording (Node.js port).
//
// The model never chooses routes. It receives only the code-generated `explanation_facts`; its output
// is accepted only if every number in it appears in those facts and it uses no banned topic words,
// otherwise the deterministic template is used.
//
// Model: Gemma 4 26B A4B instruction-tuned. Verified identifiers (2026-11-14):
//   Gemini API model code  "gemma-4-26b-a4b-it"  (https://ai.google.dev/gemma/docs/core/gemma_on_gemini_api)
//   Hugging Face repo      "google/gemma-4-26B-A4B-it" (Apache-2.0)
// Access (server-side environment variables only, never sent to the browser):
//   GEMINI_API_KEY          -> Gemini API generateContent
//   GEMMA_OPENAI_BASE_URL   -> local OpenAI-compatible server (llama.cpp, LM Studio, vLLM); GEMMA_LOCAL_MODEL overrides the name
import { LABEL } from './routing.js';

export const GEMINI_MODEL = 'gemma-4-26b-a4b-it';
const LOCAL_MODEL_DEFAULT = 'google/gemma-4-26B-A4B-it';
const TIMEOUT_MS = 45_000;
const BANNED = /\b(weather|temperatur|dust|storm|wind|humid|mud|wet\b|water|ice\b|radiation|safe|guarantee|approved|certified|nasa standard|rock|boulder|sand|thermal|soil|strength|scien|hazard|danger)\w*/i;
const NUM = /(?<![\w.])-?\d+(?:,\d{3})*(?:\.\d+)?/g;

export function templateText(route) {
  const f = route.explanation_facts;
  const parts = [`${LABEL[f.objective]} route: ${f.distance_km} km with a mean slope of ${f.mean_slope_deg} deg and a ` +
    `maximum cell slope of ${f.max_slope_deg} deg (limit ${f.slope_limit_deg} deg).`,
    `${f.hirise_cell_share_pct}% of its cells are checked with 1 m HiRISE slopes; the rest use 20 m CTX slopes.`];
  if (f.also_satisfies_objectives.length) parts.push(`The same path also answers: ${f.also_satisfies_objectives.map(o => LABEL[o]).join(', ')}.`);
  if (f.advantages.length) parts.push(`Advantages: ${f.advantages.map(a => a.text).join('; ')}.`);
  if (f.disadvantages.length) parts.push(`Trade-offs: ${f.disadvantages.map(d => d.text).join('; ')}.`);
  return parts.join(' ');
}

const r2 = (x, n) => { const f = 10 ** n; return Math.round(x * f) / f; };

function allowedNumbers(facts) {
  const out = new Set();
  const walk = v => {
    if (typeof v === 'boolean' || v == null) return;
    if (typeof v === 'number') { for (const x of [v, Math.abs(v)]) for (const nd of [0, 1, 2]) out.add(r2(x, nd)); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === 'object') Object.values(v).forEach(walk);
    else if (typeof v === 'string') for (const m of v.match(NUM) || []) out.add(r2(parseFloat(m.replace(/,/g, '')), 2));
  };
  walk(facts);
  return out;
}

/** Return a list of problems; empty list = acceptable. */
export function checkText(text, facts) {
  if (typeof text !== 'string' || !text.trim()) return ['empty'];
  const probs = [];
  if (text.length > 600) probs.push('too long');
  const allowed = [...allowedNumbers(facts)];
  for (const m of text.match(NUM) || []) {
    const v = parseFloat(m.replace(/,/g, ''));
    if (!allowed.some(a => Math.abs(v - a) < 1e-9)) probs.push(`unsupported number ${m}`);
  }
  const b = text.match(BANNED);
  if (b) probs.push(`unsupported topic word '${b[0]}'`);
  return probs;
}

export function buildPrompt(routes) {
  const facts = Object.fromEntries(routes.map(r => [r.route_id, r.explanation_facts]));
  return 'You write short route explanations for a Mars walking-route planning prototype.\n' +
    'Rules:\n' +
    '- Use ONLY the facts in the JSON below. Do not add any number that is not in the JSON.\n' +
    '- Do not recommend or choose a route. Do not mention weather, temperature, dust, radiation, rocks, ' +
    'soil, water, safety guarantees or anything not in the facts.\n' +
    '- Units: km, m, deg. 1-2 plain English sentences per route, max 300 characters each.\n' +
    '- Answer with a single JSON object mapping each route id to its text, nothing else.\n\n' +
    'FACTS:\n' + JSON.stringify(facts);
}

export function provider() {
  if (process.env.GEMMA_OPENAI_BASE_URL) return { name: 'openai_compatible_local', model: process.env.GEMMA_LOCAL_MODEL || LOCAL_MODEL_DEFAULT };
  if (process.env.GEMINI_API_KEY) return { name: 'gemini_api', model: GEMINI_MODEL };
  return null;
}

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export const model = {
  // Exposed as an object so tests can replace callModel without network access.
  async callModel(prompt) {
    const p = provider();
    if (!p) throw new Error('No model access configured (set GEMINI_API_KEY or GEMMA_OPENAI_BASE_URL on the server).');
    let text;
    if (p.name === 'gemini_api') {
      const j = await postJson(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
        { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0 } },
        { 'x-goog-api-key': process.env.GEMINI_API_KEY });
      text = j.candidates[0].content.parts.filter(pt => !pt.thought).map(pt => pt.text || '').join('');
    } else {
      const base = process.env.GEMMA_OPENAI_BASE_URL.replace(/\/+$/, '');
      const j = await postJson(`${base}/chat/completions`, { model: p.model, temperature: 0, messages: [{ role: 'user', content: prompt }] });
      text = j.choices[0].message.content;
    }
    return [p, text];
  },
  provider,
};

function parseJsonObject(text) {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) throw new Error('no JSON object in model output');
  return JSON.parse(m[0]);
}

export async function explain(result) {
  const routes = result.routes || [];
  const out = { schema_version: '1.0.0', result_id: result.result_id ?? null, explanations: [], model: null };
  let texts = {}, modelError = null, p = model.provider();
  if (routes.length && p) {
    const t0 = Date.now();
    try {
      let raw;
      [p, raw] = await model.callModel(buildPrompt(routes));
      texts = parseJsonObject(raw);
    } catch (e) {
      modelError = `${e.name}: ${String(e.message).slice(0, 200)}`;
    }
    out.model = { provider: p.name, model: p.model, latency_s: r2((Date.now() - t0) / 1000, 2), error: modelError };
  } else {
    out.model = { provider: null, model: GEMINI_MODEL, error: 'model_unavailable',
      message: 'Gemma explanations are unavailable: no model access is configured on the server. Showing deterministic template text.' };
  }
  for (const r of routes) {
    const tmpl = templateText(r);
    const cand = texts && typeof texts === 'object' ? texts[r.route_id] : undefined;
    const probs = cand !== undefined ? checkText(cand, r.explanation_facts) : ['model gave no text'];
    if (p && !modelError && !probs.length) {
      out.explanations.push({ route_id: r.route_id, source: 'gemma', text: cand.trim(), template_text: tmpl });
    } else {
      out.explanations.push({ route_id: r.route_id, source: 'template', text: tmpl,
        model_rejected_reasons: p && !modelError ? probs : null });
    }
  }
  return out;
}
