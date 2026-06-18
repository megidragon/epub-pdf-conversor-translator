// HTML-aware translator.
//
// Translates only the visible *text nodes* of an HTML/XHTML document, leaving
// every tag, attribute and inline resource untouched. In particular <img> tags
// (and their src/base64 data) pass through verbatim, so images stay exactly
// where they were in the original markup.
//
// Text segments are batched (Google Translate accepts arrays) to keep the
// number of network requests low, with rate limiting + exponential-backoff
// retries reused from the project's translate.js conventions.
import fs from "fs/promises";
import path from "path";
import { decode } from "html-entities";
import translate from "google-translate-api-x";

// ── Configuration ──────────────────────────────────────────────────────────
const CHUNK_MAX_CHARS = 4500; // Google Translate hard limit is ~5000 chars/request
const MAX_SEGMENTS_PER_BATCH = 80; // also cap segment count per request
const DELAY_BETWEEN_MS = 1200; // base delay between requests (ms)
const DELAY_JITTER_MS = 800; // random jitter added to delay
const MAX_RETRIES = 10; // max retry attempts per batch
const RETRY_BASE_DELAY_MS = 3000; // initial retry delay (doubles each attempt)

// Skip these elements' text content entirely (it is code/markup, not prose).
const SKIP_TAGS = new Set(["script", "style"]);

// ── Helpers ────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay() {
  return DELAY_BETWEEN_MS + Math.random() * DELAY_JITTER_MS;
}

// Minimal HTML escaping for translated text re-inserted as a text node.
// Accented/Unicode characters are kept as UTF-8 (output is a UTF-8 document).
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Does the string contain anything actually worth translating (a letter)?
function hasTranslatableText(s) {
  return /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/.test(s);
}

// ── Tokenize HTML into tags/comments and text nodes ────────────────────────
// Note: EPUB content is XHTML, so a simple tag matcher is reliable enough here
// (consistent with the regex-based parsing used elsewhere in this project).
const TAG_RE = /<!--[\s\S]*?-->|<[^>]*>/g;

function tokenizeHtml(html) {
  const tokens = []; // { type: "tag" | "text", value, skip? }
  let lastIndex = 0;
  let skipDepth = 0;
  let m;
  TAG_RE.lastIndex = 0;

  while ((m = TAG_RE.exec(html)) !== null) {
    if (m.index > lastIndex) {
      tokens.push({ type: "text", value: html.slice(lastIndex, m.index), skip: skipDepth > 0 });
    }
    const tag = m[0];
    tokens.push({ type: "tag", value: tag });

    if (!tag.startsWith("<!--")) {
      const open = /^<\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(tag);
      const close = /^<\s*\/\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(tag);
      const selfClosing = /\/\s*>$/.test(tag);
      if (close && SKIP_TAGS.has(close[1].toLowerCase())) {
        if (skipDepth > 0) skipDepth--;
      } else if (open && !selfClosing && SKIP_TAGS.has(open[1].toLowerCase())) {
        skipDepth++;
      }
    }
    lastIndex = TAG_RE.lastIndex;
  }
  if (lastIndex < html.length) {
    tokens.push({ type: "text", value: html.slice(lastIndex), skip: skipDepth > 0 });
  }
  return tokens;
}

// ── Translate a batch of plain strings with retries ────────────────────────
async function translateBatch(strings, from, to) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await translate(strings, { from, to });
      // Array input -> array of result objects, aligned by index.
      return result.map((r, i) => r?.text ?? strings[i]);
    } catch (err) {
      if (attempt === MAX_RETRIES) {
        console.error(`\n   ❌ Batch of ${strings.length} segment(s) failed after ${MAX_RETRIES} attempts: ${err.message}`);
        console.error(`      Keeping original text for these segments.`);
        return strings.slice();
      }
      const retryDelay = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1), 120_000);
      console.warn(`\n   ⚠ Batch attempt ${attempt}/${MAX_RETRIES} failed (${err.message}). Retrying in ${(retryDelay / 1000).toFixed(1)}s...`);
      await sleep(retryDelay);
    }
  }
}

// ── Group segment strings into request-sized batches ───────────────────────
function buildBatches(segments) {
  const batches = [];
  let current = [];
  let currentChars = 0;

  for (const seg of segments) {
    const len = seg.length;
    // A single oversized segment becomes its own batch (the API splits it).
    if (len > CHUNK_MAX_CHARS) {
      if (current.length) {
        batches.push(current);
        current = [];
        currentChars = 0;
      }
      batches.push([seg]);
      continue;
    }
    if (current.length >= MAX_SEGMENTS_PER_BATCH || currentChars + len > CHUNK_MAX_CHARS) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(seg);
    currentChars += len;
  }
  if (current.length) batches.push(current);
  return batches;
}

/**
 * Translate the visible text of an HTML string, preserving all markup/images.
 *
 * @param {string} html
 * @param {object} opts
 * @param {string} opts.from              Source language (default "en")
 * @param {string} opts.to                Target language (default "es")
 * @param {(text: string) => (string|null)} [opts.cleanSegment]
 *        Optional cleaner applied to each decoded text segment BEFORE
 *        translation. Return a replacement string, or null/"" to drop it.
 * @param {(done: number, total: number) => void} [opts.onProgress]
 * @returns {Promise<string>} translated HTML
 */
export async function translateHtml(html, opts = {}) {
  const { from = "en", to = "es", cleanSegment = null, onProgress = null } = opts;

  const tokens = tokenizeHtml(html);

  // 1. Collect translatable text segments, recording where they go.
  const jobs = []; // { tokenIndex, lead, trail, core }
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.type !== "text" || tok.skip) continue;

    const raw = tok.value;
    const lead = raw.match(/^\s*/)[0];
    const trail = raw.length > lead.length ? raw.match(/\s*$/)[0] : "";
    const coreEncoded = raw.slice(lead.length, raw.length - trail.length);
    if (!coreEncoded) continue; // whitespace only

    let core = decode(coreEncoded);

    // Optional cleaning (drop promo lines, apply replacements, ...).
    if (cleanSegment) {
      const cleaned = cleanSegment(core);
      if (cleaned == null || cleaned.trim() === "") {
        tok.value = lead + trail; // drop the prose, keep surrounding whitespace
        continue;
      }
      core = cleaned;
    }

    if (!hasTranslatableText(core)) {
      // Numbers / punctuation only — leave as-is (but apply any cleaning result).
      if (cleanSegment) tok.value = lead + escapeHtml(core) + trail;
      continue;
    }

    jobs.push({ tokenIndex: i, lead, trail, core });
  }

  // 2. Translate the collected cores in batches.
  const cores = jobs.map((j) => j.core);
  const batches = buildBatches(cores);
  const translated = new Array(cores.length);

  let coreCursor = 0;
  let done = 0;
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const out = await translateBatch(batch, from, to);
    for (let k = 0; k < batch.length; k++) {
      translated[coreCursor + k] = out[k];
    }
    coreCursor += batch.length;
    done += batch.length;
    if (onProgress) onProgress(done, cores.length);
    if (b < batches.length - 1) await sleep(randomDelay());
  }

  // 3. Re-insert translated text back into its tokens.
  for (let j = 0; j < jobs.length; j++) {
    const { tokenIndex, lead, trail } = jobs[j];
    tokens[tokenIndex].value = lead + escapeHtml(translated[j] ?? jobs[j].core) + trail;
  }

  return tokens.map((t) => t.value).join("");
}

// ── Optional cleaning rules (subset of clean-rules.json) ───────────────────
// Builds a per-segment cleaner: drops segments matching a linePattern, and
// applies block removals + replacements. Block rules that span multiple HTML
// elements can't be matched here; single-node promo blocks still are.
export async function buildSegmentCleaner(rulesPath) {
  const raw = await fs.readFile(rulesPath, "utf-8");
  const rules = JSON.parse(raw);

  const blocks = (rules.blocks || []).map((b) => b.text);
  const linePatterns = (rules.linePatterns || []).map(
    (e) => new RegExp(e.pattern, e.flags || "i")
  );
  const replacements = (rules.replacements || []).map((e) => ({
    find: e.regex ? new RegExp(e.find, e.flags || "gi") : e.find,
    replaceWith: e.replaceWith ?? "",
    isRegex: !!e.regex,
  }));

  return function cleanSegment(text) {
    // Drop whole segment if it matches a line pattern (promo lines, etc.)
    for (const re of linePatterns) {
      if (re.test(text)) return null;
    }
    let out = text;
    for (const block of blocks) {
      if (out.includes(block)) out = out.split(block).join("");
    }
    for (const r of replacements) {
      if (r.isRegex) out = out.replace(r.find, r.replaceWith);
      else out = out.split(r.find).join(r.replaceWith);
    }
    return out;
  };
}

// ── CLI (handy for testing a single HTML/XHTML file) ───────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (isMain) {
  const args = process.argv.slice(2);
  if (args.length < 1 || args.includes("--help")) {
    console.log(`
HTML-aware translator (preserves tags & images)

Usage:
  node translate-html.js <input.html> [output.html] [options]

Options:
  --from <lang>   Source language (default: en)
  --to <lang>     Target language (default: es)
  --rules <file>  Apply cleaning rules to text before translating
`);
    process.exit(args.length < 1 ? 1 : 0);
  }

  let input = null;
  let output = null;
  let from = "en";
  let to = "es";
  let rulesPath = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--from" && args[i + 1]) from = args[++i];
    else if (a === "--to" && args[i + 1]) to = args[++i];
    else if (a === "--rules" && args[i + 1]) rulesPath = path.resolve(args[++i]);
    else if (!input) input = path.resolve(a);
    else if (!output) output = path.resolve(a);
  }
  if (!output) {
    const ext = path.extname(input);
    output = input.slice(0, -ext.length || undefined) + `_${to}` + ext;
  }

  const html = await fs.readFile(input, "utf-8");
  const cleanSegment = rulesPath ? await buildSegmentCleaner(rulesPath) : null;
  process.stdout.write(`🌐 Translating ${from} → ${to}...\n`);
  const result = await translateHtml(html, {
    from,
    to,
    cleanSegment,
    onProgress: (d, t) => process.stdout.write(`\r   [${((d / t) * 100 || 0).toFixed(1)}%] ${d}/${t} segments`),
  });
  await fs.writeFile(output, result, "utf-8");
  console.log(`\n✅ Done! Output: ${output}`);
}
