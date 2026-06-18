import { spawn } from "child_process";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function runStep(label, scriptName, args) {
  return new Promise((resolve, reject) => {
    const sep = "═".repeat(60);
    console.log(`\n${sep}\n▶ ${label}\n  node ${scriptName} ${args.join(" ")}\n${sep}`);

    const child = spawn(process.execPath, [path.join(SCRIPT_DIR, scriptName), ...args], {
      stdio: "inherit",
      cwd: SCRIPT_DIR,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${scriptName} exited with code ${code}`));
    });
  });
}

function withSuffix(filePath, suffix) {
  const ext = path.extname(filePath);
  return filePath.slice(0, -ext.length) + suffix + ext;
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

const args = process.argv.slice(2);

if (args.length < 1 || args.includes("--help")) {
  console.log(`
EPUB → TXT → Clean → Translate → PDF (all-in-one)

Usage:
  node process-epub.js <input.epub> [options]

Options:
  --from <lang>      Source language (default: en)
  --to <lang>        Target language (default: es)
  --rules <file>     Cleaning rules file (default: clean-rules.json)
  --keep-images      Preserve the original EPUB images in the PDF, in their
                     correct positions (translates the book in HTML form
                     instead of going through plain text)
  --no-clean         Skip the cleaning step
  --no-translate     Skip the translation step
  --no-pdf           Skip the PDF generation step
  --help             Show this help

Default pipeline (plain text, images become "[Image]" markers):
  1. to-text.js      <book>.epub          -> <book>.txt
  2. clean-text.js   <book>.txt           -> <book>_cleaned.txt
  3. translate.js    <book>_cleaned.txt   -> <book>_cleaned_<to>.txt
  4. txt-to-pdf.js   <book>_cleaned_<to>.txt -> .pdf

With --keep-images (single step, images preserved):
  convert-translated.js  <book>.epub  ->  <book>_<to>.pdf

Examples:
  node process-epub.js docs/book.epub --from en --to es
  node process-epub.js docs/book.epub --keep-images --from en --to es
`);
  process.exit(args.length < 1 ? 1 : 0);
}

let inputEpub = null;
let fromLang = "en";
let toLang = "es";
let rulesFile = path.join(SCRIPT_DIR, "clean-rules.json");
let doClean = true;
let doTranslate = true;
let doPdf = true;
let keepImages = false;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--from" && args[i + 1]) fromLang = args[++i];
  else if (a === "--to" && args[i + 1]) toLang = args[++i];
  else if (a === "--rules" && args[i + 1]) rulesFile = path.resolve(args[++i]);
  else if (a === "--keep-images") keepImages = true;
  else if (a === "--no-clean") doClean = false;
  else if (a === "--no-translate") doTranslate = false;
  else if (a === "--no-pdf") doPdf = false;
  else if (!inputEpub) inputEpub = path.resolve(a);
}

if (!inputEpub) {
  console.error("❌ Missing input EPUB. Use --help for usage.");
  process.exit(1);
}
if (!/\.epub$/i.test(inputEpub)) {
  console.error(`❌ Input must be a .epub file: ${inputEpub}`);
  process.exit(1);
}
if (!(await fileExists(inputEpub))) {
  console.error(`❌ File not found: ${inputEpub}`);
  process.exit(1);
}
if (doClean && !(await fileExists(rulesFile))) {
  console.error(`❌ Rules file not found: ${rulesFile}`);
  process.exit(1);
}

const startTime = Date.now();
let currentFile = inputEpub;

// ── Image-preserving mode ──────────────────────────────────────────────────
// Stays in HTML the whole way so the original images keep their positions.
if (keepImages) {
  try {
    if (doTranslate) {
      const cvtArgs = [inputEpub, "--from", fromLang, "--to", toLang];
      if (doClean) cvtArgs.push("--rules", rulesFile);
      else cvtArgs.push("--no-clean");
      await runStep(
        "EPUB → Translated PDF (images preserved)",
        "convert-translated.js",
        cvtArgs
      );
      currentFile = inputEpub.replace(/\.epub$/i, `_${toLang}.pdf`);
    } else {
      // No translation requested — just convert to PDF (images preserved).
      await runStep("EPUB → PDF (images preserved)", "convert.js", [inputEpub]);
      currentFile = inputEpub.replace(/\.epub$/i, ".pdf");
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n${"═".repeat(60)}`);
    console.log(`✅ Pipeline complete in ${elapsed}s`);
    console.log(`   Final output: ${currentFile}`);
    console.log("═".repeat(60));
    process.exit(0);
  } catch (err) {
    console.error(`\n❌ Pipeline failed: ${err.message}`);
    process.exit(1);
  }
}

try {
  // 1. EPUB -> TXT
  await runStep("Step 1/4: Extracting text from EPUB", "to-text.js", [currentFile]);
  currentFile = inputEpub.replace(/\.epub$/i, ".txt");
  if (!(await fileExists(currentFile))) {
    throw new Error(`Expected output not found: ${currentFile}`);
  }

  // 2. Clean
  if (doClean) {
    await runStep("Step 2/4: Cleaning text", "clean-text.js", [
      currentFile,
      "--rules",
      rulesFile,
    ]);
    currentFile = withSuffix(currentFile, "_cleaned");
    if (!(await fileExists(currentFile))) {
      throw new Error(`Expected output not found: ${currentFile}`);
    }
  } else {
    console.log("\n⏭  Skipping clean step (--no-clean)");
  }

  // 3. Translate
  if (doTranslate) {
    await runStep("Step 3/4: Translating", "translate.js", [
      currentFile,
      "--from",
      fromLang,
      "--to",
      toLang,
    ]);
    currentFile = withSuffix(currentFile, `_${toLang}`);
    if (!(await fileExists(currentFile))) {
      throw new Error(`Expected output not found: ${currentFile}`);
    }
  } else {
    console.log("\n⏭  Skipping translate step (--no-translate)");
  }

  // 4. TXT -> PDF
  if (doPdf) {
    await runStep("Step 4/4: Generating PDF", "txt-to-pdf.js", [currentFile]);
    const pdfPath = currentFile.replace(/\.txt$/i, ".pdf");
    if (await fileExists(pdfPath)) currentFile = pdfPath;
  } else {
    console.log("\n⏭  Skipping pdf step (--no-pdf)");
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${"═".repeat(60)}`);
  console.log(`✅ Pipeline complete in ${elapsed}s`);
  console.log(`   Final output: ${currentFile}`);
  console.log("═".repeat(60));
} catch (err) {
  console.error(`\n❌ Pipeline failed: ${err.message}`);
  process.exit(1);
}
