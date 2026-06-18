import fs from "fs/promises";
import path from "path";
import { parseEpub, renderToPdf } from "./epub-lib.js";

// ── Convert an EPUB to PDF (text, images and structure preserved) ──────────
async function convertToPdf(epubPath, outputPath) {
  const parsed = await parseEpub(epubPath);
  await renderToPdf(parsed, outputPath);
}

// ── CLI Entry Point ────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.length < 1) {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║              EPUB → PDF Converter                        ║
║  Handles large books (5000+ pages) without losing        ║
║  text, images, or structure.                             ║
╚══════════════════════════════════════════════════════════╝

Usage:
  node convert.js <input.epub> [output.pdf]

Examples:
  node convert.js book.epub
  node convert.js book.epub output.pdf

Options:
  If no output path is given, the PDF will be saved
  next to the EPUB with the same name.
`);
  process.exit(1);
}

const inputEpub = path.resolve(args[0]);
const outputPdf = args[1]
  ? path.resolve(args[1])
  : inputEpub.replace(/\.epub$/i, ".pdf");

try {
  await fs.access(inputEpub);
} catch {
  console.error(`❌ File not found: ${inputEpub}`);
  process.exit(1);
}

const startTime = Date.now();
await convertToPdf(inputEpub, outputPdf);
const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`   Time elapsed: ${elapsed}s`);
