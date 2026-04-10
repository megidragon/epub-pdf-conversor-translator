import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";

// ── Configuration ──────────────────────────────────────────────────────────
const DEFAULT_ENDPOINT = "http://localhost:1234/v1";
const DEFAULT_TARGET_LANG = "ES";
const DEFAULT_CHUNK_CHARS = 2500;   // chars per chunk sent to the model
const SAVE_EVERY_N_CHUNKS = 10;     // save progress every N chunks

// ── Helpers ────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Split text into chunks on paragraph boundaries ─────────────────────────
function splitIntoChunks(text, maxChars) {
  const paragraphs = text.split(/\n\n+/);
  const chunks = [];
  let current = "";

  for (const para of paragraphs) {
    if (para.length > maxChars) {
      if (current.trim()) {
        chunks.push(current.trim());
        current = "";
      }
      // Split long paragraph by sentences
      const sentences = para.match(/[^.!?]+[.!?]+[\s]*/g) || [para];
      for (const sentence of sentences) {
        if (current.length + sentence.length > maxChars) {
          if (current.trim()) chunks.push(current.trim());
          current = sentence.trim();
        } else {
          current += (current ? " " : "") + sentence.trim();
        }
      }
      continue;
    }

    if (current.length + 2 + para.length > maxChars) {
      if (current.trim()) chunks.push(current.trim());
      current = para;
    } else {
      current += (current ? "\n\n" : "") + para;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

// ── Check if chunk is a structural separator (don't translate) ─────────────
function isStructural(text) {
  return /^[=\-─#═\s]+$/.test(text);
}

// ── Call LM Studio chat completions API ────────────────────────────────────
async function callLMStudio(endpoint, model, systemPrompt, userText) {
  const url = `${endpoint}/chat/completions`;
  const body = {
    model: model || undefined,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userText },
    ],
    temperature: 0.2,
    stream: false,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`HTTP ${res.status}: ${errText}`);
  }

  const json = await res.json();
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty response from model");
  return content.trim();
}

// ── Translate a single chunk with retries ──────────────────────────────────
async function translateChunk(chunk, index, total, { endpoint, model, systemPrompt, maxRetries }) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await callLMStudio(endpoint, model, systemPrompt, chunk);
    } catch (err) {
      if (attempt === maxRetries) {
        console.error(`\n   ❌ Chunk ${index + 1}/${total}: Failed after ${maxRetries} attempts.`);
        console.error(`      ${err.message}`);
        return `[TRANSLATION FAILED]\n${chunk}`;
      }
      const wait = Math.min(2000 * attempt, 30_000);
      console.warn(`\n   ⚠ Chunk ${index + 1}/${total}: Attempt ${attempt} failed (${err.message}). Retrying in ${wait / 1000}s...`);
      await sleep(wait);
    }
  }
}

// ── Progress management ────────────────────────────────────────────────────
function getProgressPath(inputPath, targetLang) {
  const dir = path.dirname(inputPath);
  const base = path.basename(inputPath, path.extname(inputPath));
  return path.join(dir, `.${base}_ai_${targetLang}_progress.json`);
}

async function loadProgress(progressPath) {
  try {
    const raw = await fs.readFile(progressPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveProgress(progressPath, data) {
  await fs.writeFile(progressPath, JSON.stringify(data, null, 2), "utf-8");
}

// ── Main translation function ──────────────────────────────────────────────
async function translateFile(inputPath, outputPath, { endpoint, model, targetLang, chunkChars, maxRetries }) {
  console.log(`📄 Reading: ${inputPath}`);
  const text = await fs.readFile(inputPath, "utf-8");
  const inputSizeKb = (Buffer.byteLength(text) / 1024).toFixed(0);
  console.log(`   Size: ${inputSizeKb} KB | Characters: ${text.length.toLocaleString()}`);

  console.log(`\n✂  Splitting into chunks (max ${chunkChars} chars each)...`);
  const chunks = splitIntoChunks(text, chunkChars);
  console.log(`   Total chunks: ${chunks.length}`);

  // System prompt for the model
  const langNames = {
    ES: "Spanish", EN: "English", FR: "French", DE: "German",
    IT: "Italian", PT: "Portuguese", JA: "Japanese", KO: "Korean",
    ZH: "Chinese", RU: "Russian", AR: "Arabic",
  };
  const langName = langNames[targetLang.toUpperCase()] || targetLang;
  const systemPrompt =
    `You are a professional literary translator. Translate the following text to ${langName}. ` +
    `Output ONLY the translated text — no explanations, no notes, no alternatives. ` +
    `Preserve all formatting, line breaks, and structural markers exactly as they appear.`;

  // Check for previous progress
  const progressPath = getProgressPath(inputPath, targetLang);
  let saved = await loadProgress(progressPath);
  let translatedChunks = [];
  let startIndex = 0;

  if (saved && saved.totalChunks === chunks.length) {
    startIndex = saved.completedChunks;
    translatedChunks = saved.translated;
    console.log(`\n🔄 Resuming from chunk ${startIndex + 1}/${chunks.length}`);
  } else {
    translatedChunks = new Array(chunks.length).fill(null);
  }

  // Verify LM Studio is reachable
  console.log(`\n🔌 Connecting to LM Studio at ${endpoint}...`);
  try {
    const modelsRes = await fetch(`${endpoint}/models`);
    if (!modelsRes.ok) throw new Error(`HTTP ${modelsRes.status}`);
    const modelsJson = await modelsRes.json();
    const available = modelsJson.data?.map((m) => m.id) || [];
    if (available.length === 0) {
      console.warn(`   ⚠ No models loaded in LM Studio. Make sure a model is running.`);
    } else {
      const active = model || available[0];
      console.log(`   Model: ${active}`);
      if (!model) model = active; // auto-select first loaded model
    }
  } catch (err) {
    console.error(`❌ Cannot reach LM Studio at ${endpoint}: ${err.message}`);
    console.error(`   Make sure LM Studio is running with a model loaded and the server is enabled.`);
    process.exit(1);
  }

  console.log(`\n🌐 Translating → ${targetLang} using AI...\n`);
  const startTime = Date.now();

  for (let i = startIndex; i < chunks.length; i++) {
    const chunk = chunks[i];
    const pct = ((i / chunks.length) * 100).toFixed(1);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    process.stdout.write(`\r   [${pct}%] Chunk ${i + 1}/${chunks.length} | ${elapsed}s elapsed    `);

    if (!chunk.trim() || isStructural(chunk)) {
      translatedChunks[i] = chunk;
      continue;
    }

    translatedChunks[i] = await translateChunk(chunk, i, chunks.length, {
      endpoint, model, systemPrompt, maxRetries,
    });

    if ((i + 1) % SAVE_EVERY_N_CHUNKS === 0) {
      await saveProgress(progressPath, {
        totalChunks: chunks.length,
        completedChunks: i + 1,
        translated: translatedChunks,
      });
    }
  }

  // Assemble and write output
  console.log(`\n\n📝 Assembling translated document...`);
  const result = translatedChunks.join("\n\n");
  await fs.writeFile(outputPath, result, "utf-8");

  // Remove progress file on success
  if (existsSync(progressPath)) await fs.unlink(progressPath);

  const outputSizeKb = (Buffer.byteLength(result) / 1024).toFixed(0);
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  const failedCount = translatedChunks.filter((c) => c?.startsWith("[TRANSLATION FAILED]")).length;

  console.log(`\n✅ Translation complete!`);
  console.log(`   Output: ${outputPath}`);
  console.log(`   Size: ${outputSizeKb} KB`);
  console.log(`   Time: ${totalTime}s`);
  if (failedCount > 0) {
    console.log(`   ⚠ ${failedCount} chunk(s) could not be translated (marked in output)`);
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────
const rawArgs = process.argv.slice(2);

if (rawArgs.length === 0 || rawArgs.includes("--help")) {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║         AI Translator via LM Studio (local LLM)          ║
║  Translates large .txt files using a locally running     ║
║  model through the LM Studio OpenAI-compatible API.      ║
╚══════════════════════════════════════════════════════════╝

Usage:
  node translate-ai.js <input.txt> [output.txt] [options]

Options:
  --to <LANG>          Target language code (default: ES)
  --endpoint <url>     LM Studio base URL (default: http://localhost:1234/v1)
  --model <id>         Model ID to use (default: auto, uses first loaded model)
  --chunk <chars>      Max characters per chunk (default: ${DEFAULT_CHUNK_CHARS})
  --retries <n>        Max retries per chunk (default: 3)

Output filename (when not specified):
  <input>_<LANG>_by_ia.txt

Examples:
  node translate-ai.js book.txt
  node translate-ai.js book.txt --to FR
  node translate-ai.js book.txt translated.txt --to DE
  node translate-ai.js book.txt --endpoint http://localhost:1234/v1 --model "llama-3"

Language codes: ES, EN, FR, DE, IT, PT, JA, KO, ZH, RU, AR...
`);
  process.exit(0);
}

// Parse arguments
let inputFile = null;
let outputFile = null;
let targetLang = DEFAULT_TARGET_LANG;
let endpoint = DEFAULT_ENDPOINT;
let model = null;
let chunkChars = DEFAULT_CHUNK_CHARS;
let maxRetries = 3;

for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a === "--to" && rawArgs[i + 1]) { targetLang = rawArgs[++i].toUpperCase(); }
  else if (a === "--endpoint" && rawArgs[i + 1]) { endpoint = rawArgs[++i]; }
  else if (a === "--model" && rawArgs[i + 1]) { model = rawArgs[++i]; }
  else if (a === "--chunk" && rawArgs[i + 1]) { chunkChars = parseInt(rawArgs[++i], 10); }
  else if (a === "--retries" && rawArgs[i + 1]) { maxRetries = parseInt(rawArgs[++i], 10); }
  else if (!a.startsWith("--") && !inputFile) { inputFile = path.resolve(a); }
  else if (!a.startsWith("--") && !outputFile) { outputFile = path.resolve(a); }
}

if (!inputFile) {
  console.error("❌ No input file specified.");
  process.exit(1);
}

if (!outputFile) {
  const ext = path.extname(inputFile);
  const base = inputFile.slice(0, inputFile.length - ext.length);
  outputFile = `${base}_${targetLang}_by_ia${ext}`;
}

try {
  await fs.access(inputFile);
} catch {
  console.error(`❌ File not found: ${inputFile}`);
  process.exit(1);
}

await translateFile(inputFile, outputFile, { endpoint, model, targetLang, chunkChars, maxRetries });
