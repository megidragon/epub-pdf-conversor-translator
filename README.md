# epub-converter

Conjunto de scripts en Node.js para convertir libros EPUB grandes a PDF o texto plano, limpiar el contenido, traducirlo (por Google Translate o IA local) y volver a generar PDFs con formato.

## Índice

- [Requisitos](#requisitos)
- [Instalación](#instalación)
- [Scripts disponibles](#scripts-disponibles)
  - [1. `convert.js` — EPUB → PDF](#1-convertjs--epub--pdf)
  - [2. `to-text.js` — EPUB → Texto plano](#2-to-textjs--epub--texto-plano)
  - [3. `clean-text.js` — Limpieza de texto](#3-clean-textjs--limpieza-de-texto)
  - [4. `translate.js` — Traducción con Google Translate](#4-translatejs--traducción-con-google-translate)
  - [5. `translate-ai.js` — Traducción con IA local (LM Studio)](#5-translate-aijs--traducción-con-ia-local-lm-studio)
  - [6. `txt-to-pdf.js` — Texto plano → PDF con formato](#6-txt-to-pdfjs--texto-plano--pdf-con-formato)
  - [7. `novel-scraper.mjs` — Scraper de capítulos web](#7-novel-scrapermjs--scraper-de-capítulos-web)
- [Flujos de trabajo típicos](#flujos-de-trabajo-típicos)
- [Atajos vía `npm run`](#atajos-vía-npm-run)

---

## Requisitos

- Node.js 18 o superior (se usa `fetch` nativo y módulos ES).
- Windows, macOS o Linux.
- Para `translate-ai.js`: [LM Studio](https://lmstudio.ai/) corriendo localmente con un modelo cargado y el servidor habilitado.

## Instalación

```bash
npm install
```

---

## Scripts disponibles

### 1. `convert.js` — EPUB → PDF

Convierte un archivo `.epub` a `.pdf` preservando el texto, las imágenes y la estructura. Usa **Puppeteer** para renderizar cada capítulo como PDF y luego los une con **pdf-lib**. Procesa en lotes (por defecto 20 capítulos por lote) para poder manejar libros muy grandes sin agotar la memoria.

**Uso:**

```bash
node convert.js <entrada.epub> [salida.pdf]
```

**Argumentos:**

- `entrada.epub` *(obligatorio)*: ruta al archivo EPUB.
- `salida.pdf` *(opcional)*: ruta del PDF final. Si se omite, se guarda junto al EPUB con el mismo nombre.

**Ejemplos:**

```bash
node convert.js libro.epub
node convert.js libro.epub salida.pdf
```

**Notas:**

- Inlinea CSS, imágenes (base64), SVG y fuentes para que el PDF sea autocontenido.
- Genera archivos temporales en un directorio `.epub-to-pdf-temp` junto al destino; se eliminan al terminar.

---

### 2. `to-text.js` — EPUB → Texto plano

Extrae todo el texto legible de un EPUB manteniendo el orden de lectura y una estructura básica (títulos, listas, párrafos, tablas sencillas). Los títulos se marcan con separadores (`===`, `---`, `###`) para que otros scripts los reconozcan.

**Uso:**

```bash
node to-text.js <entrada.epub> [salida.txt] [opciones]
```

**Argumentos:**

- `entrada.epub` *(obligatorio)*: archivo EPUB a procesar.
- `salida.txt` *(opcional)*: archivo de salida. Por defecto es el EPUB con extensión `.txt`.

**Opciones:**

- `--no-chapters`: no insertar cabeceras de capítulo entre secciones.

**Ejemplos:**

```bash
node to-text.js libro.epub
node to-text.js libro.epub libro.txt
node to-text.js libro.epub libro.txt --no-chapters
```

---

### 3. `clean-text.js` — Limpieza de texto

Limpia un archivo de texto plano aplicando reglas configurables definidas en un JSON. Útil para eliminar pie de página de traductores, promociones de Patreon/Ko-fi, enlaces a Discord, avisos repetidos, etc. Soporta archivos muy grandes con procesamiento en streaming (>50 MB).

**Tipos de reglas soportadas** (ver `clean-rules.json`):

- **`blocks`**: bloques multilínea exactos que se eliminan completos.
- **`linePatterns`**: patrones regex; cualquier línea que coincida se descarta.
- **`replacements`**: reemplazos de subcadenas o regex (ideal para corregir errores de OCR o quitar anuncios inline).

**Uso:**

```bash
node clean-text.js <entrada.txt> [salida.txt] [--rules <reglas.json>]
```

**Argumentos y opciones:**

- `entrada.txt` *(obligatorio)*: archivo de entrada.
- `salida.txt` *(opcional)*: archivo de salida. Por defecto `<nombre>_cleaned.txt`.
- `--rules <archivo>`: ruta al JSON de reglas. Por defecto se usa `clean-rules.json` junto al script.

**Ejemplos:**

```bash
node clean-text.js libro.txt
node clean-text.js libro.txt libro_limpio.txt
node clean-text.js libro.txt --rules mis-reglas.json
```

Al finalizar muestra estadísticas: cuántas veces se aplicó cada regla y cuántos KB se eliminaron.

---

### 4. `translate.js` — Traducción con Google Translate

Traduce un archivo de texto plano grande usando el API no oficial de Google Translate (`google-translate-api-x`). Divide el texto en fragmentos de ~4500 caracteres (respetando párrafos/oraciones), aplica espera entre peticiones para evitar bloqueos y **guarda el progreso** para poder reanudar si se interrumpe.

**Uso:**

```bash
node translate.js <entrada.txt> [salida.txt] [opciones]
```

**Opciones:**

- `--from <idioma>`: código del idioma de origen (por defecto `en`).
- `--to <idioma>`: código del idioma de destino (por defecto `es`).

**Ejemplos:**

```bash
node translate.js libro.txt
node translate.js libro.txt libro_es.txt
node translate.js libro.txt --from en --to fr
```

**Características:**

- Retardo aleatorio de 1.5–2.5 s entre fragmentos.
- Reintentos automáticos con backoff exponencial (hasta 10 intentos por fragmento).
- Guarda progreso cada 20 fragmentos en un archivo oculto `.<nombre>_translate_progress.json`; se borra al terminar con éxito.
- Conserva marcadores estructurales (separadores `===`, `---`, `###`) sin traducirlos.

**Códigos de idioma comunes:** `en`, `es`, `fr`, `de`, `it`, `pt`, `ja`, `ko`, `zh`, `ru`, `ar`, `hi`.

---

### 5. `translate-ai.js` — Traducción con IA local (LM Studio)

Alternativa a `translate.js` que usa un modelo LLM corriendo localmente en **LM Studio** (endpoint compatible con OpenAI). Recomendado para calidad literaria superior y para evitar límites de Google.

**Requisitos previos:**

1. Instalar LM Studio y cargar un modelo (por ejemplo Llama 3, Qwen, etc.).
2. Habilitar el servidor local (por defecto en `http://localhost:1234/v1`).

**Uso:**

```bash
node translate-ai.js <entrada.txt> [salida.txt] [opciones]
```

**Opciones:**

- `--to <LANG>`: código del idioma destino (por defecto `ES`). Soporta `ES`, `EN`, `FR`, `DE`, `IT`, `PT`, `JA`, `KO`, `ZH`, `RU`, `AR`.
- `--endpoint <url>`: URL base de LM Studio (por defecto `http://localhost:1234/v1`).
- `--model <id>`: ID del modelo a usar. Si se omite, se autoselecciona el primer modelo cargado.
- `--chunk <n>`: caracteres máximos por fragmento (por defecto 2500).
- `--retries <n>`: reintentos máximos por fragmento (por defecto 3).

**Ejemplos:**

```bash
node translate-ai.js libro.txt
node translate-ai.js libro.txt --to FR
node translate-ai.js libro.txt traducido.txt --to DE
node translate-ai.js libro.txt --endpoint http://localhost:1234/v1 --model "llama-3"
```

**Nombre del archivo de salida por defecto:** `<entrada>_<LANG>_by_ia.txt`.

También guarda progreso cada 10 fragmentos (`.<nombre>_ai_<LANG>_progress.json`) para poder reanudar.

---

### 6. `txt-to-pdf.js` — Texto plano → PDF con formato

Convierte un archivo `.txt` a un PDF con formato legible. Detecta los marcadores estructurales generados por `to-text.js` (`===`, `---`, `###`, viñetas `•`) y los renderiza como títulos H1/H2/H3, listas, etc. Añade numeración de páginas automática.

**Uso:**

```bash
node txt-to-pdf.js <entrada.txt> [salida.pdf] [opciones]
```

**Opciones:**

- `--font-size <n>`: tamaño de fuente del cuerpo (por defecto `11`).
- `--page <tamaño>`: tamaño de página: `A4`, `LETTER`, `LEGAL` (por defecto `A4`).
- `--no-page-numbers`: desactivar la numeración de páginas.

**Ejemplos:**

```bash
node txt-to-pdf.js libro.txt
node txt-to-pdf.js libro.txt libro.pdf
node txt-to-pdf.js libro.txt --font-size 12 --page LETTER
```

---

### 7. `novel-scraper.mjs` — Scraper de capítulos web

Script específico para descargar capítulos de la novela **"46 Billion Year Symphony of Evolution"** desde `novelhi.com` y volcarlos a un único `.txt`. Útil como ejemplo de cómo adaptar un scraper por lotes con concurrencia y reintentos.

**Uso:**

```bash
node novel-scraper.mjs
```

**Configuración** (editar al principio del archivo):

- `BASE`: URL base de la novela.
- `START` / `END`: rango de capítulos a descargar.
- `OUTPUT`: ruta del archivo de salida (por defecto `docs/46-billion-years.txt`).
- `CONCURRENCY`: número de capítulos descargados en paralelo (por defecto `5`).
- `RETRY`: reintentos por capítulo fallido (por defecto `3`).
- `DELAY`: espera en ms entre lotes (por defecto `3000`).

No acepta argumentos CLI; los parámetros están hardcodeados. Adaptar según la novela a scrapear.

---

## Flujos de trabajo típicos

**A) Leer un EPUB en PDF tal cual:**

```bash
node convert.js libro.epub
```

**B) Extraer texto, limpiarlo y regenerar un PDF bonito:**

```bash
node to-text.js libro.epub
node clean-text.js libro.txt
node txt-to-pdf.js libro_cleaned.txt libro_final.pdf
```

**C) Traducir un libro completo al español (Google):**

```bash
node to-text.js libro.epub
node clean-text.js libro.txt
node translate.js libro_cleaned.txt
node txt-to-pdf.js libro_cleaned_es.txt libro_es.pdf
```

**D) Traducir con IA local (mejor calidad literaria):**

```bash
node to-text.js libro.epub
node clean-text.js libro.txt
node translate-ai.js libro_cleaned.txt --to ES
node txt-to-pdf.js libro_cleaned_ES_by_ia.txt libro_es.pdf
```

---

## Atajos vía `npm run`

El `package.json` define scripts abreviados (no incluyen `translate-ai` ni `novel-scraper`, se invocan con `node` directamente):

```bash
npm run to-pdf      # node convert.js
npm run to-txt      # node to-text.js
npm run clean       # node clean-text.js
npm run translate   # node translate.js
npm run txt-to-pdf  # node txt-to-pdf.js
```

Los argumentos se pasan después de `--`, por ejemplo:

```bash
npm run to-txt -- libro.epub libro.txt --no-chapters
```