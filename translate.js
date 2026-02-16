import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import translate from "google-translate-api-x";

// ── Configuration ──────────────────────────────────────────────────────────
const CHUNK_MAX_CHARS = 4500;       // Google Translate limit is ~5000 chars
const DELAY_BETWEEN_MS = 1500;      // base delay between requests (ms)
const DELAY_JITTER_MS = 1000;       // random jitter added to delay
const MAX_RETRIES = 10;             // max retry attempts per chunk
const RETRY_BASE_DELAY_MS = 3000;   // initial retry delay (doubles each attempt)
const SAVE_EVERY_N_CHUNKS = 20;     // save progress every N chunks
const SOURCE_LANG = "en";
const TARGET_LANG = "es";

// ── Helpers ────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay() {
  return DELAY_BETWEEN_MS + Math.random() * DELAY_JITTER_MS;
}

// ── Split text into translatable chunks ────────────────────────────────────
// Splits on paragraph boundaries (\n\n) to avoid cutting mid-sentence.
// If a single paragraph exceeds CHUNK_MAX_CHARS, falls back to sentence split.
function splitIntoChunks(text) {
  const paragraphs = text.split(/\n\n+/);
  const chunks = [];
  let current = "";

  for (const para of paragraphs) {
    // If a single paragraph is too long, split by sentences
    if (para.length > CHUNK_MAX_CHARS) {
      if (current.trim()) {
        chunks.push(current.trim());
        current = "";
      }
      const sentences = splitLongParagraph(para);
      for (const sentence of sentences) {
        if (current.length + sentence.length + 2 > CHUNK_MAX_CHARS) {
          if (current.trim()) chunks.push(current.trim());
          current = sentence;
        } else {
          current += (current ? " " : "") + sentence;
        }
      }
      continue;
    }

    const separator = "\n\n";
    if (current.length + separator.length + para.length > CHUNK_MAX_CHARS) {
      if (current.trim()) chunks.push(current.trim());
      current = para;
    } else {
      current += (current ? separator : "") + para;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function splitLongParagraph(para) {
  // Split by sentence endings
  const parts = para.match(/[^.!?]+[.!?]+[\s]*/g) || [para];
  return parts.map((s) => s.trim()).filter(Boolean);
}

// ── Translate a single chunk with retries ──────────────────────────────────
async function translateChunk(text, chunkIndex, totalChunks) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await translate(text, {
        from: SOURCE_LANG,
        to: TARGET_LANG,
      });
      return result.text;
    } catch (err) {
      const retryDelay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      const maxWait = Math.min(retryDelay, 120_000); // cap at 2 min

      if (attempt === MAX_RETRIES) {
        console.error(
          `\n   ❌ Chunk ${chunkIndex + 1}/${totalChunks}: Failed after ${MAX_RETRIES} attempts.`
        );
        console.error(`      Error: ${err.message}`);
        console.error(`      Keeping original text for this chunk.`);
        return `[TRANSLATION FAILED]\n${text}`;
      }

      console.warn(
        `\n   ⚠ Chunk ${chunkIndex + 1}/${totalChunks}: Attempt ${attempt}/${MAX_RETRIES} failed (${err.message}).`
      );
      console.warn(`     Retrying in ${(maxWait / 1000).toFixed(1)}s...`);
      await sleep(maxWait);
    }
  }
}

// ── Progress management ────────────────────────────────────────────────────
function getProgressPath(inputPath) {
  const dir = path.dirname(inputPath);
  const base = path.basename(inputPath, path.extname(inputPath));
  return path.join(dir, `.${base}_translate_progress.json`);
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
async function translateFile(inputPath, outputPath) {
  console.log(`📄 Reading: ${inputPath}`);
  const text = await fs.readFile(inputPath, "utf-8");
  const inputSizeKb = (Buffer.byteLength(text) / 1024).toFixed(0);
  console.log(`   Size: ${inputSizeKb} KB | Characters: ${text.length.toLocaleString()}`);

  console.log(`\n✂  Splitting into chunks (max ${CHUNK_MAX_CHARS} chars each)...`);
  const chunks = splitIntoChunks(text);
  console.log(`   Total chunks: ${chunks.length}`);

  // Check for previous progress
  const progressPath = getProgressPath(inputPath);
  let progress = await loadProgress(progressPath);
  let translatedChunks = [];
  let startIndex = 0;

  if (progress && progress.totalChunks === chunks.length) {
    startIndex = progress.completedChunks;
    translatedChunks = progress.translated;
    console.log(`\n🔄 Resuming from chunk ${startIndex + 1}/${chunks.length} (previous progress found)`);
  } else {
    translatedChunks = new Array(chunks.length).fill(null);
  }

  console.log(`\n🌐 Translating ${SOURCE_LANG} → ${TARGET_LANG}...\n`);
  const startTime = Date.now();

  for (let i = startIndex; i < chunks.length; i++) {
    const chunk = chunks[i];
    const progress_pct = ((i / chunks.length) * 100).toFixed(1);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const rate = i > startIndex ? ((i - startIndex) / ((Date.now() - startTime) / 1000)).toFixed(1) : "—";

    process.stdout.write(
      `\r   [${progress_pct}%] Chunk ${i + 1}/${chunks.length} | ${elapsed}s elapsed | ${rate} chunks/s    `
    );

    // Skip empty/whitespace chunks
    if (!chunk.trim()) {
      translatedChunks[i] = chunk;
      continue;
    }

    // Check if chunk is a structural separator (===, ---, ###) — don't translate
    if (/^[=\-─#\s]+$/.test(chunk)) {
      translatedChunks[i] = chunk;
      continue;
    }

    const translated = await translateChunk(chunk, i, chunks.length);
    translatedChunks[i] = translated;

    // Save progress periodically
    if ((i + 1) % SAVE_EVERY_N_CHUNKS === 0) {
      await saveProgress(progressPath, {
        totalChunks: chunks.length,
        completedChunks: i + 1,
        translated: translatedChunks,
      });
    }

    // Delay before next request
    if (i < chunks.length - 1) {
      await sleep(randomDelay());
    }
  }

  // Assemble final text
  console.log(`\n\n📝 Assembling translated document...`);
  const result = translatedChunks.join("\n\n");
  await fs.writeFile(outputPath, result, "utf-8");

  // Remove progress file on success
  if (existsSync(progressPath)) {
    await fs.unlink(progressPath);
  }

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
const args = process.argv.slice(2);

if (args.length < 1 || args.includes("--help")) {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║          Large Document Translator (EN → ES)             ║
║  Uses Google Translate with rate limiting, retries,      ║
║  and progress saving for huge text files.                ║
╚══════════════════════════════════════════════════════════╝

Usage:
  node translate.js <input.txt> [output.txt] [options]

Options:
  --from <lang>    Source language (default: en)
  --to <lang>      Target language (default: es)

Examples:
  node translate.js book.txt
  node translate.js book.txt book_es.txt
  node translate.js book.txt --from en --to fr

Features:
  • Splits text into safe chunks (~4500 chars)
  • 1.5-2.5s delay between requests (avoids rate limits)
  • Auto-retry on failure (up to 10 times with exponential backoff)
  • Saves progress every 20 chunks (resume if interrupted)
  • Preserves structural markers (headings, separators)

Language codes: en, es, fr, de, it, pt, ja, ko, zh, ru, ar, hi...
`);
  process.exit(0);
}

// Parse arguments
let inputFile = null;
let outputFile = null;
let fromLang = SOURCE_LANG;
let toLang = TARGET_LANG;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--from" && args[i + 1]) {
    fromLang = args[++i];
  } else if (args[i] === "--to" && args[i + 1]) {
    toLang = args[++i];
  } else if (!inputFile) {
    inputFile = path.resolve(args[i]);
  } else if (!outputFile) {
    outputFile = path.resolve(args[i]);
  }
}

if (!outputFile) {
  const ext = path.extname(inputFile);
  const base = inputFile.slice(0, -ext.length || undefined);
  outputFile = `${base}_${toLang}${ext}`;
}

try {
  await fs.access(inputFile);
} catch {
  console.error(`❌ File not found: ${inputFile}`);
  process.exit(1);
}

const startTime = Date.now();
await translateFile(inputFile, outputFile);
const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`   Total time: ${elapsed}s`);
