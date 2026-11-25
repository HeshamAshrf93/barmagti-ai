/**
 * RAG للمدرس الذكي: تقطيع المنهج، embeddings، بحث هجين، ومصادر لكل إجابة.
 * كل الدوال اللي مش محتاجة Cloudflare "نقية" علشان تتختبر بـ node:test.
 */

// الـ embeddings من Gemini (مجاني وحصته منفصلة عن Cloudflare AI اللي بتخلص). بنطلب 1024 بُعد علشان الفهرس.
export const EMBED_MODEL = 'gemini-embedding-001';
export const RERANK_MODEL = '@cf/baai/bge-m3';
export const DIMS = 1024;
export const UNIT_IDS = ['u1','u2','u3','u4','u5','u6','u7','u8','u9','u10','u11','u12'];

// الأوزان والحدود: اتظبطت بالـ evals (evals/run.mjs) مش بالتخمين
export const DEFAULTS = {
  candidates: 12,    // كام نتيجة نجيب من Vectorize قبل إعادة الترتيب
  topK: 4,           // كام جزء يدخل للموديل
  lexWeight: 0.25,   // وزن تطابق الكلمات
  lessonBoost: 0.04, // ميزة بسيطة للدرس اللي الطالب فاتحه
  minScore: 0.57,    // أقل من كده = السؤال غالبًا برا المنهج (مقياس Gemini embeddings)
  sourceGap: 0.06,   // المصادر اللي بتظهر للطالب: اللي قريبة من أعلى نتيجة بس
};

/* ---------- تنضيف النص ---------- */
export function strip(h) {
  return String(h || '')
    .replace(/<(br|\/p|\/li|\/tr|\/h\d)[^>]*>/g, '\n').replace(/<\/t[dh]>/g, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

// نفس الكلمة بأكتر من شكل في الكتابة: أ/إ/آ → ا، ى → ي، ة → ه، ومن غير تشكيل
export function normalize(s) {
  return String(s || '').toLowerCase()
    .replace(/[ً-ْٰـ]/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

const STOP = new Set(('في من على الى عن مع او و ثم هو هي هم انا انت ده دي دا ايه يعني اللي الي ازاي امتى ليه لو كان يكون ' +
  'ما ماذا هل كيف لماذا متى بين كل بعد قبل عند غير بس طب طيب يا عايز عاوز اعرف قولي اشرح شرح الفرق الدرس ' +
  'the a an of to in is are what how why and or').split(' '));

export function tokens(s) {
  return normalize(s).split(' ')
    .map(w => (w.length > 4 && /^(ال|وال|بال|فال|لل)/.test(w)) ? w.replace(/^(وال|بال|فال|ال|لل)/, '') : w)
    .filter(w => w.length >= 2 && !STOP.has(w));
}

/* ---------- التقطيع: جزء لكل كارت ---------- */
const MAX_CHUNK = 1800;

export function buildChunks(units) {
  const out = [];
  for (const u of units) {
    for (const l of u.lessons || []) {
      for (const c of l.cards || []) {
        const title = String(c.title || '').replace(/^📖\s*بالتفصيل:\s*/, '');
        const body = [(c.narration || []).join(' '), strip(c.key)].filter(Boolean).join('\n');
        const text = `${u.title} — ${l.title} — ${title}\n${body}`.slice(0, MAX_CHUNK);
        out.push({
          id: `${l.id}:${c.id}`,          // ثابت، فإعادة الفهرسة بتحدّث نفس الجزء مش بتكرره
          unit: u.id, lesson: l.id, card: c.id,
          unitTitle: u.title, lessonTitle: l.title, cardTitle: title, pages: l.pages || '',
          text,
        });
      }
    }
  }
  return out;
}

/* ---------- الترتيب الهجين ---------- */
export function lexicalScore(qTokens, text) {
  if (!qTokens.length) return 0;
  const hay = ' ' + tokens(text).join(' ') + ' ';
  let hit = 0;
  for (const t of new Set(qTokens)) if (hay.includes(' ' + t) ) hit++;
  return hit / new Set(qTokens).size;
}

/** matches: [{id, score, metadata}] من Vectorize. بيرجع نفس العناصر مترتبة بالدرجة المجمعة. */
export function rerank(matches, question, lessonId, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const q = tokens(question);
  return matches.map(m => {
    const md = m.metadata || {};
    const lex = o.lexWeight ? lexicalScore(q, md.text || '') : 0;
    const boost = lessonId && md.lesson === lessonId ? o.lessonBoost : 0;
    return { ...m, vec: m.score, lex, score: m.score + o.lexWeight * lex + boost };
  }).sort((a, b) => b.score - a.score);
}

/** المصادر اللي تظهر للطالب: من غير تكرار للدرس، وقريبة من أعلى نتيجة بس. */
export function pickSources(ranked, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (!ranked.length) return [];
  const best = ranked[0].score;
  const seen = new Set(); const out = [];
  for (const r of ranked) {
    const md = r.metadata || {};
    if (best - r.score > o.sourceGap) break;
    const key = md.lesson + '|' + md.cardTitle;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ lessonId: md.lesson, lessonTitle: md.lessonTitle, cardTitle: md.cardTitle, pages: md.pages || '' });
    if (out.length === 3) break;
  }
  return out;
}

export function formatContext(chunks) {
  return chunks.map((c, i) => {
    const md = c.metadata || c;
    return `### [${i + 1}] ${md.lessonTitle} — ${md.cardTitle}${md.pages ? ' (' + md.pages + ')' : ''}\n${md.text}`;
  }).join('\n\n');
}

/* ---------- Cloudflare: embeddings و Vectorize ---------- */
function normalizeVec(v) {
  const n = Math.hypot(...v) || 1;
  return v.map(x => x / n);
}
export function parseEmbeddings(out) {
  const rows = out && Array.isArray(out.embeddings) ? out.embeddings.map(e => e && e.values) : null;
  if (!rows || !rows.length || !Array.isArray(rows[0])) throw new Error('unexpected embedding output');
  if (rows[0].length !== DIMS) throw new Error('embedding dims ' + rows[0].length + ' != ' + DIMS);
  return rows.map(normalizeVec);
}

/** task: 'RETRIEVAL_DOCUMENT' للمنهج، 'RETRIEVAL_QUERY' لسؤال الطالب. env.EMBEDDER بيتحط في الاختبارات بس. */
export async function embed(env, texts, task = 'RETRIEVAL_QUERY') {
  if (env.EMBEDDER) return env.EMBEDDER(texts, task);
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY missing');
  const model = env.EMBED_MODEL || EMBED_MODEL;
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify({ requests: texts.map(t => ({
      model: 'models/' + model, content: { parts: [{ text: t }] }, taskType: task, outputDimensionality: DIMS,
    })) }),
  });
  if (!r.ok) throw new Error('embed http ' + r.status + ' ' + (await r.text()).slice(0, 160));
  return parseEmbeddings(await r.json());
}

/** bge-m3 بيعرف يعمل re-ranking لو اديناه query + contexts. لو الرد مش بالشكل المتوقع بنسيب الترتيب زي ما هو. */
export async function modelRerank(env, question, ranked) {
  try {
    if (!env.AI) return ranked;
    const out = await env.AI.run(RERANK_MODEL, { query: question, contexts: ranked.map(r => ({ text: (r.metadata || {}).text || '' })) });
    const rows = out && out.response;
    if (!Array.isArray(rows) || !rows.length || typeof rows[0].score !== 'number') return ranked;
    const byIdx = new Map(rows.map(r => [r.id, r.score]));
    return ranked.map((r, i) => ({ ...r, rr: byIdx.get(i) ?? 0 })).sort((a, b) => b.rr - a.rr);
  } catch (e) { return ranked; }
}

/**
 * mode: 'vector' (embeddings بس) | 'hybrid' (embeddings + كلمات + الدرس المفتوح) | 'hybrid+rr' (+ re-ranking)
 * بيرجع { ranked, top, outOfScope }
 */
export async function retrieve(env, question, lessonId, mode = 'hybrid', opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const [qv] = await embed(env, [question]);
  const res = await env.VECTORIZE.query(qv, { topK: o.candidates, returnMetadata: 'all' });
  const matches = (res && res.matches) || [];
  let ranked = mode === 'vector'
    ? matches.map(m => ({ ...m, vec: m.score, lex: 0 })).sort((a, b) => b.score - a.score)
    : rerank(matches, question, lessonId, o);
  if (mode === 'hybrid+rr') ranked = await modelRerank(env, question, ranked);
  const bestVec = matches.reduce((m, x) => Math.max(m, x.score), 0);
  return { ranked, top: ranked.slice(0, o.topK), outOfScope: bestVec < o.minScore, bestVec };
}

/**
 * بيبني الفهرس على أجزاء، علشان حدود Gemini المجانية (توكنز في الدقيقة).
 * part = رقم الجزء، parts = عدد الأجزاء. كل جزء ~60 كارت.
 */
export async function reindex(env, units, part = 0, parts = 1, batch = 30) {
  const all = buildChunks(units);
  const size = Math.ceil(all.length / parts);
  const chunks = all.slice(part * size, (part + 1) * size);
  const vectors = [];
  for (let i = 0; i < chunks.length; i += batch) {
    const slice = chunks.slice(i, i + batch);
    const embs = await embed(env, slice.map(c => c.text), 'RETRIEVAL_DOCUMENT');
    slice.forEach((c, j) => vectors.push({ id: c.id, values: embs[j], metadata: c }));
  }
  for (let i = 0; i < vectors.length; i += 1000) await env.VECTORIZE.upsert(vectors.slice(i, i + 1000));
  return { chunks: chunks.length, total: all.length, part, parts, lessons: new Set(all.map(c => c.lesson)).size };
}
