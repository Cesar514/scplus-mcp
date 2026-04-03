// summary: Runs provider-backed chat generation for semantic synthesis tasks.
// FEATURE: Provider-backed structured chat generation for clusters and research.
// inputs: Prompt text, system instructions, provider settings, and structured mock callbacks.
// outputs: Parsed JSON responses from the configured chat model.

import { randomUUID } from "node:crypto";

const CHAT_TIMEOUT_MS = 90_000;
let chatAbortController = new AbortController();

const CHAT_PROVIDER = (process.env.SCPLUS_CHAT_PROVIDER ?? process.env.SCPLUS_EMBED_PROVIDER ?? "ollama").toLowerCase();
const OLLAMA_CHAT_MODEL = process.env.OLLAMA_CHAT_MODEL ?? "nemotron-3-nano:4b-128k";
const OPENAI_CHAT_MODEL = process.env.SCPLUS_OPENAI_CHAT_MODEL ?? process.env.OPENAI_CHAT_MODEL ?? "gpt-4.1-mini";
const OPENAI_API_KEY = process.env.SCPLUS_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
const OPENAI_BASE_URL = process.env.SCPLUS_OPENAI_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";

type OllamaGenerateClient = {
  generate: (params: Record<string, unknown>) => Promise<{ response: string }>;
};

export interface StructuredChatOptions<T> {
  system: string;
  prompt: string;
  mock: () => T;
  temperature?: number;
  maxTokens?: number;
  schema?: object;
}

let ollamaClient: OllamaGenerateClient | null = null;

export function cancelAllChats(): void {
  chatAbortController.abort();
  chatAbortController = new AbortController();
}

async function getOllamaClient(): Promise<OllamaGenerateClient> {
  if (!ollamaClient) {
    const { Ollama } = await import("ollama");
    ollamaClient = new Ollama({ host: process.env.OLLAMA_HOST }) as unknown as OllamaGenerateClient;
  }
  return ollamaClient;
}

function extractJsonPayload(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Chat model returned an empty response.");
  if (trimmed.startsWith("```")) {
    const withoutFence = trimmed
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
    if (withoutFence.trim()) return withoutFence.trim();
  }
  const objectStart = trimmed.indexOf("{");
  const arrayStart = trimmed.indexOf("[");
  const starts = [objectStart, arrayStart].filter((value) => value >= 0);
  if (starts.length === 0) throw new Error(`Chat model returned non-JSON output: ${trimmed.slice(0, 200)}`);
  const start = Math.min(...starts);
  const objectEnd = trimmed.lastIndexOf("}");
  const arrayEnd = trimmed.lastIndexOf("]");
  const end = Math.max(objectEnd, arrayEnd);
  if (end < start) throw new Error(`Chat model returned malformed JSON output: ${trimmed.slice(0, 200)}`);
  return trimmed.slice(start, end + 1);
}

async function callOllamaJson(options: StructuredChatOptions<unknown>, signal: AbortSignal): Promise<string> {
  const client = await getOllamaClient();
  const response = await client.generate({
    model: OLLAMA_CHAT_MODEL,
    system: options.system,
    prompt: options.prompt,
    format: options.schema ?? "json",
    options: {
      temperature: options.temperature ?? 0.2,
      num_predict: options.maxTokens,
    },
    keep_alive: "10s",
    signal,
  });
  return response.response;
}

async function callOpenAIJson(options: StructuredChatOptions<unknown>, signal: AbortSignal): Promise<string> {
  if (!OPENAI_API_KEY) throw new Error("SCPLUS_OPENAI_API_KEY or OPENAI_API_KEY is required for OpenAI chat generation.");
  const response = await fetch(`${OPENAI_BASE_URL.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_CHAT_MODEL,
      temperature: options.temperature ?? 0.2,
      max_completion_tokens: options.maxTokens,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: options.system },
        { role: "user", content: options.prompt },
      ],
    }),
    signal,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OpenAI chat API error ${response.status}: ${body}`);
  }
  const payload = await response.json() as {
    choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content
      .map((item) => (item?.type === "text" ? item.text ?? "" : ""))
      .join("")
      .trim();
    if (text) return text;
  }
  throw new Error("OpenAI chat API returned no message content.");
}

export async function generateStructuredChat<T>(options: StructuredChatOptions<T>): Promise<T> {
  if (CHAT_PROVIDER === "mock") {
    return options.mock();
  }

  const requestId = randomUUID();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Timed out waiting for chat generation ${requestId}.`)), CHAT_TIMEOUT_MS);
  const abortForwarder = () => controller.abort(chatAbortController.signal.reason ?? new Error("Chat generation cancelled."));
  chatAbortController.signal.addEventListener("abort", abortForwarder, { once: true });
  try {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const retrySystem = attempt === 0
          ? options.system
          : `${options.system} Your previous response was invalid. Return only valid JSON that matches the requested structure exactly.`;
        const raw = CHAT_PROVIDER === "openai"
          ? await callOpenAIJson({ ...options, system: retrySystem }, controller.signal)
          : await callOllamaJson({ ...options, system: retrySystem }, controller.signal);
        return JSON.parse(extractJsonPayload(raw)) as T;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`Chat generation ${requestId} failed after retries.`);
  } finally {
    clearTimeout(timeout);
    chatAbortController.signal.removeEventListener("abort", abortForwarder);
  }
}
