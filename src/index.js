// نقطة البداية في Cloudflare Workers
import { ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { TaskType } from "@google/generative-ai";
import { createApp } from "./app.js";

const app = createApp((env) => ({
  chatModel: new ChatGoogleGenerativeAI({
    apiKey: env.GEMINI_API_KEY, // سرّ في Cloudflare، عمره ما بيوصل للمتصفح
    model: env.CHAT_MODEL || "gemini-flash-latest",
    temperature: 0.2,
    maxOutputTokens: 1500,
  }),
  queryEmbeddings: new GoogleGenerativeAIEmbeddings({
    apiKey: env.GEMINI_API_KEY,
    model: "gemini-embedding-001",
    taskType: TaskType.RETRIEVAL_QUERY,
    outputDimensionality: 768,
  }),
}));

export default app;
