import fs from "fs/promises";
import path from "path";
import readline from "readline";
import { createReadStream, createWriteStream } from "fs";

// ── Default rules file ─────────────────────────────────────────────────────
const DEFAULT_RULES_PATH = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "clean-rules.json"
);

// ── Load rules ─────────────────────────────────────────────────────────────
async function loadRules(rulesPath) {
  const raw = await fs.readFile(rulesPath, "utf-8");
  const rules = JSON.parse(raw);

  const compiled = [];

  // 1. Exact multi-line blocks to remove
  if (rules.blocks) {
    for (const block of rules.blocks) {
      compiled.push({
        type: "block",
        label: block.label || block.text.substring(0, 40) + "...",
        text: block.text,
      });
    }
  }

  // 2. Line-level patterns: remove any line matching these regex patterns
  if (rules.linePatterns) {
    for (const entry of rules.linePatterns) {
      compiled.push({
        type: "linePattern",
        label: entry.label || entry.pattern,
        regex: new RegExp(entry.pattern, entry.flags || "i"),
      });
    }
  }

  // 3. Substring replacements (e.g., remove inline ads, fix OCR errors)
  if (rules.replacements) {
    for (const entry of rules.replacements) {
      compiled.push({
        type: "replacement",
        label: entry.label || entry.find,
        find: entry.regex ? new RegExp(entry.find, entry.flags || "gi") : entry.find,
        replaceWith: entry.replaceWith ?? "",
        isRegex: !!entry.regex,
      });
    }
  }

  return compiled;
}

// ── Apply rules ────────────────────────────────────────────────────────────
function applyRules(text, rules) {
  let result = text;
  const stats = new Map();

  for (const rule of rules) {
    stats.set(rule.label, 0);
  }

  // Pass 1: Remove exact multi-line blocks
  for (const rule of rules) {
    if (rule.type !== "block") continue;
    let count = 0;
    while (result.includes(rule.text)) {
      result = result.replace(rule.text, "");
      count++;
    }
    stats.set(rule.label, count);
  }

  // Pass 2: Line-level filtering and replacements
  const lines = result.split("\n");
  const filtered = [];

  for (const line of lines) {
    let skip = false;

    for (const rule of rules) {
      if (rule.type !== "linePattern") continue;
      if (rule.regex.test(line)) {
        stats.set(rule.label, (stats.get(rule.label) || 0) + 1);
        skip = true;
        break;
      }
    }

    if (skip) continue;

    let processedLine = line;
    for (const rule of rules) {
      if (rule.type !== "replacement") continue;
      if (rule.isRegex) {
        const matches = processedLine.match(rule.find);
        if (matches) {
          stats.set(rule.label, (stats.get(rule.label) || 0) + matches.length);
        }
        processedLine = processedLine.replace(rule.find, rule.replaceWith);
      } else {
        let count = 0;
        while (processedLine.includes(rule.find)) {
          processedLine = processedLine.replace(rule.find, rule.replaceWith);
          count++;
        }
        if (count > 0) stats.set(rule.label, (stats.get(rule.label) || 0) + count);
      }
    }

    filtered.push(processedLine);
  }

  result = filtered.join("\n");

  // Clean up excessive blank lines left by removals
  result = result.replace(/\n{4,}/g, "\n\n\n");

  return { result, stats };
}

// ── Stream-based processing for huge files ─────────────────────────────────
async function cleanFile(inputPath, outputPath, rulesPath) {
  console.log(`📋 Loading rules from: ${rulesPath}`);
  const rules = await loadRules(rulesPath);
  console.log(`   Loaded ${rules.length} rules:\n`);
  for (const rule of rules) {
    const typeIcon = { block: "🔲", linePattern: "📏", replacement: "🔄" };
    console.log(`   ${typeIcon[rule.type] || "•"} [${rule.type}] ${rule.label}`);
  }

  const inputStats = await fs.stat(inputPath);
  const sizeMb = (inputStats.size / 1024 / 1024).toFixed(2);
  console.log(`\n📄 Input: ${inputPath} (${sizeMb} MB)`);

  // For very large files (>50MB), process in chunks; otherwise load entirely
  const CHUNK_THRESHOLD = 50 * 1024 * 1024;

  if (inputStats.size > CHUNK_THRESHOLD) {
    console.log(`   Large file detected, using streaming mode...`);
    await cleanFileStreaming(inputPath, outputPath, rules);
  } else {
    console.log(`   Processing in memory...`);
    const text = await fs.readFile(inputPath, "utf-8");
    const { result, stats } = applyRules(text, rules);
    await fs.writeFile(outputPath, result, "utf-8");
    printStats(stats, inputPath, outputPath);
  }
}

async function cleanFileStreaming(inputPath, outputPath, rules) {
  // For streaming, we need to handle multi-line blocks differently.
  // We buffer a window of lines large enough to catch any block pattern.
  const maxBlockLines = Math.max(
    ...rules.filter((r) => r.type === "block").map((r) => r.text.split("\n").length),
    1
  );
  const bufferSize = maxBlockLines + 5;

  const rl = readline.createInterface({
    input: createReadStream(inputPath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  const outStream = createWriteStream(outputPath, { encoding: "utf-8" });
  const stats = new Map();
  for (const rule of rules) stats.set(rule.label, 0);

  const lineBuffer = [];
  let totalLines = 0;

  for await (const line of rl) {
    lineBuffer.push(line);
    totalLines++;

    if (totalLines % 100000 === 0) {
      process.stdout.write(`\r  Processed ${(totalLines / 1000).toFixed(0)}K lines...`);
    }

    if (lineBuffer.length >= bufferSize) {
      const processed = processBufferLine(lineBuffer, rules, stats);
      if (processed !== null) {
        outStream.write(processed + "\n");
      }
    }
  }

  // Flush remaining buffer
  while (lineBuffer.length > 0) {
    const processed = processBufferLine(lineBuffer, rules, stats);
    if (processed !== null) {
      outStream.write(processed + "\n");
    }
  }

  outStream.end();
  await new Promise((resolve) => outStream.on("finish", resolve));

  console.log(`\n`);
  printStats(stats, inputPath, outputPath);
}

function processBufferLine(buffer, rules, stats) {
  const line = buffer.shift();

  // Check line-level patterns
  for (const rule of rules) {
    if (rule.type !== "linePattern") continue;
    if (rule.regex.test(line)) {
      stats.set(rule.label, (stats.get(rule.label) || 0) + 1);
      return null; // skip this line
    }
  }

  // Check if this line starts a block match
  for (const rule of rules) {
    if (rule.type !== "block") continue;
    const blockLines = rule.text.split("\n");
    const windowText = [line, ...buffer.slice(0, blockLines.length - 1)].join("\n");
    if (windowText.startsWith(rule.text)) {
      // Remove the matched lines from the buffer
      const linesToRemove = blockLines.length - 1; // -1 because current line is already shifted
      buffer.splice(0, linesToRemove);
      stats.set(rule.label, (stats.get(rule.label) || 0) + 1);
      return null;
    }
  }

  // Apply replacements
  let processedLine = line;
  for (const rule of rules) {
    if (rule.type !== "replacement") continue;
    if (rule.isRegex) {
      const matches = processedLine.match(rule.find);
      if (matches) stats.set(rule.label, (stats.get(rule.label) || 0) + matches.length);
      processedLine = processedLine.replace(rule.find, rule.replaceWith);
    } else {
      let count = 0;
      while (processedLine.includes(rule.find)) {
        processedLine = processedLine.replace(rule.find, rule.replaceWith);
        count++;
      }
      if (count > 0) stats.set(rule.label, (stats.get(rule.label) || 0) + count);
    }
  }

  return processedLine;
}

async function printStats(stats, inputPath, outputPath) {
  const inputStats = await fs.stat(inputPath);
  const outputStats = await fs.stat(outputPath);

  console.log(`\n📊 Cleaning results:\n`);
  for (const [label, count] of stats) {
    if (count > 0) {
      console.log(`   ✂  ${label}: ${count} occurrence${count !== 1 ? "s" : ""} removed`);
    }
  }

  const removed = inputStats.size - outputStats.size;
  const pct = ((removed / inputStats.size) * 100).toFixed(1);
  console.log(`\n   Input:   ${(inputStats.size / 1024).toFixed(0)} KB`);
  console.log(`   Output:  ${(outputStats.size / 1024).toFixed(0)} KB`);
  console.log(`   Removed: ${(removed / 1024).toFixed(0)} KB (${pct}%)`);
  console.log(`\n✅ Cleaned file saved to: ${outputPath}`);
}

// ── CLI ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.length < 1) {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║              Text Content Cleaner                        ║
║  Remove unwanted text from plain text files based on     ║
║  configurable rules (blocks, patterns, replacements).    ║
╚══════════════════════════════════════════════════════════╝

Usage:
  node clean-text.js <input.txt> [output.txt] [--rules <rules.json>]

Arguments:
  input.txt          Input text file to clean
  output.txt         Output file (default: input_cleaned.txt)
  --rules <file>     Rules file (default: clean-rules.json)

Examples:
  node clean-text.js book.txt
  node clean-text.js book.txt book_clean.txt
  node clean-text.js book.txt --rules my-rules.json

Rules file format (clean-rules.json):
  See clean-rules.json for a full example with all rule types.
`);
  process.exit(1);
}

// Parse args
let inputFile = null;
let outputFile = null;
let rulesFile = DEFAULT_RULES_PATH;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--rules" && args[i + 1]) {
    rulesFile = path.resolve(args[++i]);
  } else if (!inputFile) {
    inputFile = path.resolve(args[i]);
  } else if (!outputFile) {
    outputFile = path.resolve(args[i]);
  }
}

if (!outputFile) {
  const ext = path.extname(inputFile);
  const base = inputFile.slice(0, -ext.length);
  outputFile = `${base}_cleaned${ext}`;
}

try {
  await fs.access(inputFile);
} catch {
  console.error(`❌ File not found: ${inputFile}`);
  process.exit(1);
}

try {
  await fs.access(rulesFile);
} catch {
  console.error(`❌ Rules file not found: ${rulesFile}`);
  console.error(`   Create one or use --rules to specify its path.`);
  process.exit(1);
}

const startTime = Date.now();
await cleanFile(inputFile, outputFile, rulesFile);
const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`   Time: ${elapsed}s`);
