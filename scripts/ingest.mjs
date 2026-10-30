// تجهيز المنهج: يقرا ملفات الدروس، يقسّمها، يعمل embeddings، ويطلّع index.json
// التشغيل:  set GEMINI_API_KEY=xxx  (ويندوز)   ثم   node scripts/ingest.mjs
// للتجربة من غير مفتاح:  node scripts/ingest.mjs --fake
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, extname, basename } from "node:path";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { TaskType } from "@google/generative-ai";

const DIR = process.argv.find((a) => a.startsWith("--dir="))?.slice(6) || "curriculum";
const OUT = process.argv.find((a) => a.startsWith("--out="))?.slice(6) || "index.json";
const FAKE = process.argv.includes("--fake");
const DIMS = 768;

function lessonTitle(file, text) {
  const h = text.match(/^#\s+(.+)$/m);
  return (h ? h[1] : basename(file, extname(file))).trim();
}

// embeddings وهمية للتجربة بس (بتعتمد على الكلمات)
export function fakeEmbed(text) {
  const v = new Array(DIMS).fill(0);
  for (const w of text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
    let h = 0;
    for (const ch of w) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    v[h % DIMS] += 1;
  }
  return v;
}

async function main() {
  const files = (await readdir(DIR)).filter((f) => [".md", ".txt"].includes(extname(f).toLowerCase())).sort();
  if (!files.length) throw new Error(`مفيش ملفات .md أو .txt في فولدر ${DIR}`);

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 900,
    chunkOverlap: 150,
    separators: ["\n## ", "\n### ", "\n\n", "\n", ". ", "، ", " ", ""],
  });

  const chunks = [];
  for (const f of files) {
    const text = (await readFile(join(DIR, f), "utf8")).replace(/\r\n/g, "\n");
    const lesson = lessonTitle(f, text);
    const parts = await splitter.splitText(text);
    parts.forEach((p, i) => chunks.push({ id: `${basename(f, extname(f))}#${i}`, lesson, source: f, text: p.trim() }));
  }
  console.log(`📚 ${files.length} درس → ${chunks.length} قطعة`);

  let vectors;
  if (FAKE) {
    vectors = chunks.map((c) => fakeEmbed(`${c.lesson}\n${c.text}`));
  } else {
    if (!process.env.GEMINI_API_KEY) throw new Error("حط GEMINI_API_KEY الأول");
    const emb = new GoogleGenerativeAIEmbeddings({
      apiKey: process.env.GEMINI_API_KEY,
      model: "gemini-embedding-001",
      taskType: TaskType.RETRIEVAL_DOCUMENT,
      outputDimensionality: DIMS,
    });
    vectors = [];
    const B = 50;
    for (let i = 0; i < chunks.length; i += B) {
      const batch = chunks.slice(i, i + B).map((c) => `${c.lesson}\n${c.text}`);
      vectors.push(...(await emb.embedDocuments(batch)));
      console.log(`  ✓ ${Math.min(i + B, chunks.length)}/${chunks.length}`);
    }
  }

  const index = {
    model: FAKE ? "fake" : "gemini-embedding-001",
    dims: DIMS,
    createdAt: new Date().toISOString(),
    chunks: chunks.map((c, i) => ({ ...c, embedding: vectors[i].map((x) => Math.round(x * 1e5) / 1e5) })),
  };
  await writeFile(OUT, JSON.stringify(index));
  console.log(`✅ اتعمل ${OUT}. ارفعه بالأمر:\n   npx wrangler kv key put curriculum_index --path ${OUT} --binding RAG_KV --remote`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("ingest.mjs")) {
  main().catch((e) => {
    console.error("❌", e.message);
    process.exit(1);
  });
}
