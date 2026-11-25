// بدايل محلية لـ Cloudflare (Workers AI و Vectorize) وللموقع، علشان الاختبارات تشتغل من غير إنترنت.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokens, DIMS } from '../rag.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// units/ sits next to the tutor in this repo, and one level up on the platform
const ROOT = fs.existsSync(path.join(HERE, '..', 'units')) ? path.join(HERE, '..') : path.resolve(HERE, '..', '..');

export function loadUnits() {
  const UNITS_DATA = [];
  for (let i = 1; i <= 12; i++) new Function('UNITS_DATA', fs.readFileSync(path.join(ROOT, 'units', `u${i}.js`), 'utf8'))(UNITS_DATA);
  return UNITS_DATA;
}

// embedding وهمي: كل كلمة بتروح لبُعد ثابت (hashing)، وبعدين normalize. كفاية لاختبار المنطق.
export function fakeVector(text) {
  const v = new Array(DIMS).fill(0);
  for (const t of tokens(text)) { let h = 2166136261; for (const ch of t) h = Math.imul(h ^ ch.codePointAt(0), 16777619); v[Math.abs(h) % DIMS] += 1; }
  const n = Math.hypot(...v) || 1;
  return v.map(x => x / n);
}

export function fakeEnv({ chat = () => 'رد تجريبي بالعامية', failVectorize = false, extra = {} } = {}) {
  const store = new Map();
  const calls = { embed: 0, chat: 0, systems: [] };
  return {
    calls, store, CF_CHAT: 'on',
    EMBEDDER: async (texts) => { calls.embed++; return texts.map(fakeVector); },
    AI: {
      async run(model, input) {
        if (input.text) { calls.embed++; return { shape: [input.text.length, DIMS], data: input.text.map(fakeVector) }; }
        if (input.query) return { response: input.contexts.map((c, id) => ({ id, score: 0 })) };
        calls.chat++; calls.systems.push(input.messages[0].content);
        return { response: chat(input) };
      },
    },
    VECTORIZE: {
      async upsert(vs) { if (failVectorize) throw new Error('down'); for (const v of vs) store.set(v.id, v); return { count: vs.length }; },
      async query(q, { topK }) {
        if (failVectorize) throw new Error('vectorize down');
        const matches = [...store.values()].map(v => ({ id: v.id, metadata: v.metadata, score: v.values.reduce((s, x, i) => s + x * q[i], 0) }));
        return { matches: matches.sort((a, b) => b.score - a.score).slice(0, topK) };
      },
    },
    ...extra,
  };
}

// fetch وهمي: بيقدّم ملفات units/*.js زي ما الموقع بيقدمها
export function installSiteFetch() {
  globalThis.fetch = async (url) => {
    const m = /\/units\/(u\d+)\.js$/.exec(String(url));
    if (m) return new Response(fs.readFileSync(path.join(ROOT, 'units', m[1] + '.js'), 'utf8'), { status: 200 });
    throw new Error('unexpected fetch ' + url);
  };
}
