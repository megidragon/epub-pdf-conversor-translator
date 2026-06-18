// Shared EPUB helpers: structure parsing, chapter HTML building (with inlined
// images/CSS), and batch PDF rendering via Puppeteer.
//
// Both convert.js (EPUB -> PDF) and convert-translated.js (EPUB -> translated
// PDF) build on these so the image-preserving logic lives in exactly one place.
import fs from "fs/promises";
import path from "path";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import puppeteer from "puppeteer";
import { PDFDocument } from "pdf-lib";

// ── Configuration ──────────────────────────────────────────────────────────
export const BATCH_SIZE = 20; // chapters per batch before merging (controls memory)
export const PDF_OPTIONS = {
  format: "A4",
  printBackground: true,
  margin: { top: "20mm", bottom: "20mm", left: "15mm", right: "15mm" },
  timeout: 120_000, // 2 min per chapter PDF generation
};

// ── Helpers ────────────────────────────────────────────────────────────────
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name) => ["item", "itemref", "reference"].includes(name),
});

export function resolveHref(base, href) {
  // Resolve a relative href against a base directory inside the EPUB zip
  const dir = base.includes("/") ? base.substring(0, base.lastIndexOf("/")) : "";
  const resolved = dir ? `${dir}/${href}` : href;
  // Normalize ../
  const parts = resolved.split("/");
  const normalized = [];
  for (const p of parts) {
    if (p === "..") normalized.pop();
    else if (p !== ".") normalized.push(p);
  }
  return normalized.join("/");
}

export function mimeFromExt(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".css": "text/css",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  };
  return map[ext] || "application/octet-stream";
}

// ── Parse EPUB structure ───────────────────────────────────────────────────
export async function parseEpub(epubPath) {
  console.log(`📖 Reading EPUB: ${epubPath}`);
  const data = await fs.readFile(epubPath);
  const zip = await JSZip.loadAsync(data);

  // 1. Find container.xml -> rootfile path
  const containerXml = await zip.file("META-INF/container.xml")?.async("string");
  if (!containerXml) throw new Error("Invalid EPUB: missing META-INF/container.xml");
  const container = xmlParser.parse(containerXml);
  const rootfilePath =
    container.container?.rootfiles?.rootfile?.["@_full-path"] ||
    container.container?.rootfiles?.rootfile?.[0]?.["@_full-path"];
  if (!rootfilePath) throw new Error("Cannot find rootfile path in container.xml");

  console.log(`  Rootfile: ${rootfilePath}`);

  // 2. Parse OPF (content.opf)
  const opfXml = await zip.file(rootfilePath)?.async("string");
  if (!opfXml) throw new Error(`Cannot read OPF file: ${rootfilePath}`);
  const opf = xmlParser.parse(opfXml);

  const pkg = opf["package"] || opf["opf:package"];
  const manifest = pkg.manifest;
  const spine = pkg.spine;
  const metadata = pkg.metadata || pkg["opf:metadata"];

  // 3. Build manifest map: id -> {href, mediaType}
  let items = manifest.item || manifest["opf:item"] || [];
  if (!Array.isArray(items)) items = [items];

  const manifestMap = new Map();
  for (const item of items) {
    manifestMap.set(item["@_id"], {
      href: item["@_href"],
      mediaType: item["@_media-type"],
    });
  }

  // 4. Get spine order (reading order)
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

  console.log(`  Found ${spineItems.length} spine items (chapters/sections)`);

  // 5. Collect all CSS files
  const cssFiles = [];
  for (const [, entry] of manifestMap) {
    if (entry.mediaType === "text/css") {
      cssFiles.push(resolveHref(rootfilePath, entry.href));
    }
  }

  // 6. Extract title and author from metadata
  let title = "";
  let author = "";
  if (metadata) {
    const dcTitle = metadata["dc:title"];
    title = typeof dcTitle === "object" ? dcTitle["#text"] || "" : dcTitle || "";
    const dcCreator = metadata["dc:creator"];
    author = typeof dcCreator === "object" ? dcCreator["#text"] || "" : dcCreator || "";
  }

  return { zip, spineItems, cssFiles, rootfilePath, title, author };
}

// ── Build full HTML for a chapter with inlined resources ───────────────────
// `transformHtml`, when provided, is applied to the raw chapter HTML BEFORE
// images/CSS are inlined. This lets callers translate the (small) raw markup
// while leaving <img> tags untouched, so images keep their exact positions.
export async function buildChapterHtml(zip, chapterHref, cssFiles, transformHtml = null) {
  let raw = await zip.file(chapterHref)?.async("string");
  if (!raw) {
    console.warn(`  ⚠ Could not read: ${chapterHref}`);
    return null;
  }

  if (transformHtml) {
    raw = await transformHtml(raw, chapterHref);
  }

  // Inline all CSS
  let combinedCss = "";
  for (const cssPath of cssFiles) {
    const css = await zip.file(cssPath)?.async("string");
    if (css) combinedCss += css + "\n";
  }

  // Also extract <link rel="stylesheet"> references from the HTML itself
  const linkRegex = /<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*\/?>/gi;
  let match;
  while ((match = linkRegex.exec(raw)) !== null) {
    const href = match[1];
    const fullPath = resolveHref(chapterHref, href);
    const css = await zip.file(fullPath)?.async("string");
    if (css) combinedCss += css + "\n";
  }

  // Replace image src with base64 data URIs
  let html = raw;

  const imgRegex = /(<img[^>]+src=["'])([^"']+)(["'][^>]*\/?>)/gi;
  const imgReplacements = [];
  let imgMatch;
  while ((imgMatch = imgRegex.exec(html)) !== null) {
    const src = imgMatch[2];
    if (src.startsWith("data:")) continue;
    const fullPath = resolveHref(chapterHref, src);
    const imgFile = zip.file(fullPath);
    if (imgFile) {
      const imgData = await imgFile.async("base64");
      const mime = mimeFromExt(fullPath);
      imgReplacements.push({
        original: imgMatch[0],
        replacement: `${imgMatch[1]}data:${mime};base64,${imgData}${imgMatch[3]}`,
      });
    }
  }
  for (const rep of imgReplacements) {
    html = html.replace(rep.original, rep.replacement);
  }

  // Also handle SVG image xlink:href and CSS url() references for images
  const svgHrefRegex = /(xlink:href=["'])([^"']+)(["'])/gi;
  const svgReplacements = [];
  let svgMatch;
  while ((svgMatch = svgHrefRegex.exec(html)) !== null) {
    const src = svgMatch[2];
    if (src.startsWith("data:") || src.startsWith("#")) continue;
    const fullPath = resolveHref(chapterHref, src);
    const file = zip.file(fullPath);
    if (file) {
      const data = await file.async("base64");
      const mime = mimeFromExt(fullPath);
      svgReplacements.push({
        original: svgMatch[0],
        replacement: `${svgMatch[1]}data:${mime};base64,${data}${svgMatch[3]}`,
      });
    }
  }
  for (const rep of svgReplacements) {
    html = html.replace(rep.original, rep.replacement);
  }

  // Inline CSS url() references (background images, fonts)
  const urlRegex = /url\(["']?(?!data:)([^"')]+)["']?\)/gi;
  const urlReplacements = [];
  let urlMatch;
  while ((urlMatch = urlRegex.exec(combinedCss)) !== null) {
    const src = urlMatch[1];
    // Resolve relative to the first CSS file or chapter dir
    const basePath = cssFiles.length > 0 ? cssFiles[0] : chapterHref;
    const fullPath = resolveHref(basePath, src);
    const file = zip.file(fullPath);
    if (file) {
      const data = await file.async("base64");
      const mime = mimeFromExt(fullPath);
      urlReplacements.push({
        original: urlMatch[0],
        replacement: `url("data:${mime};base64,${data}")`,
      });
    }
  }
  for (const rep of urlReplacements) {
    combinedCss = combinedCss.replaceAll(rep.original, rep.replacement);
  }

  // Remove existing link/style tags from the HTML to avoid double-loading
  html = html.replace(/<link[^>]+rel=["']stylesheet["'][^>]*\/?>/gi, "");

  // Inject combined CSS into <head>
  const styleTag = `<style>${combinedCss}</style>`;
  if (html.includes("</head>")) {
    html = html.replace("</head>", `${styleTag}</head>`);
  } else {
    html = `${styleTag}${html}`;
  }

  // Add base style overrides for PDF rendering
  const pdfOverrides = `
    <style>
      @page { margin: 0; }
      body {
        font-family: serif;
        line-height: 1.5;
        word-wrap: break-word;
        overflow-wrap: break-word;
      }
      img, svg {
        max-width: 100% !important;
        height: auto !important;
        page-break-inside: avoid;
      }
      table {
        page-break-inside: avoid;
      }
      h1, h2, h3, h4, h5, h6 {
        page-break-after: avoid;
      }
      p {
        orphans: 3;
        widows: 3;
      }
      pre, code {
        white-space: pre-wrap;
        word-wrap: break-word;
      }
    </style>
  `;
  if (html.includes("</head>")) {
    html = html.replace("</head>", `${pdfOverrides}</head>`);
  } else {
    html = `${pdfOverrides}${html}`;
  }

  return html;
}

// ── Render parsed chapters to a single PDF (batched for large books) ───────
// `transformHtml` is forwarded to buildChapterHtml (see above). Returns
// { pages, sizeMb }.
export async function renderToPdf(parsed, outputPath, { transformHtml = null } = {}) {
  const { zip, spineItems, cssFiles } = parsed;
  const totalChapters = spineItems.length;

  console.log(`\n🚀 Starting conversion of ${totalChapters} chapters...`);
  console.log(`   Output: ${outputPath}\n`);

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  const tempDir = path.join(path.dirname(outputPath), ".epub-to-pdf-temp");
  await fs.mkdir(tempDir, { recursive: true });

  const batchFiles = [];
  let currentBatchPdfs = [];
  let batchIndex = 0;
  let processedChapters = 0;
  let totalPages = 0;

  for (let i = 0; i < totalChapters; i++) {
    const item = spineItems[i];
    processedChapters++;
    const progress = ((processedChapters / totalChapters) * 100).toFixed(1);
    process.stdout.write(
      `\r  [${progress}%] Processing chapter ${processedChapters}/${totalChapters}: ${item.href.split("/").pop()}          `
    );

    const html = await buildChapterHtml(zip, item.href, cssFiles, transformHtml);
    if (!html) continue;

    try {
      const page = await browser.newPage();
      await page.setContent(html, {
        waitUntil: "networkidle0",
        timeout: 60_000,
      });

      // Wait for images to load
      await page.evaluate(() => {
        return Promise.all(
          Array.from(document.images)
            .filter((img) => !img.complete)
            .map(
              (img) =>
                new Promise((resolve) => {
                  img.onload = img.onerror = resolve;
                })
            )
        );
      });

      const pdfBuffer = await page.pdf(PDF_OPTIONS);
      currentBatchPdfs.push(pdfBuffer);

      // Count pages for progress
      const tmpDoc = await PDFDocument.load(pdfBuffer);
      totalPages += tmpDoc.getPageCount();

      await page.close();
    } catch (err) {
      console.warn(`\n  ⚠ Error on chapter ${item.href}: ${err.message}`);
    }

    // Flush batch to disk when batch is full
    if (currentBatchPdfs.length >= BATCH_SIZE || i === totalChapters - 1) {
      if (currentBatchPdfs.length > 0) {
        const batchDoc = await PDFDocument.create();
        for (const pdfBytes of currentBatchPdfs) {
          const src = await PDFDocument.load(pdfBytes);
          const pages = await batchDoc.copyPages(src, src.getPageIndices());
          for (const p of pages) batchDoc.addPage(p);
        }
        const batchPath = path.join(tempDir, `batch_${batchIndex}.pdf`);
        await fs.writeFile(batchPath, await batchDoc.save());
        batchFiles.push(batchPath);
        batchIndex++;
        currentBatchPdfs = []; // free memory
      }
    }
  }

  await browser.close();
  console.log(`\n\n📄 Total pages generated: ${totalPages}`);

  // ── Merge all batch PDFs ───────────────────────────────────────────────
  console.log(`\n🔗 Merging ${batchFiles.length} batch files into final PDF...`);
  const finalDoc = await PDFDocument.create();

  for (let i = 0; i < batchFiles.length; i++) {
    process.stdout.write(`\r  Merging batch ${i + 1}/${batchFiles.length}...`);
    const batchBytes = await fs.readFile(batchFiles[i]);
    const batchDoc = await PDFDocument.load(batchBytes);
    const pages = await finalDoc.copyPages(batchDoc, batchDoc.getPageIndices());
    for (const p of pages) finalDoc.addPage(p);
  }

  console.log(`\n  Saving final PDF...`);
  const finalBytes = await finalDoc.save();
  await fs.writeFile(outputPath, finalBytes);

  // Cleanup temp files
  for (const f of batchFiles) {
    await fs.unlink(f).catch(() => {});
  }
  await fs.rmdir(tempDir).catch(() => {});

  const sizeMb = (finalBytes.length / 1024 / 1024).toFixed(2);
  console.log(`\n✅ Done! Output: ${outputPath}`);
  console.log(`   Final size: ${sizeMb} MB | Pages: ${finalDoc.getPageCount()}`);

  return { pages: finalDoc.getPageCount(), sizeMb };
}
