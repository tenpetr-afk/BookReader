/**
 * zip.js - Lehký parser ZIP archivů pro čtení EPUB souborů přímo v prohlížeči.
 * Využívá moderní webové API DecompressionStream('deflate-raw')
 * bez nutnosti jakýchkoliv externích závislostí.
 */

export class ZipArchive {
  constructor(entries) {
    this.entries = entries; // Map: filepath -> { method, compressedOffset, compressedSize, uncompressedSize }
    this.buffer = null;
  }

  /**
   * Načte a rozparsuje ZIP soubor z ArrayBufferu
   * @param {ArrayBuffer} buffer 
   * @returns {Promise<ZipArchive>}
   */
  static async fromArrayBuffer(buffer) {
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    const len = buffer.byteLength;

    // 1. Vyhledání End of Central Directory (EOCD) od konce souboru
    // Signatura: 0x06054b50
    let eocdOffset = -1;
    for (let i = len - 22; i >= Math.max(0, len - 65536 - 22); i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocdOffset = i;
        break;
      }
    }

    if (eocdOffset === -1) {
      throw new Error("Neplatný formát souboru: EOCD signatura ZIP nebyla nalezena.");
    }

    const numEntries = view.getUint16(eocdOffset + 10, true);
    const cdSize = view.getUint32(eocdOffset + 12, true);
    const cdOffset = view.getUint32(eocdOffset + 16, true);

    const entries = new Map();
    let currentOffset = cdOffset;
    const textDecoder = new TextDecoder("utf-8");

    // 2. Procházení záznamů Central Directory (signatura: 0x02014b50)
    for (let i = 0; i < numEntries; i++) {
      if (currentOffset + 46 > len) break;
      const sig = view.getUint32(currentOffset, true);
      if (sig !== 0x02014b50) {
        break;
      }

      const method = view.getUint16(currentOffset + 10, true);
      const compressedSize = view.getUint32(currentOffset + 20, true);
      const uncompressedSize = view.getUint32(currentOffset + 24, true);
      const fnLen = view.getUint16(currentOffset + 28, true);
      const extraLen = view.getUint16(currentOffset + 30, true);
      const commentLen = view.getUint16(currentOffset + 32, true);
      const localHeaderOffset = view.getUint32(currentOffset + 42, true);

      const filenameBytes = bytes.subarray(currentOffset + 46, currentOffset + 46 + fnLen);
      const filename = textDecoder.decode(filenameBytes);

      // Zjistíme přesný offset dat v Local Headeru
      // Local Header signatura: 0x04034b50
      if (localHeaderOffset + 30 <= len) {
        const lhFnLen = view.getUint16(localHeaderOffset + 26, true);
        const lhExtraLen = view.getUint16(localHeaderOffset + 28, true);
        const dataOffset = localHeaderOffset + 30 + lhFnLen + lhExtraLen;

        entries.set(filename, {
          filename,
          method,
          dataOffset,
          compressedSize,
          uncompressedSize
        });
      }

      currentOffset += 46 + fnLen + extraLen + commentLen;
    }

    const archive = new ZipArchive(entries);
    archive.buffer = buffer;
    return archive;
  }

  /**
   * Získá surová dekomprimovaná data daného souboru v archivu
   * @param {string} filename 
   * @returns {Promise<Uint8Array>}
   */
  async getFile(filename) {
    if (!filename) throw new Error("Název souboru nebyl zadán.");

    const clean = filename.split("#")[0].split("?")[0].replace(/^(\.\/|\/)/, "");
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

    let entry = null;
    // 1. Zkusit přímou shodu v mapě
    for (const cand of candidates) {
      if (this.entries.has(cand)) {
        entry = this.entries.get(cand);
        break;
      }
    }

    // 2. Case-insensitive a relativní shoda napříč záznamy
    if (!entry) {
      const lowerCandidates = candidates.map(c => c.toLowerCase());
      const baseNames = candidates.map(c => {
        const lastSlash = c.lastIndexOf("/");
        return (lastSlash !== -1 ? c.substring(lastSlash + 1) : c).toLowerCase();
      });

      for (const [key, val] of this.entries.entries()) {
        const keyLower = key.toLowerCase();
        let decodedKeyLower = keyLower;
        try {
          decodedKeyLower = decodeURIComponent(keyLower);
        } catch (e) {}

        const matches = lowerCandidates.some(cand => 
          keyLower === cand ||
          decodedKeyLower === cand ||
          keyLower.endsWith("/" + cand) ||
          decodedKeyLower.endsWith("/" + cand) ||
          cand.endsWith("/" + keyLower) ||
          cand.endsWith("/" + decodedKeyLower)
        );

        if (matches) {
          entry = val;
          break;
        }
      }

      // 3. Fallback: hledání podle samotného názvu souboru (basename)
      if (!entry) {
        for (const [key, val] of this.entries.entries()) {
          const keyLastSlash = key.lastIndexOf("/");
          const keyBase = (keyLastSlash !== -1 ? key.substring(keyLastSlash + 1) : key).toLowerCase();
          let decodedKeyBase = keyBase;
          try { decodedKeyBase = decodeURIComponent(keyBase); } catch (e) {}

          if (baseNames.includes(keyBase) || baseNames.includes(decodedKeyBase)) {
            entry = val;
            break;
          }
        }
      }
    }

    if (!entry) {
      throw new Error(`Soubor '${filename}' nebyl v EPUB archivu nalezen.`);
    }

    // Ochrana: prázdný soubor vrátíme přímo bez spouštění DecompressionStream
    if (entry.uncompressedSize === 0 || entry.compressedSize === 0) {
      return new Uint8Array(0);
    }

    const bytes = new Uint8Array(this.buffer, entry.dataOffset, entry.compressedSize);

    // Metoda 0: Uloženo bez komprese (STORED)
    if (entry.method === 0) {
      return bytes;
    }

    // Metoda 8: DEFLATE komprese
    if (entry.method === 8) {
      if (typeof DecompressionStream !== "undefined") {
        try {
          const ds = new DecompressionStream("deflate-raw");
          const stream = new Blob([bytes]).stream().pipeThrough(ds);
          const decompressedBuffer = await new Response(stream).arrayBuffer();
          return new Uint8Array(decompressedBuffer);
        } catch (err) {
          console.warn("DecompressionStream selhal, zkouším alternativu:", err);
        }
      }
      throw new Error("Prohlížeč nepodporuje DecompressionStream('deflate-raw')");
    }

    throw new Error(`Nepodporovaná metoda komprese ZIP: ${entry.method}`);
  }

  /**
   * Načte soubor jako text (UTF-8)
   */
  async getFileAsText(filename) {
    const bytes = await this.getFile(filename);
    const decoder = new TextDecoder("utf-8");
    return decoder.decode(bytes);
  }

  /**
   * Načte soubor jako Blob s daným MIME typem
   */
  async getFileAsBlob(filename, mimeType = "application/octet-stream") {
    const bytes = await this.getFile(filename);
    return new Blob([bytes], { type: mimeType });
  }

  /**
   * Zkontroluje, zda soubor v archivu existuje
   */
  hasFile(filename) {
    if (!filename) return false;
    const clean = filename.split("#")[0].split("?")[0].replace(/^(\.\/|\/)/, "");
    const candidates = [clean];
    try { candidates.push(decodeURIComponent(clean)); } catch (e) {}

    for (const cand of candidates) {
      if (this.entries.has(cand)) return true;
    }

    const lowerCandidates = candidates.map(c => c.toLowerCase());
    for (const key of this.entries.keys()) {
      const keyLower = key.toLowerCase();
      if (lowerCandidates.some(c => keyLower === c || keyLower.endsWith("/" + c) || c.endsWith("/" + keyLower))) {
        return true;
      }
    }
    return false;
  }

  /**
   * Vrátí seznam všech souborů v archivu
   */
  listFiles() {
    return Array.from(this.entries.keys());
  }
}
