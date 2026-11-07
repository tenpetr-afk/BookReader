/**
 * text-parser.js - Pokročilé zpracování textu a striktní analytika slov pro čtecí statistiky.
 *
 * Zajišťuje:
 * - Line-break dehyphenation: Spojování slov rozdělených koncem řádku (hyphen + newline)
 *   včetně podpory soft-hyphenů (\u00AD / &shy;) a Unicode dělicích znaků.
 * - Striktní validaci slov: Započítávání výhradně platných slov obsahujících
 *   abecední/jazykové znaky (\p{L}) s plnou podporou Unicode a diakritiky.
 * - Filtrování samostatné interpunkce, matematických symbolů, uvozovek, pomlček,
 *   závorek a fragmentů bílých znaků, aby se nezapočítávaly do statistik slov a WPM.
 * - Bezpečnou extrakci textu z DOM nodů a HTML bez zásahu do vykreslování čtečky.
 */

// Znaky označující dělení slov na konci řádku:
// - \u002D (Hyphen-Minus -)
// - \u00AD (Soft Hyphen &shy;)
// - \u2010 (Hyphen ‐)
// - \u2011 (Non-breaking hyphen ‑)
// - \u058A (Armenian hyphen ֊)
// - \u1806 (Mongolian todo soft hyphen ᠆)
// - \uFE63 (Small hyphen-minus ﹣)
// - \uFF0D (Fullwidth hyphen-minus －)
const HYPHEN_LINE_BREAK_REGEX = /([\p{L}\p{M}\p{N}]+)[-\u00AD\u2010\u2011\u058A\u1806\uFE63\uFF0D]\s*[\r\n]+\s*([\p{L}\p{M}\p{N}]+)/gu;

// Neviditelné formátovací a dělicí znaky ke kompletnímu očištění uvnitř slov
const INVISIBLE_STRIP_REGEX = /[\u00AD\u200B-\u200D\uFEFF\u2060]/g;

// Tokenizační regex pro slova v textu (včetně vnitřních apostrofů a spojovníků)
const WORD_TOKEN_REGEX = /[\p{L}\p{M}\p{N}]+(?:['’\-‐‑][\p{L}\p{M}\p{N}]+)*/gu;

// Striktní ověření přítomnosti abecedního / jazykového znaku (Unicode Letter)
const HAS_LETTER_REGEX = /\p{L}/u;

// Blokové HTML značky, které při převodu na text představují hranici řádku/odstavce
const BLOCK_TAG_NAMES = new Set([
  "P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "BLOCKQUOTE",
  "TR", "SECTION", "ARTICLE", "HEADER", "FOOTER", "NAV", "ASIDE", "DD", "DT"
]);

/**
 * Odstraní zalomení řádků s pomlčkami a spojí rozdělená slova zpět do jediného celku.
 * Zpracovává rovněž soft-hypheny a jazykově specifické dělicí znaky.
 *
 * @param {string} text Vstupní text
 * @returns {string} Text s normalizovanými spojenými slovy
 */
export function dehyphenateText(text) {
  if (!text || typeof text !== "string") return "";

  let dehyphenated = text;
  let prev;
  // Řetězené spojení pro případy vícenásobných zalomení (např. in-\nter-\nna-\ntional)
  do {
    prev = dehyphenated;
    dehyphenated = dehyphenated.replace(HYPHEN_LINE_BREAK_REGEX, "$1$2");
  } while (dehyphenated !== prev);

  // Spojení soft-hyphenů (\u00AD) uvnitř slov bez zalomení (např. au\u00ADtomobil -> automobil)
  dehyphenated = dehyphenated.replace(/([\p{L}\p{M}\p{N}])\u00AD+([\p{L}\p{M}\p{N}])/gu, "$1$2");

  // Očištění zbytkových neviditelných znaků
  dehyphenated = dehyphenated.replace(INVISIBLE_STRIP_REGEX, "");

  return dehyphenated;
}

/**
 * Striktní ověření, zda je zadaný token platným slovem obsahujícím abecední/jazykové znaky.
 * Filtruje samostatnou interpunkci, symboly, závorky, pomlčky, čísla a prázdné fragmenty.
 *
 * @param {string} token Kandidátní slovo
 * @returns {boolean} True pokud obsahuje alespoň jeden písmenný znak
 */
export function isValidWord(token) {
  if (!token || typeof token !== "string") return false;
  return HAS_LETTER_REGEX.test(token);
}

/**
 * Extrahuje pole platných slov z textu po dehyphenaci na koncích řádků
 * a striktním odfiltrování interpunkce a nealfabetických symbolů.
 *
 * @param {string} text Vstupní text
 * @returns {string[]} Pole platných slov
 */
export function extractWords(text) {
  if (!text || typeof text !== "string") return [];

  const normalized = dehyphenateText(text);
  const matches = normalized.match(WORD_TOKEN_REGEX);
  if (!matches) return [];

  return matches.filter(isValidWord);
}

/**
 * Spočítá přesný počet platných slov pro čtecí metriky a statistiky (WPM).
 *
 * @param {string} text Vstupní text
 * @returns {number} Počet platných slov
 */
export function countWords(text) {
  return extractWords(text).length;
}

/**
 * Extrahuje čistý text z DOM elementu nebo DocumentFragmentu s korektním
 * zachováním konců řádků u <br> a blokových elementů, BEZ jakékoliv modifikace DOMu.
 *
 * @param {Node} rootNode Kořenový DOM element
 * @returns {string} Extrahovaný text připravený pro dehyphenaci a počítání slov
 */
export function extractTextFromNode(rootNode) {
  if (!rootNode) return "";
  let text = "";

  function walk(node) {
    if (!node) return;
    if (node.nodeType === 3 /* Node.TEXT_NODE */) {
      text += node.textContent || "";
      return;
    }
    if (node.nodeType !== 1 /* Node.ELEMENT_NODE */) return;

    const tag = (node.tagName || "").toUpperCase();
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "SVG" || tag === "CANVAS") return;
    if (tag === "BR") {
      text += "\n";
      return;
    }

    const isBlock = BLOCK_TAG_NAMES.has(tag);
    if (isBlock && text.length > 0 && !text.endsWith("\n")) {
      text += "\n";
    }

    for (let child = node.firstChild; child; child = child.nextSibling) {
      walk(child);
    }

    if (isBlock && text.length > 0 && !text.endsWith("\n")) {
      text += "\n";
    }
  }

  walk(rootNode);
  return text;
}

/**
 * Převede surový HTML řetězec na čistý text s normalizací zalomení řádků
 * a zachováním soft-hyphen entit pro analytiku celého EPUB svazku.
 *
 * @param {string} rawHtml Surové HTML kapitoly
 * @returns {string} Vyčištěný text připravený pro dehyphenaci a počítání slov
 */
export function extractTextFromHtml(rawHtml) {
  if (!rawHtml || typeof rawHtml !== "string") return "";

  // 1. Odstranění skriptů a stylů
  let text = rawHtml
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ");

  // 2. Dekódování soft-hyphen entit a pevných mezer před odstraněním tagů
  text = text
    .replace(/&(?:shy|#173|#x0*ad);/gi, "\u00AD")
    .replace(/&(?:nbsp|#160|#xa0);/gi, " ");

  // 3. Převedení <br> a koncových blokových značek na zalomení řádku \n
  text = text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|h[1-6]|li|blockquote|tr|section|article|dd|dt)>/gi, "\n")
    .replace(/<[^>]+>/g, "");

  // 4. Dekódování běžných HTML entit
  text = text
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, dec) => {
      try { return String.fromCharCode(parseInt(dec, 10)); } catch (e) { return " "; }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      try { return String.fromCharCode(parseInt(hex, 16)); } catch (e) { return " "; }
    });

  return text;
}

/**
 * Sestaví souvislý text strany PDF ze struktury TextContent (PDF.js)
 * s přesnou detekcí konců řádků a zachováním dělicích pomlček pro dehyphenaci.
 *
 * @param {object} textContent Výsledek volání page.getTextContent() z PDF.js
 * @returns {string} Celý text strany s korektními zalomeními řádků
 */
export function extractTextFromPdfContent(textContent) {
  if (!textContent || !Array.isArray(textContent.items)) return "";
  let fullText = "";
  let prevY = null;
  let prevX = null;
  let prevWidth = 0;

  for (const item of textContent.items) {
    if (!item || typeof item.str !== "string") continue;
    const str = item.str;
    if (str.length === 0) continue;

    const ty = (item.transform && item.transform.length >= 6) ? item.transform[5] : null;
    const tx = (item.transform && item.transform.length >= 6) ? item.transform[4] : null;

    let isNewLine = false;
    if (item.hasEOL) {
      isNewLine = true;
    } else if (prevY !== null && ty !== null && Math.abs(ty - prevY) > 3) {
      isNewLine = true;
    }

    if (isNewLine) {
      if (fullText.length > 0 && !fullText.endsWith("\n")) {
        fullText += "\n";
      }
    } else if (fullText.length > 0) {
      const lastChar = fullText[fullText.length - 1];
      const firstChar = str[0];
      if (!/[\s\u00A0\u00AD]/.test(lastChar) && !/[\s\u00A0\u00AD]/.test(firstChar)) {
        if (prevX !== null && tx !== null && tx > (prevX + prevWidth + 1)) {
          fullText += " ";
        }
      }
    }

    fullText += str;
    prevY = ty;
    prevX = tx;
    prevWidth = item.width || 0;

    if (item.hasEOL && !fullText.endsWith("\n")) {
      fullText += "\n";
    }
  }

  return fullText;
}

if (typeof window !== "undefined") {
  window.TextParser = {
    dehyphenateText,
    isValidWord,
    extractWords,
    countWords,
    extractTextFromNode,
    extractTextFromHtml,
    extractTextFromPdfContent
  };
}
