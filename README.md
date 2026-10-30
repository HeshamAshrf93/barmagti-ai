# Barmagti AI — RAG Study Assistant & AI Homework Grader

Two LLM features for **[Barmagti](https://barmagti-platform.web.app)**, an e-learning platform that teaches Programming & AI to Egyptian first-year secondary students. ([العربي](README.ar.md))

1. **Study assistant (RAG):** answers student questions **only from the official curriculum**, cites the source lesson, and says "ask your teacher" instead of hallucinating when nothing relevant is found.
2. **Homework grader:** compares the student's answer with the teacher's model answer and rubric, and returns a structured score + strengths + mistakes with hints + next step, **without revealing the solution**.

## Architecture

```
Barmagti (Firebase Hosting + Auth)
   │  Firebase ID token
   ▼
Cloudflare Worker (Hono + LangChain.js)
   ├─ Auth: verifies Firebase ID tokens with jose against Google's public keys
   ├─ Retrieval: gemini-embedding-001 (768-d, RETRIEVAL_QUERY / RETRIEVAL_DOCUMENT) + cosine similarity + relevance threshold
   ├─ Generation: Gemini via LangChain prompt templates; grader uses withStructuredOutput + Zod schema
   └─ Cloudflare KV: curriculum index, assignments (model answers stay server-side), per-student daily quota
```

**Ingestion** (`scripts/ingest.mjs`): lesson files → `RecursiveCharacterTextSplitter` (Arabic-aware separators, 900/150) → batch embeddings → `index.json` → KV.

## Guardrails
- Gemini API key lives only in Worker secrets; nothing secret ships to the browser.
- Model answers and rubrics are never returned to students.
- Student input is isolated as data in its own message (prompt-injection resistant); the score is clamped server-side to `[0, maxScore]`.
- Teacher role by verified email allow-list; per-student daily limit; CORS restricted to the platform's origins.
- The widget renders model output as text nodes only (no `innerHTML`), so no XSS from LLM output.

## Why Cloudflare Workers?
The Firebase project is on the free Spark plan (Cloud Functions require Blaze). A Worker keeps the API key server-side at zero cost.

## Run
```bash
npm install
npm test                          # 9 offline scenarios with a mocked LLM, embeddings and KV
npx wrangler kv namespace create RAG_KV   # put the id in wrangler.toml
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put TEACHER_EMAILS   # comma-separated teacher emails
GEMINI_API_KEY=... node scripts/ingest.mjs
npx wrangler kv key put curriculum_index --path index.json --binding RAG_KV --remote
npx wrangler deploy
```
Embed `public/barmagti-ai.js` in the platform (see `public/demo.html`).

## Stack
LangChain.js · Gemini (gemini-embedding-001, gemini-flash-latest) · Zod · Hono · Cloudflare Workers & KV · Firebase Auth · jose
