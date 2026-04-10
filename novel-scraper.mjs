import { writeFileSync, appendFileSync } from "fs";

const BASE = "https://novelhi.com/s/46-Billion-Year-Symphony-of-Evolution";
const START = 1;
const END = 384;
const OUTPUT = "docs/46-billion-years.txt";
const CONCURRENCY = 5;
const RETRY = 3;
const DELAY = 3000; // ms between batches

function clean(html) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<sent[^>]*>/gi, "")
    .replace(/<\/sent>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/\(adsbygoogle[\s\S]*?\);/g, "")  // remove ad scripts
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function fetchChapter(num) {
  for (let attempt = 1; attempt <= RETRY; attempt++) {
    try {
      const res = await fetch(`${BASE}/${num}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const match = html.match(/<div[^>]*id=["'](?:showReading|chaptercontent)["'][^>]*>([\s\S]*?)<\/div>/i);
      if (!match) throw new Error("no content found");
      return clean(match[1]);
    } catch (e) {
      if (attempt === RETRY) {
        console.error(`  ✗ Chapter ${num} failed: ${e.message}`);
        return null;
      }
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Clear output file
writeFileSync(OUTPUT, "", "utf-8");

const total = END - START + 1;
let done = 0;

for (let i = START; i <= END; i += CONCURRENCY) {
  const batch = [];
  for (let j = i; j < i + CONCURRENCY && j <= END; j++) {
    batch.push(j);
  }

  const results = await Promise.all(batch.map(n => fetchChapter(n).then(text => ({ n, text }))));

  // Write in order
  for (const { n, text } of results) {
    done++;
    if (text) {
      appendFileSync(OUTPUT, `Capitulo ${n+1}\n\n${text}\n\n\n`, "utf-8");
    } else {
      appendFileSync(OUTPUT, `Capitulo ${n}\n\n[Error: no se pudo obtener este capitulo]\n\n\n`, "utf-8");
    }
  }

  console.log(`[${done}/${total}] Capitulos ${batch[0]}-${batch[batch.length - 1]} listos`);
  await sleep(DELAY);
}

console.log(`\nTerminado. ${total} capitulos escritos en ${OUTPUT}`);
