/**
 * epub-parser.js - Moderní EPUB parser pro prohlížeč.
 * Podporuje EPUB 2 i EPUB 3, extrakci metadat, obálky, obsahu (TOC),
 * kapitol a převod interních obrázků a stylů na bezpečné Blob URL.
 */

import { ZipArchive } from "./zip.js?v=2.9.9";
import { extractTextFromNode, extractTextFromHtml, countWords } from "./text-parser.js?v=2.9.9";

export class EpubParser {
  constructor(archive) {
    this.archive = archive;
    this.opfPath = "";
    this.opfDir = "";
    this.metadata = {};
    this.manifest = new Map();
    this.spine = [];
    this.toc = [];
    this.coverBlobUrl = null;
    this.blobUrlsToRevoke = [];
    this._blobUrlCache = new Map();
  }

  /**
   * Načte a rozparsuje EPUB z ArrayBufferu
   * @param {ArrayBuffer} buffer 
   * @returns {Promise<EpubBook>}
   */
  static async parse(buffer) {
    let archive;
    // Pokud je k dispozici JSZip (např. z CDN), můžeme jej použít jako alternativu,
    // jinak použijeme náš vestavěný ZipArchive.
    if (typeof window !== "undefined" && window.JSZip) {
      try {
        const jszip = await window.JSZip.loadAsync(buffer);
        archive = {
          entries: new Map(),
          buffer,
          async getFile(path) {
            if (!path) throw new Error("Cesta k souboru nebyla zadána");
            const clean = path.split("#")[0].split("?")[0].replace(/^(\.\/|\/)/, "");
            const candidates = [clean];
            try {
              const dec = decodeURIComponent(clean);
              if (!candidates.includes(dec)) candidates.push(dec);
            } catch (e) {}
            try {
              const dec = decodeURI(clean);
              if (!candidates.includes(dec)) candidates.push(dec);
            } catch (e) {}
            try {
              const enc = encodeURI(clean);
              if (!candidates.includes(enc)) candidates.push(enc);
            } catch (e) {}

            let file = null;
            // 1. Zkusit přímou shodu v jszip pro všechny kandidáty
            for (const cand of candidates) {
              file = jszip.file(cand);
              if (file) break;
            }

            // 2. Case-insensitive a relativní shoda napříč soubory
            if (!file) {
              const files = Object.keys(jszip.files);
              const lowerCandidates = candidates.map(c => c.toLowerCase());
              const baseNames = candidates.map(c => {
                const s = c.lastIndexOf("/");
                return (s !== -1 ? c.substring(s + 1) : c).toLowerCase();
              });

              const found = files.find(f => {
                const fLower = f.toLowerCase();
                let decodedFLower = fLower;
                try { decodedFLower = decodeURIComponent(fLower); } catch (e) {}

                return lowerCandidates.some(cand => 
                  fLower === cand ||
                  decodedFLower === cand ||
                  fLower.endsWith("/" + cand) ||
                  decodedFLower.endsWith("/" + cand) ||
                  cand.endsWith("/" + fLower) ||
                  cand.endsWith("/" + decodedFLower)
                );
              });

              if (found) {
                file = jszip.file(found);
              } else {
                // 3. Fallback: shoda podle samotného názvu souboru (basename)
                const foundBase = files.find(f => {
                  const s = f.lastIndexOf("/");
                  const fBase = (s !== -1 ? f.substring(s + 1) : f).toLowerCase();
                  let decodedFBase = fBase;
                  try { decodedFBase = decodeURIComponent(fBase); } catch (e) {}
                  return baseNames.includes(fBase) || baseNames.includes(decodedFBase);
                });
                if (foundBase) file = jszip.file(foundBase);
              }
            }

            if (!file) throw new Error(`Soubor '${path}' nebyl v EPUB archivu nalezen.`);
            const ab = await file.async("arraybuffer");
            return new Uint8Array(ab);
          },
          async getFileAsText(path) {
            const bytes = await this.getFile(path);
            return new TextDecoder("utf-8").decode(bytes);
          },
          async getFileAsBlob(path, mimeType) {
            const bytes = await this.getFile(path);
            return new Blob([bytes], { type: mimeType });
          },
          hasFile(path) {
            if (!path) return false;
            const clean = path.split("#")[0].split("?")[0].replace(/^(\.\/|\/)/, "");
            const candidates = [clean];
            try { candidates.push(decodeURIComponent(clean)); } catch (e) {}
            for (const cand of candidates) {
              if (jszip.file(cand)) return true;
            }
            const files = Object.keys(jszip.files);
            const lowerCandidates = candidates.map(c => c.toLowerCase());
            return files.some(f => lowerCandidates.some(c => f.toLowerCase() === c || f.toLowerCase().endsWith("/" + c)));
          }
        };
      } catch (e) {
        console.warn("JSZip selhal, přepínám na nativní ZipArchive:", e);
        archive = await ZipArchive.fromArrayBuffer(buffer);
      }
    } else {
      archive = await ZipArchive.fromArrayBuffer(buffer);
    }

    const parser = new EpubParser(archive);
    await parser.init();
    return parser;
  }

  async init() {
    // 1. Zjistit cestu k OPF souboru z META-INF/container.xml
    const containerXmlText = await this.archive.getFileAsText("META-INF/container.xml");
    const domParser = new DOMParser();
    const containerDoc = domParser.parseFromString(containerXmlText, "text/xml");
    const rootfile = containerDoc.querySelector("rootfile");
    
    if (!rootfile || !rootfile.getAttribute("full-path")) {
      throw new Error("Neplatný EPUB: META-INF/container.xml neobsahuje platnou cestu k OPF.");
    }

    this.opfPath = rootfile.getAttribute("full-path");
    const lastSlash = this.opfPath.lastIndexOf("/");
    this.opfDir = lastSlash !== -1 ? this.opfPath.substring(0, lastSlash + 1) : "";

    // 2. Načíst a zpracovat OPF soubor
    const opfXmlText = await this.archive.getFileAsText(this.opfPath);
    const opfDoc = domParser.parseFromString(opfXmlText, "text/xml");

    this.parseMetadata(opfDoc);
    this.parseManifest(opfDoc);
    this.parseSpine(opfDoc);
    await this.parseCover(opfDoc);
    await this.parseToc(opfDoc);
  }

  parseMetadata(opfDoc) {
    const getVal = (selector, fallback = "") => {
      const el = opfDoc.querySelector(selector);
      return el ? el.textContent.trim() : fallback;
    };

    this.metadata = {
      title: getVal("title") || "Neznámý titul",
      creator: getVal("creator") || "Neznámý autor",
      language: getVal("language", "cs"),
      description: getVal("description", ""),
      publisher: getVal("publisher", ""),
      identifier: getVal("identifier", "")
    };
  }

  parseManifest(opfDoc) {
    const items = opfDoc.querySelectorAll("manifest > item");
    items.forEach(item => {
      const id = item.getAttribute("id");
      const href = item.getAttribute("href");
      const mediaType = item.getAttribute("media-type") || "";
      const properties = item.getAttribute("properties") || "";

      // Vyřešíme relativní cestu k OPF adresáři
      const fullPath = this.resolvePath(this.opfDir, href);

      this.manifest.set(id, {
        id,
        href,
        fullPath,
        mediaType,
        properties
      });
    });
  }

  parseSpine(opfDoc) {
    const itemrefs = opfDoc.querySelectorAll("spine > itemref");
    this.spine = [];

    itemrefs.forEach((ref, index) => {
      const idref = ref.getAttribute("idref");
      const manifestItem = this.manifest.get(idref);
      if (manifestItem) {
        this.spine.push({
          index,
          id: idref,
          fullPath: manifestItem.fullPath,
          href: manifestItem.href,
          mediaType: manifestItem.mediaType
        });
      }
    });
  }

  async parseCover(opfDoc) {
    let coverItem = null;

    // A. Hledat položku s properties="cover-image" (EPUB 3)
    for (const item of this.manifest.values()) {
      if (item.properties && item.properties.includes("cover-image")) {
        coverItem = item;
        break;
      }
    }

    // B. Hledat meta name="cover" (EPUB 2)
    if (!coverItem) {
      const metaCover = opfDoc.querySelector('meta[name="cover"]');
      if (metaCover) {
        const coverId = metaCover.getAttribute("content");
        coverItem = this.manifest.get(coverId);
      }
    }

    // C. Hledat podle id nebo názvu souboru
    if (!coverItem) {
      for (const item of this.manifest.values()) {
        const idLower = item.id.toLowerCase();
        const hrefLower = item.href.toLowerCase();
        if (idLower === "cover" || idLower === "cover-image" || hrefLower.includes("cover")) {
          if (item.mediaType.startsWith("image/")) {
            coverItem = item;
            break;
          }
        }
      }
    }

    if (coverItem) {
      try {
        const blob = await this.archive.getFileAsBlob(coverItem.fullPath, coverItem.mediaType);
        this.coverBlobUrl = URL.createObjectURL(blob);
        this.blobUrlsToRevoke.push(this.coverBlobUrl);
      } catch (err) {
        console.warn("Nepodařilo se načíst obálku:", err);
      }
    }
  }

  async parseToc(opfDoc) {
    this.toc = [];

    // 1. Zkusíme EPUB 3 nav soubor (properties="nav")
    let navItem = null;
    for (const item of this.manifest.values()) {
      if (item.properties && item.properties.includes("nav")) {
        navItem = item;
        break;
      }
    }

    if (navItem) {
      try {
        const navHtml = await this.archive.getFileAsText(navItem.fullPath);
        const dom = new DOMParser().parseFromString(navHtml, "application/xhtml+xml");
        const navEl = dom.querySelector('nav[*|type="toc"], nav#toc, nav');
        if (navEl) {
          const links = navEl.querySelectorAll("ol li a, ul li a");
          const navDir = this.getDirectory(navItem.fullPath);
          links.forEach(a => {
            const href = a.getAttribute("href");
            const title = a.textContent.trim();
            if (href && title) {
              const fullHref = this.resolvePath(navDir, href);
              this.toc.push({ title, href, fullHref });
            }
          });
          if (this.toc.length > 0) return;
        }
      } catch (e) {
        console.warn("Chyba při čtení EPUB 3 nav:", e);
      }
    }

    // 2. Zkusíme EPUB 2 NCX soubor
    let ncxItem = null;
    const spineTocId = opfDoc.querySelector("spine")?.getAttribute("toc");
    if (spineTocId && this.manifest.has(spineTocId)) {
      ncxItem = this.manifest.get(spineTocId);
    } else {
      for (const item of this.manifest.values()) {
        if (item.mediaType === "application/x-dtbncx+xml" || item.href.endsWith(".ncx")) {
          ncxItem = item;
          break;
        }
      }
    }

    if (ncxItem) {
      try {
        const ncxXml = await this.archive.getFileAsText(ncxItem.fullPath);
        const dom = new DOMParser().parseFromString(ncxXml, "text/xml");
        const navPoints = dom.querySelectorAll("navPoint");
        const ncxDir = this.getDirectory(ncxItem.fullPath);

        navPoints.forEach(np => {
          const textEl = np.querySelector("navLabel > text");
          const contentEl = np.querySelector("content");
          if (textEl && contentEl) {
            const title = textEl.textContent.trim();
            const src = contentEl.getAttribute("src");
            const fullHref = this.resolvePath(ncxDir, src);
            this.toc.push({ title, href: src, fullHref });
          }
        });
        if (this.toc.length > 0) return;
      } catch (e) {
        console.warn("Chyba při čtení EPUB 2 ncx:", e);
      }
    }

    // 3. Fallback: Vygenerovat obsah podle spine položek
    this.spine.forEach((item, idx) => {
      this.toc.push({
        title: `Kapitola ${idx + 1}`,
        href: item.href,
        fullHref: item.fullPath
      });
    });
  }

  /**
   * Načte kapitolu podle indexu ve spine, vyřeší vložené obrázky a styly,
   * a vrátí HTML a statistiky o slovech.
   * @param {number} index 
   */
  async loadChapter(index) {
    if (index < 0 || index >= this.spine.length) {
      throw new Error(`Index kapitoly ${index} je mimo rozsah (celkem: ${this.spine.length})`);
    }

    const spineEntry = this.spine[index];
    if (!spineEntry || !spineEntry.fullPath) {
      throw new Error(`Položka spine pro kapitolu ${index + 1} nebyla nalezena.`);
    }

    const rawHtml = await this.archive.getFileAsText(spineEntry.fullPath);
    const chapterDir = this.getDirectory(spineEntry.fullPath);

    // Parsování do DOM
    const dom = new DOMParser().parseFromString(rawHtml, "text/html");
    const body = dom.body || dom.documentElement;

    // Vyřešíme obrázky: <img> a SVG <image>
    const images = body.querySelectorAll("img, image");
    for (const img of images) {
      const srcAttr = img.tagName.toLowerCase() === "image" ? "xlink:href" : "src";
      const src = img.getAttribute(srcAttr) ||
                  img.getAttribute("src") ||
                  img.getAttribute("href") ||
                  img.getAttributeNS("http://www.w3.org/1999/xlink", "href");

      if (src && !src.startsWith("data:") && !src.startsWith("http")) {
        const fullImgPath = this.resolvePath(chapterDir, src);
        try {
          // Zjistíme mime type
          let mime = "image/jpeg";
          const lower = fullImgPath.toLowerCase();
          if (lower.endsWith(".png")) mime = "image/png";
          else if (lower.endsWith(".svg")) mime = "image/svg+xml";
          else if (lower.endsWith(".gif")) mime = "image/gif";
          else if (lower.endsWith(".webp")) mime = "image/webp";

          let blobUrl = this._blobUrlCache?.get(fullImgPath);
          if (!blobUrl) {
            const blob = await this.archive.getFileAsBlob(fullImgPath, mime);
            blobUrl = URL.createObjectURL(blob);
            this.blobUrlsToRevoke.push(blobUrl);
            this._blobUrlCache?.set(fullImgPath, blobUrl);
          }

          img.setAttribute("src", blobUrl);
          if (img.tagName.toLowerCase() === "image") {
            img.setAttribute("href", blobUrl);
            img.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", blobUrl);
          }
        } catch (err) {
          console.warn(`Obrázek '${fullImgPath}' se nepodařilo načíst:`, err);
        }
      }
    }

    // Vyčistíme skripty pro bezpečnost a čistotu
    const scripts = body.querySelectorAll("script");
    scripts.forEach(s => s.remove());

    // Odstranění koncových prázdných elementů, odstavců a bílých znaků, které vytvářejí prázdné strany na konci kapitol
    const isNodeEmpty = (node) => {
      if (!node) return false;
      if (node.nodeType === Node.COMMENT_NODE) return true;
      if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent.replace(/[\s\u00a0\u200b-\u200d\ufeff]+/g, "").length === 0;
      }
      if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName.toLowerCase();
        if (["img", "image", "svg", "canvas", "video", "audio", "table"].includes(tag)) {
          return false;
        }
        if (tag === "br" || tag === "hr") {
          return true;
        }
        const hasMedia = node.querySelector("img, image, svg, canvas, video, audio, table") !== null;
        if (hasMedia) return false;
        const text = node.textContent.replace(/[\s\u00a0\u200b-\u200d\ufeff]+/g, "");
        return text.length === 0;
      }
      return false;
    };

    while (body.lastChild) {
      if (isNodeEmpty(body.lastChild)) {
        body.removeChild(body.lastChild);
        continue;
      }
      if (body.lastChild.nodeType === Node.ELEMENT_NODE) {
        let nested = body.lastChild;
        while (nested.lastChild && isNodeEmpty(nested.lastChild)) {
          nested.removeChild(nested.lastChild);
        }
        if (isNodeEmpty(nested)) {
          body.removeChild(nested);
          continue;
        }
      }
      break;
    }

    // Spočítáme slova s dehyphenací na přelomu řádků a striktní validací slov
    const cleanText = extractTextFromNode(body);
    const wordCount = countWords(cleanText);
    const hasMedia = body.querySelectorAll("img, image, svg, canvas, video, audio, table").length > 0;
    const isBlank = wordCount === 0 && !hasMedia;

    // Získáme název kapitoly (sdíleno s calculateTotalWords pro konzistenci posuvníku)
    const title = this.extractChapterTitle(body, spineEntry, index);
    spineEntry.title = title;

    return {
      index,
      title,
      html: body.innerHTML,
      wordCount,
      totalChapters: this.spine.length,
      fullPath: spineEntry.fullPath,
      isBlank
    };
  }

  /**
   * Extrahuje název kapitoly ze záhlaví v HTML nebo z TOC (se zálohou na číslo spine)
   */
  extractChapterTitle(body, spineEntry, index) {
    if (body) {
      const h1 = body.querySelector("h1, h2, h3");
      const hText = h1 ? h1.textContent.replace(/\s+/g, " ").trim() : "";
      if (hText) {
        return hText;
      }
    }

    if (spineEntry && spineEntry.fullPath && Array.isArray(this.toc) && this.toc.length > 0) {
      const cleanSpinePath = spineEntry.fullPath.split("#")[0].split("?")[0];
      const matchedToc = this.toc.find(t => {
        if (!t || !t.fullHref) return false;
        const cleanToc = t.fullHref.split("#")[0].split("?")[0];
        if (cleanToc === cleanSpinePath) return true;
        try {
          return decodeURIComponent(cleanToc) === decodeURIComponent(cleanSpinePath);
        } catch (e) {
          return false;
        }
      });
      if (matchedToc && matchedToc.title) {
        return matchedToc.title.replace(/\s+/g, " ").trim();
      }
    }

    return `Kapitola ${index + 1}`;
  }

  /**
   * Spočítá odhad celkového počtu slov v knize a přednačte skutečné názvy kapitol
   */
  async calculateTotalWords() {
    let totalWords = 0;
    const chapterWords = [];
    const chapterTitles = [];
    const domParser = typeof DOMParser !== "undefined" ? new DOMParser() : null;

    for (let i = 0; i < this.spine.length; i++) {
      try {
        const spineEntry = this.spine[i];
        if (!spineEntry || !spineEntry.fullPath) {
          chapterWords.push(0);
          chapterTitles.push(`Kapitola ${i + 1}`);
          continue;
        }
        const rawHtml = await this.archive.getFileAsText(spineEntry.fullPath);
        // Vyčistíme text kapitoly pro statistiky včetně dehyphenace a striktní validace slov
        const cleanText = extractTextFromHtml(rawHtml);
        const count = countWords(cleanText);
        chapterWords.push(count);
        totalWords += count;

        let title = spineEntry.title || "";
        if (!title && domParser) {
          const dom = domParser.parseFromString(rawHtml, "text/html");
          const body = dom.body || dom.documentElement;
          title = this.extractChapterTitle(body, spineEntry, i);
          spineEntry.title = title;
        }
        chapterTitles.push(title || `Kapitola ${i + 1}`);
      } catch (e) {
        console.warn(`Nepodařilo se spočítat slova v kapitole ${i}:`, e);
        chapterWords.push(0);
        chapterTitles.push(`Kapitola ${i + 1}`);
      }
    }

    return { totalWords, chapterWords, chapterTitles };
  }

  resolvePath(baseDir, relativePath) {
    if (!relativePath) return "";
    // Odstranění kotev # a query ?
    let cleanRel = relativePath.split("#")[0].split("?")[0];
    try {
      cleanRel = decodeURIComponent(cleanRel);
    } catch (e) {
      try {
        cleanRel = decodeURI(cleanRel);
      } catch (err) {}
    }

    if (cleanRel.startsWith("/")) {
      cleanRel = cleanRel.substring(1);
    }
    const stack = baseDir ? baseDir.split("/").filter(p => p.length > 0) : [];
    const parts = cleanRel.split("/");

    for (const part of parts) {
      if (part === "" || part === ".") continue;
      if (part === "..") {
        if (stack.length > 0) stack.pop();
      } else {
        stack.push(part);
      }
    }
    return stack.join("/");
  }

  getDirectory(filePath) {
    const lastSlash = filePath.lastIndexOf("/");
    return lastSlash !== -1 ? filePath.substring(0, lastSlash + 1) : "";
  }

  destroy() {
    // Uvolnění všech vytvořených blob URL paměti
    for (const url of this.blobUrlsToRevoke) {
      try {
        URL.revokeObjectURL(url);
      } catch (e) {}
    }
    this.blobUrlsToRevoke = [];
    this._blobUrlCache?.clear();
  }
}

// ==============================================================================
// Content-Anchored EPUB Position Tracking & Resolution Helpers
// ==============================================================================

const ANCHOR_SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "CANVAS"]);
const ANCHOR_BLOCK_TAGS = new Set([
  "P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "BLOCKQUOTE",
  "TR", "SECTION", "ARTICLE", "HEADER", "FOOTER", "ASIDE", "DD", "DT",
  "PRE", "FIGCAPTION", "BR", "HR"
]);
const ANCHOR_MEDIA_SELECTOR = "img, image, svg, canvas, video, audio, table";
const ANCHOR_INVISIBLE_CHAR_REGEX = /[\u00AD\u200B-\u200D\uFEFF\u2060]/;
const ANCHOR_WHITESPACE_REGEX = /[\s\u00A0]/;

/**
 * Sestaví normalizovaný textový index kapitoly s mapováním na DOM textové uzly.
 * Je invariantní vůči typografii, rozměrům obrazovky i Bionic Reading (<b>) značkám.
 *
 * @param {Element} rootElement
 * @returns {{ normalizedText: string, runs: Array<{ node: Text, nodeOffset: number, length: number, normStart: number, normEnd: number }> }}
 */
export function buildChapterTextIndex(rootElement) {
  if (!rootElement) {
    return { normalizedText: "", runs: [] };
  }

  let normalizedText = "";
  let pendingSpace = false;
  const runs = [];

  const appendBlockSeparator = () => {
    if (normalizedText.length > 0) {
      pendingSpace = true;
    }
  };

  const flushSpace = () => {
    if (pendingSpace && normalizedText.length > 0 && normalizedText[normalizedText.length - 1] !== " ") {
      normalizedText += " ";
    }
    pendingSpace = false;
  };

  const walk = (node) => {
    if (!node) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const val = node.nodeValue || "";
      if (val.length === 0) return;

      let runStartInNode = -1;
      let runNormStart = -1;
      let runBuf = "";

      const commitRun = () => {
        if (runBuf.length === 0 || runStartInNode < 0) return;
        const normStart = runNormStart;
        normalizedText += runBuf;
        const normEnd = normalizedText.length;
        runs.push({
          node,
          nodeOffset: runStartInNode,
          length: runBuf.length,
          normStart,
          normEnd
        });
        runStartInNode = -1;
        runNormStart = -1;
        runBuf = "";
      };

      for (let i = 0; i < val.length; i++) {
        const ch = val[i];
        if (ANCHOR_INVISIBLE_CHAR_REGEX.test(ch)) {
          commitRun();
          continue;
        }
        if (ANCHOR_WHITESPACE_REGEX.test(ch)) {
          commitRun();
          if (normalizedText.length > 0) {
            pendingSpace = true;
          }
          continue;
        }
        if (runStartInNode < 0) {
          flushSpace();
          runStartInNode = i;
          runNormStart = normalizedText.length;
        }
        runBuf += ch;
      }
      commitRun();
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = (node.tagName || "").toUpperCase();
    if (ANCHOR_SKIP_TAGS.has(tag)) return;

    const isBlock = ANCHOR_BLOCK_TAGS.has(tag);
    if (isBlock) appendBlockSeparator();

    for (let child = node.firstChild; child; child = child.nextSibling) {
      walk(child);
    }

    if (isBlock) appendBlockSeparator();
  };

  walk(rootElement);
  return { normalizedText, runs };
}

/**
 * Najde běh (run) odpovídající normalizovanému znakovému offsetu pomocí binárního vyhledávání.
 */
function findRunIndexForOffset(runs, normOffset) {
  if (!runs || runs.length === 0) return -1;
  let lo = 0;
  let hi = runs.length - 1;
  let bestAfter = -1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const run = runs[mid];
    if (normOffset >= run.normStart && normOffset < run.normEnd) {
      return mid;
    }
    if (normOffset < run.normStart) {
      bestAfter = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return bestAfter !== -1 ? bestAfter : runs.length - 1;
}

/**
 * Převede znakový offset v normalizovaném textu na DOM bod { node, offset }.
 */
export function offsetToDomPoint(indexData, normOffset) {
  const runs = indexData?.runs;
  if (!runs || runs.length === 0) return null;

  const clamped = Math.max(0, Math.min(indexData.normalizedText.length, normOffset));
  const idx = findRunIndexForOffset(runs, clamped);
  if (idx < 0) return null;

  const run = runs[idx];
  const nodeLen = run.node?.nodeValue?.length ?? 0;
  if (clamped <= run.normStart) {
    return { node: run.node, offset: Math.min(nodeLen, run.nodeOffset) };
  }
  if (clamped >= run.normEnd) {
    return { node: run.node, offset: Math.min(nodeLen, run.nodeOffset + run.length) };
  }
  return {
    node: run.node,
    offset: Math.min(nodeLen, run.nodeOffset + (clamped - run.normStart))
  };
}

/**
 * Převede znakový offset na DOM Range v rámci jediného textového uzlu pro spolehlivé měření pozice.
 */
export function offsetToRange(indexData, normOffset, spanLength = 1) {
  const runs = indexData?.runs;
  if (!runs || runs.length === 0) return null;

  const totalLen = indexData.normalizedText.length;
  const clamped = Math.max(0, Math.min(Math.max(0, totalLen - 1), normOffset));
  const idx = findRunIndexForOffset(runs, clamped);
  if (idx < 0) return null;

  const run = runs[idx];
  const node = run.node;
  const nodeLen = node?.nodeValue?.length ?? 0;
  if (!node || nodeLen === 0) return null;

  const localStart = Math.max(0, Math.min(nodeLen - 1, run.nodeOffset + Math.max(0, clamped - run.normStart)));
  const maxInRun = Math.min(nodeLen, run.nodeOffset + run.length);
  const localEnd = Math.max(localStart + 1, Math.min(maxInRun, localStart + Math.max(1, spanLength)));

  try {
    const range = document.createRange();
    range.setStart(node, localStart);
    range.setEnd(node, Math.min(nodeLen, localEnd));
    return range;
  } catch (_) {
    return null;
  }
}

/**
 * Převede DOM bod { node, nodeOffset } na přesný znakový offset v normalizovaném textu kapitoly.
 */
export function domPointToOffset(indexData, targetNode, nodeOffset = 0) {
  const runs = indexData?.runs;
  if (!runs || runs.length === 0 || !targetNode) return 0;

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (run.node !== targetNode) continue;
    const runEndInNode = run.nodeOffset + run.length;
    if (nodeOffset >= run.nodeOffset && nodeOffset <= runEndInNode) {
      return run.normStart + (nodeOffset - run.nodeOffset);
    }
    if (nodeOffset < run.nodeOffset) {
      return run.normStart;
    }
  }
  return 0;
}

/**
 * Sestaví stabilní cestu childNodes indexů od rootElement k targetNode.
 */
export function getDomNodePath(rootElement, targetNode) {
  if (!rootElement || !targetNode) return null;
  const path = [];
  let curr = targetNode;
  while (curr && curr !== rootElement) {
    const parent = curr.parentNode;
    if (!parent) return null;
    const idx = Array.prototype.indexOf.call(parent.childNodes, curr);
    if (idx < 0) return null;
    path.push(idx);
    curr = parent;
  }
  if (curr !== rootElement) return null;
  path.reverse();
  return path;
}

/**
 * Převede cestu childNodes indexů zpět na DOM uzel v rootElement.
 */
export function resolveDomNodePath(rootElement, path) {
  if (!rootElement || !Array.isArray(path)) return null;
  let curr = rootElement;
  for (let i = 0; i < path.length; i++) {
    const idx = path[i];
    if (typeof idx !== "number" || idx < 0 || !curr.childNodes || idx >= curr.childNodes.length) {
      return null;
    }
    curr = curr.childNodes[idx];
  }
  return curr || null;
}

function getWordRangeLengthAtOffset(text, charOffset) {
  if (!text || charOffset < 0 || charOffset >= text.length) return 1;
  let end = charOffset;
  while (end < text.length && !/\s/.test(text[end]) && (end - charOffset) < 24) {
    end++;
  }
  return Math.max(1, end - charOffset);
}

/**
 * Zachytí obsahovou kotvu odpovídající prvnímu viditelnému slovu v levém horním rohu aktivního viewportu.
 *
 * @param {Object} params
 * @returns {Object|null}
 */
export function captureViewportAnchor({
  rootElement,
  contentElement = null,
  stageElement = null,
  viewportElement = null,
  chapterIndex = 0,
  pageIndex = 0,
  exactStep = 0,
  stageWidth = 0,
  isVertical = false,
  bookProgress = 0,
  chapterRatio = 0,
  indexData = null
}) {
  if (!rootElement) return null;
  const idxData = indexData || buildChapterTextIndex(rootElement);
  const { normalizedText } = idxData;

  const contentEl = contentElement || rootElement;
  const contentRect = contentEl.getBoundingClientRect();
  const stageRect = stageElement ? stageElement.getBoundingClientRect() : null;
  const vpRect = viewportElement ? viewportElement.getBoundingClientRect() : stageRect;

  const pageStartX = pageIndex * exactStep;
  const pageEndX = pageStartX + (stageWidth || (stageRect ? stageRect.width : 0));

  const isRectVisible = (r) => {
    if (!r || r.width <= 0.5 || r.height <= 0.5) return false;
    if (isVertical) {
      if (!vpRect) return true;
      return r.bottom > vpRect.top + 2 && r.top < vpRect.bottom - 2;
    }
    const lLeft = r.left - contentRect.left;
    const lRight = r.right - contentRect.left;
    const horizMatch = lRight > pageStartX + 2 && lLeft < pageEndX - 2;
    if (!horizMatch) return false;
    if (stageRect) {
      return r.bottom > stageRect.top + 1 && r.top < stageRect.bottom - 1;
    }
    return true;
  };

  const range = document.createRange();
  let bestCandidate = null;
  let fallbackMediaEl = null;

  const isBetterCandidate = (cand, currentBest) => {
    if (!currentBest) return true;
    // Preferujeme kandidáta, který začíná přímo na aktuální stránce/viewportu (ne z předchozí)
    if (cand.startsInside !== currentBest.startsInside) {
      return cand.startsInside;
    }
    if (!isVertical) {
      // V dvouzápřahovém / vícesloupcovém režimu preferujeme nejlevější sloupec, pak horní řádek
      const colSpan = Math.max(120, (stageWidth || 600) * 0.45);
      const candCol = Math.floor(Math.max(0, cand.layoutLeft - pageStartX) / colSpan);
      const bestCol = Math.floor(Math.max(0, currentBest.layoutLeft - pageStartX) / colSpan);
      if (candCol !== bestCol) return candCol < bestCol;
    }
    if (Math.abs(cand.top - currentBest.top) > 4) {
      return cand.top < currentBest.top;
    }
    return cand.layoutLeft < currentBest.layoutLeft;
  };

  let visitedVisibleWords = 0;

  const inspectElement = (node) => {
    if (!node) return;
    if (visitedVisibleWords >= 40) return;

    if (node.nodeType === Node.TEXT_NODE) {
      const val = node.nodeValue || "";
      if (!val || !/\S/.test(val)) return;

      const wordRegex = /[^\s\u00A0\u00AD\u200B-\u200D\uFEFF\u2060]+/g;
      let match;
      while ((match = wordRegex.exec(val)) !== null) {
        const wStart = match.index;
        const wEnd = wStart + match[0].length;
        try {
          range.setStart(node, wStart);
          range.setEnd(node, wEnd);
          const rects = range.getClientRects();
          for (let j = 0; j < rects.length; j++) {
            const r = rects[j];
            if (!isRectVisible(r)) continue;
            const layoutLeft = r.left - contentRect.left;
            const startsInside = isVertical
              ? (vpRect ? r.top >= vpRect.top - 4 : true)
              : (layoutLeft >= pageStartX - 3);
            const candidate = {
              node,
              offset: wStart,
              top: r.top,
              layoutLeft,
              startsInside
            };
            if (isBetterCandidate(candidate, bestCandidate)) {
              bestCandidate = candidate;
            }
            visitedVisibleWords++;
            break;
          }
        } catch (_) {}
        if (visitedVisibleWords >= 40) break;
      }
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = (node.tagName || "").toUpperCase();
    if (ANCHOR_SKIP_TAGS.has(tag)) return;

    if (["IMG", "IMAGE", "VIDEO", "AUDIO", "CANVAS", "TABLE"].includes(tag)) {
      const r = node.getBoundingClientRect();
      if (isRectVisible(r) && !fallbackMediaEl) {
        fallbackMediaEl = node;
      }
      if (tag !== "TABLE") return;
    }

    // Ořez celých neviditelných větví DOMu v O(1)
    if (node !== rootElement) {
      let anyRectVisible = false;
      try {
        range.selectNodeContents(node);
        const rects = range.getClientRects();
        for (let i = 0; i < rects.length; i++) {
          if (isRectVisible(rects[i])) {
            anyRectVisible = true;
            break;
          }
        }
        if (!anyRectVisible && rects.length === 0) {
          const br = node.getBoundingClientRect();
          if (isRectVisible(br)) anyRectVisible = true;
        }
      } catch (_) {
        anyRectVisible = true;
      }
      if (!anyRectVisible) return;
    }

    for (let child = node.firstChild; child; child = child.nextSibling) {
      inspectElement(child);
      if (visitedVisibleWords >= 40) break;
    }
  };

  inspectElement(rootElement);

  const clampedBookProgress = Math.max(0, Math.min(100, Math.round((Number(bookProgress) || 0) * 100) / 100));
  const clampedChapterRatio = Math.max(0, Math.min(1, Number(chapterRatio) || 0));

  if (bestCandidate) {
    let charOffset = domPointToOffset(idxData, bestCandidate.node, bestCandidate.offset);
    // Pokud Bionic Reading nebo inline tag rozdělil slovo, zůstaneme u začátku slova pokud těsně navazuje
    if (charOffset > 0 && !/\s/.test(normalizedText[charOffset - 1])) {
      let wordStart = charOffset;
      while (wordStart > 0 && !/\s/.test(normalizedText[wordStart - 1]) && (charOffset - wordStart) < 16) {
        wordStart--;
      }
      // Ověříme, zda začátek slova leží stále na téže stránce
      if (wordStart < charOffset) {
        const startRange = offsetToRange(idxData, wordStart, 1);
        const startRect = startRange?.getClientRects?.()[0];
        if (startRect && isRectVisible(startRect)) {
          charOffset = wordStart;
        }
      }
    }

    const snippetRaw = normalizedText.slice(charOffset, charOffset + 48).trimEnd();
    const snippet = snippetRaw.slice(0, 48);
    const prefixStart = Math.max(0, charOffset - 24);
    const prefix = normalizedText.slice(prefixStart, charOffset);
    const suffix = normalizedText.slice(charOffset + snippet.length, charOffset + snippet.length + 24);

    return {
      version: 2,
      chapterIndex: Number(chapterIndex) || 0,
      charOffset,
      domPath: getDomNodePath(rootElement, bestCandidate.node),
      domOffset: bestCandidate.offset,
      snippet,
      prefix,
      suffix,
      chapterLength: normalizedText.length,
      chapterRatio: Math.round(clampedChapterRatio * 10000) / 10000,
      bookProgress: clampedBookProgress,
      hasTextOnPage: true,
      updatedAt: Date.now()
    };
  }

  // Fallback pro stránky obsahující pouze obrázek / média bez textu
  const fallbackOffset = Math.max(
    0,
    Math.min(Math.max(0, normalizedText.length - 1), Math.round(clampedChapterRatio * normalizedText.length))
  );

  return {
    version: 2,
    chapterIndex: Number(chapterIndex) || 0,
    charOffset: pageIndex === 0 ? 0 : fallbackOffset,
    domPath: null,
    domOffset: 0,
    elementDomPath: fallbackMediaEl ? getDomNodePath(rootElement, fallbackMediaEl) : null,
    snippet: normalizedText.slice(fallbackOffset, fallbackOffset + 32).trim(),
    prefix: "",
    suffix: "",
    chapterLength: normalizedText.length,
    chapterRatio: Math.round(clampedChapterRatio * 10000) / 10000,
    bookProgress: clampedBookProgress,
    hasTextOnPage: false,
    updatedAt: Date.now()
  };
}

function findClosestOccurrence(haystack, needle, targetOffset) {
  if (!haystack || !needle) return -1;
  let pos = 0;
  let bestIdx = -1;
  let bestDist = Infinity;

  while (pos < haystack.length) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    const dist = Math.abs(idx - targetOffset);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = idx;
      if (dist === 0) break;
    }
    pos = idx + Math.max(1, needle.length);
  }
  return bestIdx;
}

/**
 * Vyhledá uloženou kotvu v aktuálně vykresleném DOMu kapitoly s víceúrovňovým ověřením.
 *
 * @param {Element} rootElement
 * @param {Object} anchor
 * @param {Object|null} indexData
 */
export function resolveAnchorInChapter(rootElement, anchor, indexData = null) {
  if (!rootElement || !anchor) return null;

  if (anchor.hasTextOnPage === false && Array.isArray(anchor.elementDomPath)) {
    const mediaEl = resolveDomNodePath(rootElement, anchor.elementDomPath);
    if (mediaEl) {
      return {
        element: mediaEl,
        range: null,
        charOffset: Number(anchor.charOffset) || 0,
        matchedBy: "elementDomPath"
      };
    }
  }

  const idxData = indexData || buildChapterTextIndex(rootElement);
  const { normalizedText } = idxData;

  if (!normalizedText || normalizedText.length === 0) {
    if (Array.isArray(anchor.elementDomPath)) {
      const mediaEl = resolveDomNodePath(rootElement, anchor.elementDomPath);
      if (mediaEl) {
        return { element: mediaEl, range: null, charOffset: 0, matchedBy: "elementDomPath" };
      }
    }
    return null;
  }

  const rawOffset = typeof anchor.charOffset === "number" && !Number.isNaN(anchor.charOffset)
    ? Math.max(0, Math.min(normalizedText.length - 1, Math.round(anchor.charOffset)))
    : null;
  const snippet = typeof anchor.snippet === "string" ? anchor.snippet.trim() : "";
  const prefix = typeof anchor.prefix === "string" ? anchor.prefix : "";
  const suffix = typeof anchor.suffix === "string" ? anchor.suffix : "";

  let resolvedOffset = null;
  let matchedBy = "charOffset";

  // 1. Přesná shoda na charOffset s ověřením kontextu (snippet)
  if (rawOffset !== null && snippet) {
    const probePrefix = snippet.slice(0, Math.min(18, snippet.length));
    const atExact = normalizedText.slice(rawOffset, rawOffset + probePrefix.length);
    if (atExact === probePrefix) {
      resolvedOffset = rawOffset;
      matchedBy = "exactOffset+snippet";
    } else {
      // Lokální okno ±96 znaků kolem charOffset
      const winStart = Math.max(0, rawOffset - 96);
      const winEnd = Math.min(normalizedText.length, rawOffset + 96 + snippet.length);
      const localWindow = normalizedText.slice(winStart, winEnd);
      const localIdx = findClosestOccurrence(localWindow, probePrefix, rawOffset - winStart);
      if (localIdx !== -1) {
        resolvedOffset = winStart + localIdx;
        matchedBy = "localWindow+snippet";
      }
    }
  }

  // 2. Kontextové vyhledávání v celé kapitole (prefix+snippet, snippet+suffix, snippet, první slova)
  if (resolvedOffset === null && snippet) {
    const targetRef = rawOffset !== null
      ? rawOffset
      : Math.round((Number(anchor.chapterRatio) || 0) * normalizedText.length);

    if (prefix) {
      const combined = prefix + snippet;
      const idx = findClosestOccurrence(normalizedText, combined, Math.max(0, targetRef - prefix.length));
      if (idx !== -1) {
        resolvedOffset = idx + prefix.length;
        matchedBy = "prefix+snippet";
      }
    }

    if (resolvedOffset === null && suffix) {
      const combined = snippet + suffix;
      const idx = findClosestOccurrence(normalizedText, combined, targetRef);
      if (idx !== -1) {
        resolvedOffset = idx;
        matchedBy = "snippet+suffix";
      }
    }

    if (resolvedOffset === null && snippet.length >= 6) {
      const idx = findClosestOccurrence(normalizedText, snippet, targetRef);
      if (idx !== -1) {
        resolvedOffset = idx;
        matchedBy = "snippet";
      }
    }

    if (resolvedOffset === null) {
      const shortPhrase = snippet.split(/\s+/).slice(0, 3).join(" ");
      if (shortPhrase.length >= 6) {
        const idx = findClosestOccurrence(normalizedText, shortPhrase, targetRef);
        if (idx !== -1) {
          resolvedOffset = idx;
          matchedBy = "shortPhrase";
        }
      }
    }
  }

  // 3. Fallback na DOM cestu (pokud se struktura nezměnila)
  if (resolvedOffset === null && Array.isArray(anchor.domPath)) {
    const domNode = resolveDomNodePath(rootElement, anchor.domPath);
    if (domNode && domNode.nodeType === Node.TEXT_NODE) {
      const domOff = Math.max(0, Math.min((domNode.nodeValue || "").length, Number(anchor.domOffset) || 0));
      resolvedOffset = domPointToOffset(idxData, domNode, domOff);
      matchedBy = "domPath";
    }
  }

  // 4. Fallback na surový charOffset nebo chapterRatio
  if (resolvedOffset === null) {
    if (rawOffset !== null) {
      resolvedOffset = rawOffset;
      matchedBy = "charOffsetFallback";
    } else {
      const ratio = Math.max(0, Math.min(1, Number(anchor.chapterRatio) || 0));
      resolvedOffset = Math.max(0, Math.min(normalizedText.length - 1, Math.round(ratio * normalizedText.length)));
      matchedBy = "chapterRatioFallback";
    }
  }

  const wordLen = getWordRangeLengthAtOffset(normalizedText, resolvedOffset);
  const range = offsetToRange(idxData, resolvedOffset, wordLen);
  if (!range) return null;

  return {
    element: null,
    range,
    charOffset: resolvedOffset,
    matchedBy
  };
}

/**
 * Namapuje obsahovou kotvu na index nově spočítané stránky v horizontálním stránkovaném režimu.
 */
export function mapAnchorToPageIndex({
  rootElement,
  contentElement = null,
  stageElement = null,
  anchor,
  exactStep,
  stageWidth = 0,
  totalPages = 1,
  indexData = null
}) {
  if (!rootElement || !anchor || !exactStep || exactStep <= 0) return null;
  const resolved = resolveAnchorInChapter(rootElement, anchor, indexData);
  if (!resolved) return null;

  const contentRect = (contentElement || rootElement).getBoundingClientRect();
  let targetRect = null;

  if (resolved.range) {
    const rects = resolved.range.getClientRects();
    for (let i = 0; i < rects.length; i++) {
      if (rects[i].width > 0 || rects[i].height > 0) {
        targetRect = rects[i];
        break;
      }
    }
    if (!targetRect) {
      const br = resolved.range.getBoundingClientRect();
      if (br && (br.width > 0 || br.height > 0)) targetRect = br;
    }
  } else if (resolved.element) {
    const br = resolved.element.getBoundingClientRect();
    if (br && (br.width > 0 || br.height > 0)) targetRect = br;
  }

  if (!targetRect) return null;

  const gap = Math.max(0, exactStep - (stageWidth || exactStep));
  const subPixelAllowance = Math.max(4, Math.min(12, gap * 0.25));
  const layoutLeft = targetRect.left - contentRect.left;
  const rawPage = Math.floor((layoutLeft + subPixelAllowance) / exactStep);
  const maxPage = Math.max(0, (totalPages || 1) - 1);

  return {
    pageIndex: Math.max(0, Math.min(maxPage, rawPage)),
    charOffset: resolved.charOffset,
    matchedBy: resolved.matchedBy
  };
}

/**
 * Namapuje obsahovou kotvu na svislou pozici scrollu (delta pro vp.scrollTop) ve vertikálním režimu.
 */
export function mapAnchorToVerticalOffset({
  rootElement,
  viewportElement,
  anchor,
  indexData = null
}) {
  if (!rootElement || !viewportElement || !anchor) return null;
  const resolved = resolveAnchorInChapter(rootElement, anchor, indexData);
  if (!resolved) return null;

  let targetRect = null;
  if (resolved.range) {
    const rects = resolved.range.getClientRects();
    for (let i = 0; i < rects.length; i++) {
      if (rects[i].width > 0 || rects[i].height > 0) {
        targetRect = rects[i];
        break;
      }
    }
    if (!targetRect) targetRect = resolved.range.getBoundingClientRect();
  } else if (resolved.element) {
    targetRect = resolved.element.getBoundingClientRect();
  }

  if (!targetRect) return null;
  const vpRect = viewportElement.getBoundingClientRect();
  return {
    scrollDelta: targetRect.top - vpRect.top - 8,
    charOffset: resolved.charOffset,
    matchedBy: resolved.matchedBy
  };
}
