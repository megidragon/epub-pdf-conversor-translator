import fs from "fs/promises";
import path from "path";

// ── CLI ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

if (args.length < 1 || args.includes("--help")) {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║         Translate Progress JSON → TXT Compiler           ║
║  Compiles the partial progress file written by           ║
║  translate.js / translate-ai.js into a readable .txt.    ║
╚══════════════════════════════════════════════════════════╝

Usage:
  node progress-to-txt.js <progress.json> [output.txt]

Arguments:
  progress.json    Path to the .<name>_translate_progress.json file
                   (hidden file saved by translate.js)
  output.txt       Output file (default: <progress>_partial.txt next to the JSON)

Examples:
  node progress-to-txt.js docs/.The-Boss-Behind-The-Game_translate_progress.json
  node progress-to-txt.js docs/.book_translate_progress.json book_partial.txt
`);
  process.exit(args.length < 1 ? 1 : 0);
}

const inputFile = path.resolve(args[0]);
let outputFile = args[1] ? path.resolve(args[1]) : null;

try {
  await fs.access(inputFile);
} catch {
  console.error(`❌ File not found: ${inputFile}`);
  process.exit(1);
}

if (!outputFile) {
  const dir = path.dirname(inputFile);
  let base = path.basename(inputFile, ".json");
  // Strip leading dot (hidden file) and trailing "_translate_progress" / "_ai_XX_progress"
  if (base.startsWith(".")) base = base.slice(1);
  base = base.replace(/_translate_progress$/, "")
             .replace(/_ai_[A-Z]+_progress$/, "");
  outputFile = path.join(dir, `${base}_partial.txt`);
}

console.log(`📄 Reading progress: ${inputFile}`);
const raw = await fs.readFile(inputFile, "utf-8");
const data = JSON.parse(raw);

const total = data.totalChunks ?? data.translated?.length ?? 0;
const completed = data.completedChunks ?? 0;
const translated = Array.isArray(data.translated) ? data.translated : [];

if (translated.length === 0) {
  console.error("❌ No translated chunks found in progress file.");
  process.exit(1);
}

// Keep only non-null chunks (the ones actually translated so far)
const done = translated.filter((c) => c !== null && c !== undefined);
const failed = done.filter((c) => typeof c === "string" && c.startsWith("[TRANSLATION FAILED]")).length;

console.log(`   Total chunks:     ${total.toLocaleString()}`);
console.log(`   Completed chunks: ${completed.toLocaleString()}`);
console.log(`   Non-null chunks:  ${done.length.toLocaleString()}`);
if (failed > 0) {
  console.log(`   ⚠ Failed chunks:  ${failed.toLocaleString()} (kept with [TRANSLATION FAILED] marker)`);
}

const pct = total > 0 ? ((done.length / total) * 100).toFixed(1) : "0.0";
console.log(`   Progress:         ${pct}%`);

// Assemble — same separator used by translate.js when finalizing
const result = done.join("\n\n");

await fs.writeFile(outputFile, result, "utf-8");

const stats = await fs.stat(outputFile);
const sizeKb = (stats.size / 1024).toFixed(0);
const sizeMb = (stats.size / 1024 / 1024).toFixed(2);

console.log(`\n✅ Done! Output: ${outputFile}`);
console.log(`   Size: ${stats.size > 1048576 ? sizeMb + " MB" : sizeKb + " KB"}`);
console.log(`   Characters: ${result.length.toLocaleString()}`);