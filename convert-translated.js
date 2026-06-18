// EPUB → translated PDF, with the original images kept in their positions.
//
// Unlike the plain-text pipeline (to-text → clean → translate → txt-to-pdf),
// this never leaves HTML: each chapter's text nodes are translated in place,
// then images/CSS are inlined and the chapter is rendered to PDF. Because only
// text nodes are touched, every <img> stays exactly where the author put it.
//
// Pipeline:
//   1. Translate each chapter's text  (slow, network-bound, resumable)
//   2. Render translated chapters → PDF with inlined images (local)
import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { parseEpub, renderToPdf } from "./epub-lib.js";
import { translateHtml, buildSegmentCleaner } from "./translate-html.js";

const SAVE_EVERY_N_CHAPTERS = 1; // translation is expensive — checkpoint often

function progressPathFor(outputPath) {
  const dir = path.dirname(outputPath);
  const base = path.basename(outputPath, path.extname(outputPath));
  return path.join(dir, `.${base}_htmltranslate_progress.json`);
}

async function loadProgress(progressPath, from, to, total) {
  try {
    const data = JSON.parse(await fs.readFile(progressPath, "utf-8"));
    if (data.from === from && data.to === to && data.total === total) return data;
  } catch {
    /* no / stale progress */
  }
  return { from, to, total, byHref: {} };
}

async function saveProgress(progressPath, data) {
  await fs.writeFile(progressPath, JSON.stringify(data), "utf-8");
}

async function convertTranslated(epubPath, outputPath, { from, to, rulesPath }) {
  const parsed = await parseEpub(epubPath);
  const { zip, spineItems, title, author } = parsed;
  const total = spineItems.length;

  console.log(`  Title: ${title || "(unknown)"}`);
  console.log(`  Author: ${author || "(unknown)"}`);

  const cleanSegment = rulesPath ? await buildSegmentCleaner(rulesPath) : null;
  if (cleanSegment) console.log(`  Cleaning rules: ${rulesPath}`);

  // ── Phase 1: translate every chapter's text (resumable) ──────────────────
  const progressPath = progressPathFor(outputPath);
  const progress = await loadProgress(progressPath, from, to, total);
  const alreadyDone = Object.keys(progress.byHref).length;

  console.log(`\n🌐 Phase 1/2 — Translating ${total} chapters (${from} → ${to})`);
  if (alreadyDone > 0) console.log(`🔄 Resuming: ${alreadyDone}/${total} chapters already translated`);
  console.log("");

  const startTime = Date.now();
  for (let i = 0; i < total; i++) {
    const item = spineItems[i];
    if (progress.byHref[item.href] !== undefined) continue; // already translated

    const raw = await zip.file(item.href)?.async("string");
    if (!raw) {
      progress.byHref[item.href] = ""; // nothing to render for this chapter
      continue;
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const label = item.href.split("/").pop();
    process.stdout.write(`\r  [${(((i + 1) / total) * 100).toFixed(1)}%] Chapter ${i + 1}/${total}: ${label} | ${elapsed}s        `);

    const translated = await translateHtml(raw, {
      from,
      to,
      cleanSegment,
      onProgress: (d, t) =>
        process.stdout.write(`\r  [${(((i + 1) / total) * 100).toFixed(1)}%] Chapter ${i + 1}/${total}: ${label} | seg ${d}/${t} | ${elapsed}s   `),
    });

    progress.byHref[item.href] = translated;

    if ((i + 1) % SAVE_EVERY_N_CHAPTERS === 0) {
      await saveProgress(progressPath, progress);
    }
  }
  await saveProgress(progressPath, progress);
  console.log(`\n\n✅ Translation complete (${((Date.now() - startTime) / 1000).toFixed(1)}s)`);

  // ── Phase 2: render translated chapters → PDF (images inlined) ───────────
  console.log(`\n🖼  Phase 2/2 — Rendering PDF with original images in place`);
  await renderToPdf(parsed, outputPath, {
    transformHtml: (rawHtml, href) =>
      progress.byHref[href] !== undefined ? progress.byHref[href] : rawHtml,
  });

  // Success — drop the progress checkpoint.
  if (existsSync(progressPath)) await fs.unlink(progressPath).catch(() => {});
}

// ── CLI ────────────────────────────────────────────────────────────────────
const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const args = process.argv.slice(2);

if (args.length < 1 || args.includes("--help")) {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║       EPUB → Translated PDF (images kept in place)       ║
║  Translates the book and renders to PDF without losing    ║
║  the original images or their positions.                  ║
╚══════════════════════════════════════════════════════════╝

Usage:
  node convert-translated.js <input.epub> [output.pdf] [options]

Options:
  --from <lang>    Source language (default: en)
  --to <lang>      Target language (default: es)
  --rules <file>   Cleaning rules to apply before translating
                   (default: clean-rules.json; use --no-clean to skip)
  --no-clean       Do not apply any cleaning rules
  --help           Show this help

Examples:
  node convert-translated.js book.epub
  node convert-translated.js book.epub out.pdf --from en --to es
`);
  process.exit(args.length < 1 ? 1 : 0);
}

let input = null;
let output = null;
let from = "en";
let to = "es";
let rulesPath = path.join(SCRIPT_DIR, "clean-rules.json");
let doClean = true;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--from" && args[i + 1]) from = args[++i];
  else if (a === "--to" && args[i + 1]) to = args[++i];
  else if (a === "--rules" && args[i + 1]) rulesPath = path.resolve(args[++i]);
  else if (a === "--no-clean") doClean = false;
  else if (!input) input = path.resolve(a);
  else if (!output) output = path.resolve(a);
}

if (!input || !/\.epub$/i.test(input)) {
  console.error("❌ Input must be a .epub file. Use --help for usage.");
  process.exit(1);
}
if (!output) {
  output = input.replace(/\.epub$/i, `_${to}.pdf`);
}
try {
  await fs.access(input);
} catch {
  console.error(`❌ File not found: ${input}`);
  process.exit(1);
}
if (doClean && !existsSync(rulesPath)) {
  console.warn(`⚠ Rules file not found, skipping cleaning: ${rulesPath}`);
  doClean = false;
}

const startTime = Date.now();
await convertTranslated(input, output, { from, to, rulesPath: doClean ? rulesPath : null });
const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\n${"═".repeat(60)}`);
console.log(`✅ Done in ${elapsed}s → ${output}`);
console.log("═".repeat(60));
