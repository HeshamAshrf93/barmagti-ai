# Barmagti AI Tutor — curriculum RAG with evals

The "Ask the teacher" assistant inside **[Barmagti](https://barmagti.abp-ai.org)**, a live self-study platform for the Egyptian
Grade-10 *Programming & AI* curriculum (12 units, 50 lessons). Students ask in Egyptian Arabic; the tutor answers from the
curriculum only, in Egyptian Arabic, and shows where each answer came from (lesson, card, textbook pages, one-click link).

Runs on free tiers: Cloudflare Workers + Vectorize, Gemini embeddings, Groq and Gemini for generation.

## How it works

```mermaid
flowchart LR
  S[Student question + open lesson] --> W[Cloudflare Worker]
  W -->|gemini-embedding-001, 1024-d| V[(Vectorize: 303 chunks)]
  V -->|top 12| R[Hybrid re-rank: vector + keyword + open-lesson boost]
  R -->|top 4 + open lesson's quiz| P[Prompt]
  P --> L[Groq gpt-oss → Gemini fallback chain]
  L --> A[Answer + sources shown under it]
  R -. best score below 0.57 .-> O[Out of curriculum: politely decline]
  V -. index or embeddings down .-> F[Fallback: whole open lesson as context]
```

- **Chunking:** one chunk per lesson card (title + narration + key points, ≤1,800 characters), stable ids (`u8l2:c1`).
- **Embeddings:** `gemini-embedding-001` with `RETRIEVAL_DOCUMENT` / `RETRIEVAL_QUERY` task types, 1024-d, normalised.
- **Hybrid ranking:** cosine + 0.25 × keyword overlap (Arabic-normalised: أ/إ/آ→ا, ة→ه, no harakat) + 0.04 boost for the open lesson.
- **Sources:** up to 3 chunks within 0.06 of the best score are shown under the answer.
- **Out-of-curriculum detection:** best cosine below 0.57 → the model is told nothing relevant exists.
- **Exam integrity:** the open lesson's quiz answers are in the prompt only so the tutor gives hints, not answers.
- **Reliability:** if retrieval fails the tutor falls back to the whole open lesson; each LLM provider gets 12 s.

## Evaluation

`evals/run.mjs` runs 80 questions against the deployed Worker ([full report](evals/REPORT.md)): 68 curriculum questions
(33 asked while a *different* lesson is open, 22 paraphrased in the student's own words without textbook terms),
4 "just give me the quiz answer", 5 off-topic, 3 prompt injections.

**Retrieval** (is a correct card among the 4 chunks the model sees?):

| Method | Hit@1 | Hit@4 | MRR | Hit@4, other lesson open | Hit@4, student's own words |
|---|---|---|---|---|---|
| Before: whole open lesson | — | 29% | — | 0% | 0% |
| Vector only | 88% | 93% | 0.90 | 91% | 100% |
| **Hybrid (shipped)** | **90%** | **99%** | **0.94** | **97%** | 95% |

**Answers** (LLM-as-judge: a separate model grades every answer):

| | RAG + prompt v2 |
|---|---|
| Curriculum questions answered | 100% (100% with another lesson open) |
| No invented facts (faithfulness) | 98% |
| In Egyptian Arabic, not MSA | 93% |
| Hint instead of quiz answer | 100% |
| Declines off-topic questions | 100% |
| Resists prompt injection | 100% |

Decisions the evals drove:
- **Embeddings switched from `bge-m3` (Workers AI) to Gemini:** Hit@4 94% → 99%, and paraphrased questions 82% → 95%.
  It also stopped the daily Workers AI quota from running out.
- **Threshold 0.57:** curriculum questions score 0.61–0.81 and off-topic ones 0.47–0.59, so 0.57 rejects no real question;
  the model declines the rest.
- **Re-ranker model dropped:** no gain over the hybrid score, one extra call.
- **Prompt v2:** answers were drifting into Modern Standard Arabic and leaking chunk numbers like "[1]".

Latency: p50 1.2 s. The eval's p95 (7 s) comes from 160 back-to-back calls hitting Groq's free-tier rate limit.

## Run it

```bash
npm test                     # 18 offline tests (fake embeddings, Vectorize and LLMs)
npx wrangler vectorize create barmagti-curriculum --dimensions=1024 --metric=cosine
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put ADMIN_TOKEN   # protects /admin/reindex and the eval endpoints
npx wrangler deploy
npm run reindex
npm run eval                 # writes evals/REPORT.md (resumable)
```

`units/` holds the curriculum exactly as the platform serves it; the Worker fetches it from the site at runtime.

Security: keys are Worker secrets; the public endpoint accepts only the platform's origins, a per-IP rate limit and
500 characters per question; `/admin/*` needs a bearer token compared in constant time; provider errors never reach students.

---
Built by [Hesham Ashraf](https://www.linkedin.com/in/hesham-ashrf) — AI Engineer & AI Product Builder
