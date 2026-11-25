import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChunks, normalize, tokens, lexicalScore, rerank, pickSources, parseEmbeddings, retrieve, reindex, DIMS } from '../rag.js';
import { loadUnits, fakeEnv } from './fakes.mjs';

const units = loadUnits();

test('كل كارت في المنهج بقى جزء واحد بـ id ثابت ومن غير تكرار', () => {
  const chunks = buildChunks(units);
  assert.equal(chunks.length, 303);
  assert.equal(new Set(chunks.map(c => c.id)).size, chunks.length);
  assert.ok(chunks.every(c => c.text.length > 50 && c.text.length <= 1800));
  assert.ok(chunks.every(c => !/<[a-z]/i.test(c.text)), 'مفيش HTML في النص');
  const ip = chunks.find(c => c.id === 'u8l2:c1');
  assert.match(ip.text, /عنوان IP/);
  assert.equal(ip.lessonTitle, 'عناوين IP وأسماء النطاقات');
  assert.ok(chunks.every(c => Buffer.byteLength(JSON.stringify(c)) < 10240), 'الـ metadata أقل من حد Vectorize');
});

test('التطبيع بيوحّد أشكال الكتابة العربية', () => {
  assert.equal(normalize('الإنترنتُ أمانٌ'), normalize('الانترنت امان'));
  assert.equal(normalize('مكتبة'), normalize('مكتبه'));
  assert.deepEqual(tokens('يعني ايه البروتوكول؟'), ['بروتوكول']);
});

test('تطابق الكلمات بيدّي درجة أعلى للنص اللي فيه كلمات السؤال', () => {
  const q = tokens('ازاي احول من ثنائي لعشري');
  assert.ok(lexicalScore(q, 'التحويل من ثنائي إلى عشري') > lexicalScore(q, 'كلمة المرور القوية'));
});

test('الترتيب الهجين: الكلمات والدرس المفتوح بيغيروا الترتيب', () => {
  const m = [
    { id: 'a', score: 0.70, metadata: { lesson: 'u1l1', text: 'كلام عام' } },
    { id: 'b', score: 0.68, metadata: { lesson: 'u8l2', text: 'عنوان IP رقم مميز لكل جهاز' } },
  ];
  assert.equal(rerank(m, 'يعني ايه عنوان IP', null)[0].id, 'b');
  assert.equal(rerank(m, 'سؤال', 'u1l1')[0].id, 'a');
});

test('المصادر: من غير تكرار وقريبة من أعلى نتيجة بس', () => {
  const md = (lesson, cardTitle) => ({ lesson, lessonTitle: lesson, cardTitle, pages: '' });
  const s = pickSources([
    { score: 0.9, metadata: md('u8l2', 'عنوان IP') },
    { score: 0.89, metadata: md('u8l2', 'عنوان IP') },
    { score: 0.87, metadata: md('u8l2', 'DNS') },
    { score: 0.70, metadata: md('u1l1', 'بعيد') },
  ]);
  assert.deepEqual(s.map(x => x.cardTitle), ['عنوان IP', 'DNS']);
});

test('شكل الـ embeddings الغلط بيترفض بدل ما يبوّظ الفهرس', () => {
  assert.throws(() => parseEmbeddings({ embeddings: [{ values: [1, 2, 3] }] }), /dims/);
  assert.throws(() => parseEmbeddings({ error: { message: 'quota' } }));
  const [v] = parseEmbeddings({ embeddings: [{ values: new Array(DIMS).fill(2) }] });
  assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-9, 'الـ vectors بتتعمل normalize');
});

test('الفهرسة على أجزاء بتغطي كل الكروت من غير تكرار', async () => {
  const env = fakeEnv();
  let n = 0;
  for (let part = 0; part < 5; part++) n += (await reindex(env, units, part, 5)).chunks;
  assert.equal(n, 303);
  assert.equal(env.store.size, 303);
});

test('إعادة الفهرسة بتعمل upsert لكل الأجزاء، ومرتين ورا بعض مش بتكرر حاجة', async () => {
  const env = fakeEnv();
  const r = await reindex(env, units);
  assert.equal(r.chunks, 303);
  assert.equal(r.lessons, 50);
  await reindex(env, units);
  assert.equal(env.store.size, 303);
  assert.ok(env.calls.embed <= 2 * 13, 'دفعات embeddings قليلة (حد الـ subrequests)');
});

test('البحث بيلاقي الدرس الصح حتى لو الطالب فاتح درس تاني', async () => {
  const env = fakeEnv();
  await reindex(env, units);
  const r = await retrieve(env, 'إيه الفرق بين TCP و UDP؟', 'u12l2', 'hybrid', { minScore: 0.1 }); // الـ embedding الوهمي درجاته أقل من الموديل الحقيقي
  assert.equal(r.top[0].metadata.lesson, 'u8l3');
  assert.equal(r.outOfScope, false);
});

test('سؤال برا المنهج بيتعلّم عليه outOfScope', async () => {
  const env = fakeEnv();
  await reindex(env, units);
  const r = await retrieve(env, 'مين كسب ماتش الأهلي امبارح؟', null, 'hybrid', { minScore: 0.42 });
  assert.equal(r.outOfScope, true);
});
