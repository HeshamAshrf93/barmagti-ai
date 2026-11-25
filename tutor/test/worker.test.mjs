import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { reindex } from '../rag.js';
import { loadUnits, fakeEnv, installSiteFetch } from './fakes.mjs';

installSiteFetch();
const SITE = 'https://barmagti-platform.web.app';
const ask = (env, body, origin = SITE) => worker.fetch(new Request('https://w/', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env);
const adminCall = (env, path, body, token) => worker.fetch(new Request('https://w' + path, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: JSON.stringify(body || {}) }), env);

test('الإجابة بترجع ومعاها مصادر من الدرس الصح', async () => {
  const env = fakeEnv();
  await reindex(env, loadUnits());
  const r = await ask(env, { question: 'يعني ايه عنوان IP؟', lessonId: 'u8l2' });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.mode, 'hybrid');
  assert.ok(j.sources.length >= 1);
  assert.equal(j.sources[0].lessonId, 'u8l2');
  assert.match(env.calls.systems[0], /أجزاء المنهج/);
  assert.match(env.calls.systems[0], /أسئلة الدرس المفتوح/, 'أسئلة الدرس المفتوح موجودة علشان قاعدة التلميح');
});

test('سؤال برا المنهج: من غير مصادر، والموديل بيتقاله إن مفيش جزء قريب', async () => {
  const env = fakeEnv();
  await reindex(env, loadUnits());
  const j = await (await ask(env, { question: 'مين كسب ماتش الأهلي امبارح؟', lessonId: null })).json();
  assert.deepEqual(j.sources, []);
  assert.match(env.calls.systems[0], /مفيش جزء في المنهج قريب/);
});

test('لو Vectorize وقع، المدرس بيرجع للدرس كله ومايقعش', async () => {
  const env = fakeEnv({ failVectorize: true });
  const r = await ask(env, { question: 'يعني ايه عنوان IP؟', lessonId: 'u8l2' });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.mode, 'lesson');
  assert.match(env.calls.systems[0], /محتوى الدرس/);
});

test('الطلبات من مواقع تانية مرفوضة', async () => {
  const r = await ask(fakeEnv(), { question: 'x' }, 'https://evil.com');
  assert.equal(r.status, 403);
});

test('مسارات الإدارة مقفولة من غير التوكن الصح', async () => {
  const env = fakeEnv({ extra: { ADMIN_TOKEN: 'a'.repeat(40) } });
  assert.equal((await adminCall(env, '/admin/reindex', {}, 'wrong')).status, 403);
  assert.equal((await adminCall(fakeEnv(), '/admin/reindex', {}, '')).status, 403, 'من غير ADMIN_TOKEN مفيش admin خالص');
  const ok = await adminCall(env, '/admin/reindex', {}, 'a'.repeat(40));
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).chunks, 303);
});

test('/admin/retrieve و /admin/ask بيرجعوا اللي الـ evals محتاجاه', async () => {
  const T = 'b'.repeat(40);
  const env = fakeEnv({ extra: { ADMIN_TOKEN: T } });
  await adminCall(env, '/admin/reindex', {}, T);
  const r = await (await adminCall(env, '/admin/retrieve', { question: 'إيه الفرق بين TCP و UDP؟', mode: 'vector' }, T)).json();
  assert.ok(r.ids.slice(0, 4).some(id => id.startsWith('u8l3')));
  const a = await (await adminCall(env, '/admin/ask', { question: 'يعني ايه DNS؟', lessonId: 'u8l2', mode: 'lesson' }, T)).json();
  assert.equal(a.mode, 'lesson');
  assert.ok(a.contextIds.includes('u8l2:c2'));
});

test('Llama على Cloudflare مش بيشتغل غير لو CF_CHAT=on (علشان حصة Cloudflare AI)', async () => {
  const env = fakeEnv();
  delete env.CF_CHAT;
  await reindex(env, loadUnits());
  const r = await ask(env, { question: 'يعني ايه DNS؟', lessonId: 'u8l2' });
  assert.equal(r.status, 502);
  assert.equal(env.calls.chat, 0);
});

test('رد المزوّد الفاشل مش بيسرّب تفاصيل للطالب', async () => {
  const env = fakeEnv({ chat: () => { throw new Error('secret upstream detail'); } });
  await reindex(env, loadUnits());
  const r = await ask(env, { question: 'يعني ايه DNS؟', lessonId: 'u8l2' });
  const text = await r.text();
  assert.equal(r.status, 502);
  assert.ok(!text.includes('secret upstream'));
});
