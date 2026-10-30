// الـ API بتاع برمجتي AI (Hono) — بياخد deps عشان يبقى قابل للاختبار
import { Hono } from "hono";
import { cors } from "hono/cors";
import { verifyFirebaseToken, isTeacher } from "./auth.js";
import { askAssistant, gradeAnswer } from "./rag.js";

const INDEX_KEY = "curriculum_index";
let indexCache = null; // كاش جوه الـ isolate
let indexCacheAt = 0;

async function loadIndex(kv) {
  if (indexCache && Date.now() - indexCacheAt < 5 * 60 * 1000) return indexCache;
  indexCache = await kv.get(INDEX_KEY, "json");
  indexCacheAt = Date.now();
  return indexCache;
}

const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * makeDeps(env) => { chatModel, queryEmbeddings, verifier? }
 */
export function createApp(makeDeps) {
  const app = new Hono();

  app.use("/api/*", async (c, next) => {
    const allowed = (c.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
    return cors({
      origin: (origin) => (allowed.includes(origin) ? origin : null),
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type"],
      maxAge: 86400,
    })(c, next);
  });

  // ---- تسجيل الدخول: لازم Firebase token ----
  app.use("/api/*", async (c, next) => {
    if (c.req.method === "OPTIONS") return next();
    const deps = makeDeps(c.env);
    const token = (c.req.header("Authorization") || "").replace(/^Bearer\s+/i, "");
    const user = await verifyFirebaseToken(token, c.env.FIREBASE_PROJECT_ID, deps.verifier);
    if (!user) return c.json({ error: "لازم تسجّل دخول الأول" }, 401);
    c.set("user", user);
    c.set("deps", deps);
    c.set("teacher", isTeacher(user, c.env.TEACHER_EMAILS) && user.emailVerified);
    await next();
  });

  // ---- حد يومي لكل طالب (حماية من الاستهلاك الزيادة) ----
  async function rateLimit(c) {
    if (c.get("teacher")) return true;
    const limit = Number(c.env.DAILY_LIMIT || 40);
    const day = new Date().toISOString().slice(0, 10);
    const key = `rl:${c.get("user").uid}:${day}`;
    const used = Number((await c.env.RAG_KV.get(key)) || 0);
    if (used >= limit) return false;
    await c.env.RAG_KV.put(key, String(used + 1), { expirationTtl: 60 * 60 * 26 });
    return true;
  }

  app.get("/api/me", (c) => c.json({ uid: c.get("user").uid, teacher: c.get("teacher") }));

  // ---- مساعد المذاكرة ----
  app.post("/api/ask", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const question = String(body.question || "").trim();
    if (!question || question.length > 1000) return c.json({ error: "اكتب سؤال (لحد 1000 حرف)" }, 400);
    if (!(await rateLimit(c))) return c.json({ error: "خلّصت عدد الأسئلة النهارده، كمّل بكرة 🙂" }, 429);
    const history = Array.isArray(body.history) ? body.history : [];
    const index = await loadIndex(c.env.RAG_KV);
    if (!index) return c.json({ error: "المنهج لسه مترفعش، كلّم المعلم" }, 503);
    const { chatModel, queryEmbeddings } = c.get("deps");
    try {
      return c.json(await askAssistant({ index, queryEmbeddings, chatModel, question, history, minScore: Number(c.env.MIN_SCORE || 0.5) }));
    } catch (e) {
      console.error("ask failed", e);
      return c.json({ error: "حصلت مشكلة، جرّب تاني كمان شوية" }, 502);
    }
  });

  // ---- الواجبات (للطالب: من غير الإجابة النموذجية) ----
  app.get("/api/assignments", async (c) => {
    const list = await listAssignments(c.env.RAG_KV);
    if (c.get("teacher")) return c.json(list);
    return c.json(list.map(({ modelAnswer, rubric, ...pub }) => pub));
  });

  // ---- مصحّح الواجبات ----
  app.post("/api/grade", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const id = String(body.assignmentId || "");
    const answer = String(body.answer || "").trim();
    if (!ID_RE.test(id)) return c.json({ error: "رقم الواجب غلط" }, 400);
    if (!answer || answer.length > 8000) return c.json({ error: "اكتب إجابتك (لحد 8000 حرف)" }, 400);
    const assignment = await c.env.RAG_KV.get(`assignment:${id}`, "json");
    if (!assignment) return c.json({ error: "الواجب ده مش موجود" }, 404);
    if (!(await rateLimit(c))) return c.json({ error: "خلّصت عدد المحاولات النهارده، كمّل بكرة 🙂" }, 429);
    const index = await loadIndex(c.env.RAG_KV);
    const { chatModel, queryEmbeddings } = c.get("deps");
    try {
      const result = await gradeAnswer({ index, queryEmbeddings, chatModel, assignment, answer, minScore: Number(c.env.MIN_SCORE || 0.5) });
      return c.json({ assignmentId: id, ...result });
    } catch (e) {
      console.error("grade failed", e);
      return c.json({ error: "حصلت مشكلة في التصحيح، جرّب تاني" }, 502);
    }
  });

  // ---- لوحة المعلم: إضافة/تعديل/حذف واجب ----
  app.put("/api/teacher/assignments/:id", async (c) => {
    if (!c.get("teacher")) return c.json({ error: "للمعلم بس" }, 403);
    const id = c.req.param("id");
    if (!ID_RE.test(id)) return c.json({ error: "الـ id لازم حروف إنجليزي وأرقام و - _ بس" }, 400);
    const b = await c.req.json().catch(() => ({}));
    const a = {
      id,
      title: String(b.title || "").slice(0, 200),
      question: String(b.question || "").slice(0, 4000),
      modelAnswer: String(b.modelAnswer || "").slice(0, 8000),
      rubric: String(b.rubric || "").slice(0, 3000),
      maxScore: Math.max(1, Math.min(100, Number(b.maxScore) || 10)),
      lesson: String(b.lesson || "").slice(0, 200),
      updatedAt: new Date().toISOString(),
    };
    if (!a.title || !a.question || !a.modelAnswer) return c.json({ error: "العنوان والسؤال والإجابة النموذجية مطلوبين" }, 400);
    await c.env.RAG_KV.put(`assignment:${id}`, JSON.stringify(a));
    return c.json(a);
  });

  app.delete("/api/teacher/assignments/:id", async (c) => {
    if (!c.get("teacher")) return c.json({ error: "للمعلم بس" }, 403);
    const id = c.req.param("id");
    if (!ID_RE.test(id)) return c.json({ error: "id غلط" }, 400);
    await c.env.RAG_KV.delete(`assignment:${id}`);
    return c.json({ ok: true });
  });

  app.get("/", (c) => c.text("Barmagti AI is running ✅"));
  return app;
}

async function listAssignments(kv) {
  const { keys } = await kv.list({ prefix: "assignment:" });
  const items = await Promise.all(keys.map((k) => kv.get(k.name, "json")));
  return items.filter(Boolean).sort((a, b) => a.id.localeCompare(b.id));
}

// للاختبارات
export function _resetIndexCache() {
  indexCache = null;
}
