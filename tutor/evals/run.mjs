/**
 * Evals للمدرس الذكي: بيقيس البحث (retrieval) والإجابات، ويقارن الطريقة القديمة (الدرس كله) بالـ RAG.
 *
 *   node evals/run.mjs [--budget 150] [--sleep 3000] [--report-only]
 *
 * بيكلّم الـ Worker على مسارات /admin/* بالتوكن (من .admin-token أو ADMIN_TOKEN).
 * بيكمّل من مكان ما وقف (evals/results/raw.json)، فينفع يتشغل على كذا مرة.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const BUDGET_MS = Number(arg('budget', 150)) * 1000;
const SLEEP = Number(arg('sleep', 3000));
const URL_ = process.env.TUTOR_URL || 'https://barmagti-tutor.protective-loaf.workers.dev';
const tokenFile = path.join(DIR, '..', '.admin-token');
const TOKEN = process.env.ADMIN_TOKEN || (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '');
const TAG = arg('tag', '');
const RAW = path.join(DIR, 'results', TAG ? `raw-${TAG}.json` : 'raw.json');
const Q = JSON.parse(fs.readFileSync(path.join(DIR, 'questions.json'), 'utf8'));
const t0 = Date.now();

const ALL_RETRIEVAL_CONFIGS = {
  'vector': { mode: 'vector' },
  'hybrid': { mode: 'hybrid' },
  'hybrid+rerank': { mode: 'hybrid+rr' },
  'hybrid lex=0.15': { mode: 'hybrid', opts: { lexWeight: 0.15 } },
  'hybrid lex=0.40': { mode: 'hybrid', opts: { lexWeight: 0.40 } },
  'hybrid no-lesson-boost': { mode: 'hybrid', opts: { lessonBoost: 0 } },
};
// اسم في التقرير ← الـ mode اللي الـ Worker بيشتغل بيه. hybrid-v2 = نفس الـ RAG بعد تعديل الـ prompt (العامية والمصادر)
const ALL_ANSWER_MODES = { 'lesson': 'lesson', 'hybrid': 'hybrid', 'hybrid-v2': 'hybrid' };
const pick = arg('retrieval', '');
const RETRIEVAL_CONFIGS = pick ? Object.fromEntries(pick.split(',').filter(k => ALL_RETRIEVAL_CONFIGS[k]).map(k => [k, ALL_RETRIEVAL_CONFIGS[k]])) : ALL_RETRIEVAL_CONFIGS;
const ANSWER_MODES = (arg('modes', 'lesson,hybrid')).split(',').filter(m => ALL_ANSWER_MODES[m]);

// ملف نتايج بايظ (زي اللي حصل مع الهارد) مايوقفش التشغيل: بنسيبه ونبدأ من جديد
let raw = { retrieval: {}, answers: {}, judge: {} };
try { if (fs.existsSync(RAW)) raw = JSON.parse(fs.readFileSync(RAW, 'utf8')); }
catch (e) { console.log('  ملف النتايج القديم بايظ، هبدأ من جديد'); fs.renameSync(RAW, RAW + '.broken-' + Date.now()); }
// كتابة آمنة: ملف مؤقت وبعدين rename، فلو العملية اتقطعت النتايج القديمة متبوظش
const save = () => { fs.mkdirSync(path.dirname(RAW), { recursive: true }); const data = JSON.stringify(raw, null, 1);
  fs.writeFileSync(RAW + '.tmp', data);
  for (let i = 0; i < 5; i++) { try { fs.renameSync(RAW + '.tmp', RAW); return; } catch (e) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); } }
  fs.writeFileSync(RAW, data); // ويندوز ساعات بيقفل الملف لو حد بيقراه
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const timeLeft = () => Date.now() - t0 < BUDGET_MS;

async function call(p, body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(URL_ + p, { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (r.ok && !j.error) return j;
    if (r.status === 403) throw new Error('403: ADMIN_TOKEN غلط أو مش متسجل في الـ Worker');
    console.log('  retry', p, r.status, j.error || ''); await sleep(5000 * (attempt + 1));
  }
  throw new Error('failed ' + p);
}

async function run() {
  if (!TOKEN) throw new Error('مفيش ADMIN_TOKEN (.admin-token)');
  const retrievalItems = Q.filter(q => q.type === 'answer' || q.type === 'decline');
  for (const [name, cfg] of Object.entries(RETRIEVAL_CONFIGS)) {
    raw.retrieval[name] ||= {};
    for (const q of retrievalItems) {
      // نتيجة فاضية = الفهرس كان لسه بيتبني (Vectorize بياخد دقيقة بعد الـ upsert)، فنعيدها
      if (raw.retrieval[name][q.id] && raw.retrieval[name][q.id].ids.length) continue;
      if (!timeLeft()) return false;
      raw.retrieval[name][q.id] = await call('/admin/retrieve', { question: q.question, lessonId: q.openLesson, ...cfg });
      save();
    }
    console.log('retrieval done:', name);
  }
  for (const mode of ANSWER_MODES) {
    raw.answers[mode] ||= {}; raw.judge[mode] ||= {};
    for (const q of Q) {
      if (!raw.answers[mode][q.id]) {
        if (!timeLeft()) return false;
        raw.answers[mode][q.id] = await call('/admin/ask', { question: q.question, lessonId: q.openLesson, mode: ALL_ANSWER_MODES[mode] });
        save(); await sleep(SLEEP);
      }
      if (!raw.judge[mode][q.id]) {
        if (!timeLeft()) return false;
        const a = raw.answers[mode][q.id];
        try { raw.judge[mode][q.id] = await call('/admin/judge', { question: q.question, expect: q.type, context: a.context, answer: a.answer }); }
        catch (e) { if (String(e.message).startsWith('403')) throw e; raw.judge[mode][q.id] = { error: 'judge failed' }; }
        save(); await sleep(SLEEP);
      }
    }
    console.log('answers done:', mode);
  }
  return true;
}

/* ---------- التقرير ---------- */
const pct = x => (100 * x).toFixed(0) + '%';
const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const quant = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
const group = q => !q.openLesson ? 'home' : q.expected[0].startsWith(q.openLesson + ':') ? 'same' : 'cross';

function report() {
  const answerQs = Q.filter(q => q.type === 'answer');
  const declineQs = Q.filter(q => q.type === 'decline');
  const L = [];
  L.push('# Evals — المدرس الذكي في برمجتي', '');
  L.push(`${Q.length} سؤال: ${answerQs.length} أسئلة من المنهج (${answerQs.filter(q => group(q) === 'same').length} من الدرس المفتوح، ${answerQs.filter(q => group(q) === 'cross').length} من درس تاني، ${answerQs.filter(q => group(q) === 'home').length} من غير درس مفتوح؛ منهم ${answerQs.filter(q => q.hard).length} بكلام الطالب نفسه من غير مصطلحات الكتاب)، ` +
    `${Q.filter(q => q.type === 'hint').length} طلب إجابة الاختبار على طول، ${declineQs.length} برا المنهج، ${Q.filter(q => q.type === 'injection').length} prompt injection.`, '');

  L.push('## 1. البحث (Retrieval)', '', 'الإجابة الصح = أي كارت من الكروت اللي فيها الإجابة. الطريقة القديمة (الدرس كله) "بتلاقي" الإجابة بس لو الطالب فاتح نفس الدرس.', '');
  L.push('| الطريقة | Hit@1 | Hit@4 (اللي بيدخل للموديل) | MRR | Hit@4 — نفس الدرس | Hit@4 — درس تاني | Hit@4 — من غير درس | Hit@4 — بكلام الطالب |', '|---|---|---|---|---|---|---|---|');
  const covers = q => q.openLesson && q.expected[0].startsWith(q.openLesson + ':') ? 1 : 0;
  const by = (f, qs) => pct(avg(qs.map(f)));
  L.push(`| الدرس المفتوح كله (القديم) | — | ${by(covers, answerQs)} | — | ${by(covers, answerQs.filter(q => group(q) === 'same'))} | ${by(covers, answerQs.filter(q => group(q) === 'cross'))} | ${by(covers, answerQs.filter(q => group(q) === 'home'))} | ${by(covers, answerQs.filter(q => q.hard))} |`);
  const ret = {};
  for (const name of Object.keys(RETRIEVAL_CONFIGS)) {
    const R = raw.retrieval[name] || {};
    if (!answerQs.every(q => R[q.id])) continue;
    const rank = q => { const i = R[q.id].ids.findIndex(id => q.expected.includes(id)); return i < 0 ? Infinity : i + 1; };
    const hit = k => q => rank(q) <= k ? 1 : 0;
    ret[name] = avg(answerQs.map(hit(4)));
    L.push(`| ${name} | ${by(hit(1), answerQs)} | ${by(hit(4), answerQs)} | ${avg(answerQs.map(q => 1 / rank(q))).toFixed(2)} | ${by(hit(4), answerQs.filter(q => group(q) === 'same'))} | ${by(hit(4), answerQs.filter(q => group(q) === 'cross'))} | ${by(hit(4), answerQs.filter(q => group(q) === 'home'))} | ${by(hit(4), answerQs.filter(q => q.hard))} |`);
  }
  const misses = (raw.retrieval.hybrid && answerQs.filter(q => raw.retrieval.hybrid[q.id] && !raw.retrieval.hybrid[q.id].ids.slice(0, 4).some(id => q.expected.includes(id)))) || [];
  if (misses.length) L.push('', 'الأسئلة اللي الـ hybrid مالقاش إجابتها في أول 4: ' + misses.map(q => `«${q.question}» (لقى ${raw.retrieval.hybrid[q.id].ids[0]})`).join('، '));

  const H = raw.retrieval.hybrid || {};
  if (declineQs.every(q => H[q.id]) && answerQs.every(q => H[q.id])) {
    L.push('', '## 2. اكتشاف الأسئلة اللي برا المنهج', '', 'لو أعلى تشابه (cosine) أقل من الحد، المدرس بيتعامل مع السؤال إنه برا المنهج.', '');
    L.push('| الحد | برا المنهج اتكشف | أسئلة من المنهج اترفضت غلط |', '|---|---|---|');
    for (let t = 0.30; t <= 0.601; t += 0.03) {
      L.push(`| ${t.toFixed(2)} | ${pct(avg(declineQs.map(q => H[q.id].bestVec < t ? 1 : 0)))} | ${pct(avg(answerQs.map(q => H[q.id].bestVec < t ? 1 : 0)))} |`);
    }
    L.push('', `أعلى تشابه: أسئلة المنهج من ${Math.min(...answerQs.map(q => H[q.id].bestVec)).toFixed(2)} لـ ${Math.max(...answerQs.map(q => H[q.id].bestVec)).toFixed(2)}، والأسئلة اللي برا من ${Math.min(...declineQs.map(q => H[q.id].bestVec)).toFixed(2)} لـ ${Math.max(...declineQs.map(q => H[q.id].bestVec)).toFixed(2)}.`);
  }

  const shown = Object.keys(ALL_ANSWER_MODES).filter(m => Q.every(q => raw.judge[m] && raw.judge[m][q.id]));
  if (shown.length >= 1) {
    L.push('', '## 3. الإجابات (LLM-as-judge)', '', 'موديل تاني بيقيّم كل إجابة: هل كل معلوماتها من السياق (faithful)، هل ردّت على السؤال، هل بالعامية، وهل التصرف صح (يجاوب / يدّي تلميح / يعتذر / ميتخدعش).', '');
    const label = { 'lesson': 'الدرس كله (القديم)', 'hybrid': 'RAG hybrid', 'hybrid-v2': 'RAG + prompt v2' };
    L.push('| | ' + shown.map(m => label[m]).join(' | ') + ' |', '|---|' + shown.map(() => '---|').join(''));
    const J = (m, qs, k) => { const ok = qs.filter(q => !raw.judge[m][q.id].error); return pct(avg(ok.map(q => Number(raw.judge[m][q.id][k]) || 0))); };
    const row = (name, qs, k) => L.push(`| ${name} | ` + shown.map(m => J(m, qs, k)).join(' | ') + ' |');
    row('أسئلة المنهج اتجاوبت', answerQs, 'answers');
    row('↳ لما السؤال من درس تاني', answerQs.filter(q => group(q) === 'cross'), 'answers');
    row('↳ من غير درس مفتوح', answerQs.filter(q => group(q) === 'home'), 'answers');
    row('مفيش معلومات متألفة (faithful)', Q, 'faithful');
    row('بالعامية المصرية', Q, 'egyptian');
    row('ادّى تلميح بدل الإجابة', Q.filter(q => q.type === 'hint'), 'behavior');
    row('اعتذر عن اللي برا المنهج', declineQs, 'behavior');
    row('مااتخدعش (prompt injection)', Q.filter(q => q.type === 'injection'), 'behavior');
    for (const m of shown) {
      const ms = Q.map(q => raw.answers[m][q.id].ms);
      const by = {}; for (const q of Q) { const b = raw.answers[m][q.id].by || 'none'; by[b] = (by[b] || 0) + 1; }
      L.push('', `- **${m}**: الوقت p50 ${(quant(ms, .5) / 1000).toFixed(1)}s، p95 ${(quant(ms, .95) / 1000).toFixed(1)}s. الموديلات: ${Object.entries(by).map(([k, v]) => k + ' ×' + v).join('، ')}.`);
    }
    const last = shown[shown.length - 1];
    const bad = Q.filter(q => raw.judge[last][q.id].faithful === 0 || raw.judge[last][q.id].behavior === 0 || raw.judge[last][q.id].answers === 0);
    if (bad.length) L.push('', `### الحالات اللي فشلت في ${label[last]}`, '', ...bad.map(q => `- «${q.question}» (${q.type}): ${raw.judge[last][q.id].note || ''}`));
  }
  L.push('', `_اتولّد ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC من evals/run.mjs_`);
  fs.writeFileSync(path.join(DIR, 'REPORT.md'), L.join('\n') + '\n');
  return L.join('\n');
}

if (process.argv.includes('--reindex')) {
  // على 5 أجزاء ودقيقة بين كل جزء، علشان حد Gemini المجاني للتوكنز في الدقيقة
  const parts = Number(arg('parts', 5));
  let done = 0, total = 0;
  for (let part = 0; part < parts; part++) {
    let r;
    for (let attempt = 0; ; attempt++) {
      try { r = await call('/admin/reindex', { part, parts }); break; }
      catch (e) { if (attempt >= 3) throw e; console.log('  مستني دقيقة وبجرب تاني...'); await sleep(65000); }
    }
    done += r.chunks; total = r.total;
    console.log(`  جزء ${part + 1}/${parts}: ${r.chunks} كارت`);
    if (part < parts - 1) await sleep(65000);
  }
  console.log(`✅ الفهرس اتبنى: ${done} من ${total} جزء`);
  process.exit(0);
}
const done = process.argv.includes('--report-only') ? true : await run().catch(e => { console.error(e.message); return false; });
const text = report();
console.log(done ? '\n✅ كل الـ evals خلصت\n' : '\n⏸ لسه في أسئلة؛ شغّله تاني يكمّل\n');
console.log(text.split('\n').slice(0, 40).join('\n'));
