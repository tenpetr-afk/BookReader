/**
 * epub-parser.js - Moderní EPUB parser pro prohlížeč.
 * Podporuje EPUB 2 i EPUB 3, extrakci metadat, obálky, obsahu (TOC),
 * kapitol a převod interních obrázků a stylů na bezpečné Blob URL.
 */

import { ZipArchive } from "./zip.js";

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

          const blob = await this.archive.getFileAsBlob(fullImgPath, mime);
          const blobUrl = URL.createObjectURL(blob);
          this.blobUrlsToRevoke.push(blobUrl);

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

    // Spočítáme slova
    const cleanText = body.innerText || body.textContent || "";
    const words = cleanText
      .trim()
      .split(/\s+/)
      .filter(w => w.length > 0);
    const wordCount = words.length;

    // Získáme název kapitoly
    let title = "";
    const h1 = body.querySelector("h1, h2, h3");
    if (h1 && h1.textContent.trim()) {
      title = h1.textContent.trim();
    } else {
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
      title = matchedToc ? matchedToc.title : `Kapitola ${index + 1}`;
    }

    return {
      index,
      title,
      html: body.innerHTML,
      wordCount,
      totalChapters: this.spine.length,
      fullPath: spineEntry.fullPath
    };
  }

  /**
   * Spočítá odhad celkového počtu slov v knize
   */
  async calculateTotalWords() {
    let totalWords = 0;
    const chapterWords = [];

    for (let i = 0; i < this.spine.length; i++) {
      try {
        const spineEntry = this.spine[i];
        if (!spineEntry || !spineEntry.fullPath) {
          chapterWords.push(0);
          continue;
        }
        const rawHtml = await this.archive.getFileAsText(spineEntry.fullPath);
        // Bleskově vyčistíme skripty, styly a html značky bez dekódování obrázků
        const cleanText = rawHtml
          .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
          .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/&[a-z0-9#]+;/gi, " ");
        const words = cleanText.trim().split(/\s+/).filter(w => w.length > 0);
        const count = words.length;
        chapterWords.push(count);
        totalWords += count;
      } catch (e) {
        console.warn(`Nepodařilo se spočítat slova v kapitole ${i}:`, e);
        chapterWords.push(0);
      }
    }

    return { totalWords, chapterWords };
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
  }
}
