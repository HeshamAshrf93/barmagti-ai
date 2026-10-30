# برمجتي AI — مصحّح الواجبات + مساعد المذاكرة (RAG)

ميزتين AI لمنصة **برمجتي** (barmagti-platform.web.app):

1. **مساعد المذاكرة:** الطالب يسأل، السيستم يدوّر في المنهج ويجاوب منه بس، ومعاه رقم الدرس المصدر.
2. **مصحّح الواجبات:** المعلم يرفع السؤال والإجابة النموذجية ومعايير التصحيح. الطالب يكتب إجابته، فياخد درجة وفيدباك وتلميحات **من غير ما يشوف الحل**.

## المعمارية

```
المنصة (Firebase Hosting + Auth)
   │  Firebase ID Token
   ▼
Cloudflare Worker  (Hono + LangChain.js)   ← مجاني ومن غير كارت
   ├─ يتحقق من التوكن (jose + مفاتيح Google)
   ├─ Retrieval: embeddings (gemini-embedding-001) + cosine similarity
   ├─ Generation: Gemini عن طريق LangChain (prompt templates + structured output بـ zod)
   └─ Cloudflare KV: فهرس المنهج + الواجبات + الحد اليومي لكل طالب
```

ليه Cloudflare Worker مش Cloud Functions؟ لأن المشروع على خطة **Spark** المجانية، والـ Cloud Functions محتاجة Blaze. والأهم إن **مفتاح Gemini لازم يفضل على السيرفر** وميتحطش في الـ HTML أبداً.

## الأمان
- مفتاح Gemini سرّ في Cloudflare (`wrangler secret`) ومش موجود في أي كود للواجهة.
- كل طلب لازم يكون معاه Firebase token سليم.
- الإجابة النموذجية ومعايير التصحيح متتبعتش للطالب خالص، وموجودة في KV مش في Firestore.
- صلاحية المعلم بالإيميل (`TEACHER_EMAILS`) ولازم الإيميل يكون verified.
- حد يومي لكل طالب (`DAILY_LIMIT`) عشان محدش يستهلك الحصة المجانية.
- CORS مقفول على دومين المنصة بس.
- حماية من prompt injection: إجابة الطالب معزولة كبيانات، والدرجة بتتقص على السيرفر في حدود الدرجة النهائية.
- الواجهة بتعرض ردود الـ AI كنص (من غير innerHTML)، فمفيش XSS.

## خطوات التشغيل (ويندوز)

1. **مفتاح Gemini:** من https://aistudio.google.com/apikey
2. **حساب Cloudflare** مجاني، وبعدين جوه الفولدر:
   ```
   npm install
   npx wrangler login
   npx wrangler kv namespace create RAG_KV
   ```
   حط الـ id اللي يطلع في `wrangler.toml` مكان `PUT_YOUR_KV_ID_HERE`.
3. **الأسرار:** `npx wrangler secret put GEMINI_API_KEY` وبعدها `npx wrangler secret put TEACHER_EMAILS` (إيميلات المعلم مفصولة بفاصلة)
4. **المنهج:** حط الدروس كملفات `.md` أو `.txt` في فولدر `curriculum/` (ملف لكل درس، وأول سطر `# اسم الدرس`). الملفين الموجودين أمثلة، امسحهم أو بدّلهم.
   ```
   set GEMINI_API_KEY=المفتاح
   node scripts/ingest.mjs
   npx wrangler kv key put curriculum_index --path index.json --binding RAG_KV --remote
   ```
5. **النشر:** `npx wrangler deploy` (هيديك لينك زي `https://barmagti-ai.xxx.workers.dev`)
6. **في المنصة:** حط `public/barmagti-ai.js` جنب الـ index.html وضيف:
   ```html
   <div id="ai-box"></div>
   <script src="barmagti-ai.js"></script>
   <script>
     BarmagtiAI.mount(document.getElementById("ai-box"), {
       apiUrl: "https://barmagti-ai.xxx.workers.dev",
       getToken: () => firebase.auth().currentUser.getIdToken(), // compat
       // أو مع الـ modular: () => auth.currentUser.getIdToken()
     });
   </script>
   ```
   وبعدين `firebase deploy --only hosting`.
7. أول ما تدخل بإيميل المعلم هيظهرلك تاب **"واجبات (المعلم)"** تضيف منه الواجبات.

## الاختبار
`npm test` بيشغّل 9 سيناريوهات من غير إنترنت (تسجيل الدخول، المصادر، CORS، صلاحيات المعلم، إخفاء الإجابة النموذجية، prompt injection، الحد اليومي...).

## ملاحظات
- لو المنهج PDF: حوّله لنص الأول وراجع الكلام العربي (الـ PDF العربي ساعات بيطلع مقلوب)، وقسّمه ملف لكل درس.
- `MIN_SCORE` في `wrangler.toml`: لو المساعد بيجيب أجزاء مش ليها علاقة ارفعه، ولو بيقول "مش في المنهج" كتير نزّله.
- الموديل `gemini-flash-latest` بيتحدّث لوحده، وتقدر تغيّره من `CHAT_MODEL`.

## سطر للـ CV
> Built a RAG system for an e-learning platform (Barmagti): an AI study assistant grounded in the official curriculum and an AI homework grader with rubric-based structured feedback — LangChain.js, Gemini embeddings, vector similarity search, Cloudflare Workers, Firebase Auth.
