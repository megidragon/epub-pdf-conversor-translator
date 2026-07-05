import fs from "fs/promises";
import path from "path";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import { decode } from "html-entities";

// ── XML Parser ─────────────────────────────────────────────────────────────
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name) => ["item", "itemref"].includes(name),
});

function resolveHref(base, href) {
  const dir = base.includes("/") ? base.substring(0, base.lastIndexOf("/")) : "";
  const resolved = dir ? `${dir}/${href}` : href;
  const parts = resolved.split("/");
  const normalized = [];
  for (const p of parts) {
    if (p === "..") normalized.pop();
    else if (p !== ".") normalized.push(p);
  }
  return normalized.join("/");
}

// ── Parse EPUB structure ───────────────────────────────────────────────────
async function parseEpub(epubPath) {
  console.log(`📖 Reading EPUB: ${epubPath}`);
  const data = await fs.readFile(epubPath);
  const zip = await JSZip.loadAsync(data);

  const containerXml = await zip.file("META-INF/container.xml")?.async("string");
  if (!containerXml) throw new Error("Invalid EPUB: missing META-INF/container.xml");
  const container = xmlParser.parse(containerXml);
  const rootfilePath =
    container.container?.rootfiles?.rootfile?.["@_full-path"] ||
    container.container?.rootfiles?.rootfile?.[0]?.["@_full-path"];
  if (!rootfilePath) throw new Error("Cannot find rootfile path in container.xml");

  const opfXml = await zip.file(rootfilePath)?.async("string");
  if (!opfXml) throw new Error(`Cannot read OPF file: ${rootfilePath}`);
  const opf = xmlParser.parse(opfXml);

  const pkg = opf["package"] || opf["opf:package"];
  const manifest = pkg.manifest;
  const spine = pkg.spine;
  const metadata = pkg.metadata || pkg["opf:metadata"];

  // Build manifest map
  let items = manifest.item || manifest["opf:item"] || [];
  if (!Array.isArray(items)) items = [items];
  const manifestMap = new Map();
  for (const item of items) {
    manifestMap.set(item["@_id"], {
      href: item["@_href"],
      mediaType: item["@_media-type"],
    });
  }

  // Get spine order
  let itemrefs = spine.itemref || spine["opf:itemref"] || [];
  if (!Array.isArray(itemrefs)) itemrefs = [itemrefs];
  const spineItems = [];
  for (const ref of itemrefs) {
    const idref = ref["@_idref"];
    const entry = manifestMap.get(idref);
    if (entry) {
      spineItems.push({
        id: idref,
        href: resolveHref(rootfilePath, entry.href),
        mediaType: entry.mediaType,
      });
    }
  }

  // Extract title and author from metadata
  let title = "";
  let author = "";
  if (metadata) {
    const dcTitle = metadata["dc:title"];
    title = typeof dcTitle === "object" ? dcTitle["#text"] || "" : dcTitle || "";
    const dcCreator = metadata["dc:creator"];
    author = typeof dcCreator === "object" ? dcCreator["#text"] || "" : dcCreator || "";
  }

  console.log(`  Title: ${title || "(unknown)"}`);
  console.log(`  Author: ${author || "(unknown)"}`);
  console.log(`  Chapters: ${spineItems.length}`);

  return { zip, spineItems, title, author };
}

// ── Convert HTML to plain text ─────────────────────────────────────────────
function htmlToText(html) {
  let text = html;

  // Remove everything inside <head>...</head>
  text = text.replace(/<head[\s>][\s\S]*?<\/head>/gi, "");

  // Remove <script> and <style> blocks
  text = text.replace(/<script[\s>][\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s>][\s\S]*?<\/style>/gi, "");

  // Convert headings to uppercase with markers
  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, content) => {
    const clean = stripTags(content).trim();
    return `\n${"=".repeat(60)}\n${clean.toUpperCase()}\n${"=".repeat(60)}\n\n`;
  });
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, content) => {
    const clean = stripTags(content).trim();
    return `\n${"-".repeat(40)}\n${clean}\n${"-".repeat(40)}\n\n`;
  });
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, content) => {
    const clean = stripTags(content).trim();
    return `\n### ${clean}\n\n`;
  });
  text = text.replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, (_, content) => {
    const clean = stripTags(content).trim();
    return `\n${clean}\n\n`;
  });

  // Horizontal rules
  text = text.replace(/<hr[^>]*\/?>/gi, `\n${"─".repeat(40)}\n`);

  // Line breaks
  text = text.replace(/<br\s*\/?>/gi, "\n");

  // Block-level elements get line breaks
  text = text.replace(/<\/(p|div|blockquote|section|article|aside|figure|figcaption)>/gi, "\n\n");
  text = text.replace(/<(p|div|blockquote|section|article|aside|figure|figcaption)[^>]*>/gi, "");

  // Lists
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, content) => {
    const clean = stripTags(content).trim();
    return `  • ${clean}\n`;
  });
  text = text.replace(/<\/(ul|ol)>/gi, "\n");
  text = text.replace(/<(ul|ol)[^>]*>/gi, "\n");

  // Tables: simple row-based conversion
  text = text.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_, row) => {
    const cells = [];
    const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let cellMatch;
    while ((cellMatch = cellRegex.exec(row)) !== null) {
      cells.push(stripTags(cellMatch[1]).trim());
    }
    return cells.join(" | ") + "\n";
  });

  // Images: show alt text if available
  text = text.replace(/<img[^>]*alt=["']([^"']*)["'][^>]*\/?>/gi, (_, alt) => {
    return alt ? `[Image: ${alt}]` : "[Image]";
  });
  text = text.replace(/<img[^>]*\/?>/gi, "[Image]");

  // Remove all remaining HTML tags
  text = stripTags(text);

  // Decode HTML entities
  text = decode(text);

  // Clean up whitespace
  text = text.replace(/[ \t]+/g, " ");           // collapse horizontal spaces
  text = text.replace(/ *\n */g, "\n");           // trim spaces around newlines
  text = text.replace(/\n{4,}/g, "\n\n\n");       // max 3 consecutive newlines
  text = text.trim();

  return text;
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, "");
}

// ── Extract chapter title from HTML ───────────────────────────────────────
function extractChapterTitle(html) {
  // Try <title> tag first
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    const t = decode(stripTags(titleMatch[1])).trim();
    if (t) return t;
  }
  // Try first heading (h1–h3)
  const headingMatch = html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
  if (headingMatch) {
    const t = decode(stripTags(headingMatch[1])).trim();
    if (t) return t;
  }
  return null;
}

// ── Parse PDF structure ─────────────────────────────────────────────────────
async function parsePdf(pdfPath) {
  console.log(`📕 Reading PDF: ${pdfPath}`);
  // Lazy-load pdfjs so EPUB conversions don't pay the cost of importing it.
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(await fs.readFile(pdfPath));
  const loadingTask = getDocument({ data, useSystemFonts: true, verbosity: 0 });
  const doc = await loadingTask.promise;

  let title = "";
  let author = "";
  try {
    const meta = await doc.getMetadata();
    title = meta?.info?.Title || "";
    author = meta?.info?.Author || "";
  } catch {
    // Metadata is optional; ignore extraction errors.
  }

  console.log(`  Title: ${title || "(unknown)"}`);
  console.log(`  Author: ${author || "(unknown)"}`);
  console.log(`  Pages: ${doc.numPages}`);

  return { doc, loadingTask, numPages: doc.numPages, title, author };
}

// ── Convert a PDF page's text items to plain text ───────────────────────────
function pdfItemsToText(items) {
  let out = "";
  let lastY = null;
  let lastEndX = null;
  for (const item of items) {
    if (typeof item.str !== "string") continue;
    const str = item.str;
    const x = item.transform[4];
    const y = item.transform[5];

    if (lastY !== null && Math.abs(lastY - y) > 1) {
      // New visual line.
      out += "\n";
      lastEndX = null;
    } else if (
      lastEndX !== null &&
      x - lastEndX > 1 &&
      str.length > 0 &&
      !out.endsWith(" ") &&
      !str.startsWith(" ")
    ) {
      // Same line but a horizontal gap → insert a space between words.
      out += " ";
    }

    out += str;

    if (item.hasEOL) {
      out += "\n";
      lastY = null;
      lastEndX = null;
      continue;
    }
    lastY = y;
    lastEndX = x + (item.width || 0);
  }
  return out;
}

// ── Whitespace cleanup shared by the PDF path ───────────────────────────────
function tidyWhitespace(text) {
  text = text.replace(/[ \t]+/g, " ");      // collapse horizontal spaces
  text = text.replace(/ *\n */g, "\n");      // trim spaces around newlines
  text = text.replace(/\n{4,}/g, "\n\n\n");  // max 3 consecutive newlines
  return text.trim();
}

// ── Shared output helpers ───────────────────────────────────────────────────
async function writeHeader(fd, { title, author, source }) {
  const header = [
    "=".repeat(60),
    title ? `  ${title}` : "  (Untitled)",
    author ? `  by ${author}` : "",
    "=".repeat(60),
    "",
    `  Converted from ${source} on ${new Date().toISOString().split("T")[0]}`,
    "",
    "=".repeat(60),
    "\n\n",
  ]
    .filter(Boolean)
    .join("\n");
  await fd.write(header);
}

async function reportStats(outputPath, totalChars) {
  const stats = await fs.stat(outputPath);
  const sizeMb = (stats.size / 1024 / 1024).toFixed(2);
  const sizeKb = (stats.size / 1024).toFixed(0);

  console.log(`\n\n✅ Done! Output: ${outputPath}`);
  console.log(`   Size: ${stats.size > 1048576 ? sizeMb + " MB" : sizeKb + " KB"}`);
  console.log(`   Characters: ${totalChars.toLocaleString()}`);
}

// ── Main conversion: dispatch by file type ──────────────────────────────────
async function convertToText(inputPath, outputPath, opts = {}) {
  const ext = path.extname(inputPath).toLowerCase();
  if (ext === ".pdf") {
    return convertPdfToText(inputPath, outputPath, opts);
  }
  return convertEpubToText(inputPath, outputPath, opts);
}

async function convertPdfToText(pdfPath, outputPath, { addChapters = true } = {}) {
  const { doc, loadingTask, numPages, title, author } = await parsePdf(pdfPath);

  console.log(`\n📝 Converting ${numPages} pages to plain text...\n`);

  const fd = await fs.open(outputPath, "w");
  await writeHeader(fd, { title, author, source: "PDF" });

  let totalChars = 0;
  for (let i = 1; i <= numPages; i++) {
    const progress = ((i / numPages) * 100).toFixed(1);
    process.stdout.write(`\r  [${progress}%] Page ${i}/${numPages}          `);

    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    page.cleanup();

    const text = tidyWhitespace(pdfItemsToText(content.items));
    if (!text || text.length < 2) continue;

    let pageHeader = "";
    if (addChapters) {
      pageHeader = `\n\n${"─".repeat(40)}\n  Page ${i}\n${"─".repeat(40)}\n`;
    }
    await fd.write(`${pageHeader}\n${text}\n`);
    totalChars += text.length;
  }

  await loadingTask.destroy();
  await fd.close();

  console.log(`\n`);
  await reportStats(outputPath, totalChars);
}

async function convertEpubToText(epubPath, outputPath, { addChapters = true } = {}) {
  const { zip, spineItems, title, author } = await parseEpub(epubPath);
  const totalChapters = spineItems.length;

  console.log(`\n📝 Converting ${totalChapters} chapters to plain text...\n`);

  // Open output file for writing (streaming to handle large books)
  const fd = await fs.open(outputPath, "w");

  await writeHeader(fd, { title, author, source: "EPUB" });

  let totalChars = 0;
  let processedChapters = 0;

  for (const item of spineItems) {
    processedChapters++;
    const progress = ((processedChapters / totalChapters) * 100).toFixed(1);
    const fileName = item.href.split("/").pop();
    process.stdout.write(`\r  [${progress}%] Chapter ${processedChapters}/${totalChapters}: ${fileName}          `);

    const html = await zip.file(item.href)?.async("string");
    if (!html) {
      console.warn(`\n  ⚠ Could not read: ${item.href}`);
      continue;
    }

    const text = htmlToText(html);
    if (!text || text.length < 2) continue;

    // Write chapter header + text
    let chapterHeader = "";
    if (addChapters) {
      const chapterTitle = extractChapterTitle(html) || fileName.replace(/\.[^.]+$/, "");
      const label = `  Chapter ${processedChapters}:`; // ${chapterTitle}
      chapterHeader = `\n\n${"═".repeat(60)}\n${label}\n${"═".repeat(60)}\n`;
    }
    await fd.write(`${chapterHeader}\n\n${text}\n`);
    totalChars += text.length;
  }

  await fd.close();

  await reportStats(outputPath, totalChars);
}

// ── CLI ────────────────────────────────────────────────────────────────────
const rawArgs = process.argv.slice(2);

// Parse flags
const noChapters = rawArgs.includes("--no-chapters");
const args = rawArgs.filter((a) => !a.startsWith("--"));

if (args.length < 1) {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║           EPUB / PDF → Plain Text Converter              ║
║  Extracts all text content preserving reading order      ║
║  and basic structure (headings, lists, paragraphs).      ║
╚══════════════════════════════════════════════════════════╝

Usage:
  node to-text.js <input.epub|input.pdf> [output.txt] [options]

Options:
  --no-chapters   Skip chapter/page headers between sections

Examples:
  node to-text.js book.epub
  node to-text.js book.pdf
  node to-text.js book.epub book.txt
  node to-text.js book.pdf book.txt --no-chapters
`);
  process.exit(1);
}

const inputFile = path.resolve(args[0]);
const inputExt = path.extname(inputFile).toLowerCase();

if (inputExt !== ".epub" && inputExt !== ".pdf") {
  console.error(`❌ Unsupported file type: ${inputExt || "(none)"} — expected .epub or .pdf`);
  process.exit(1);
}

const outputTxt = args[1]
  ? path.resolve(args[1])
  : inputFile.replace(/\.(epub|pdf)$/i, ".txt");

try {
  await fs.access(inputFile);
} catch {
  console.error(`❌ File not found: ${inputFile}`);
  process.exit(1);
}

const startTime = Date.now();
await convertToText(inputFile, outputTxt, { addChapters: !noChapters });
const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`   Time: ${elapsed}s`);
