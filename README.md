# LuminaReader 📖

Moderní, rychlá a na soukromí orientovaná webová aplikace pro čtení elektronických knih ve formátu **EPUB** s analytickým měřením rychlosti čtení, statistikami a adaptivním čtecím pravítkem.

---

## ✨ Hlavní funkce

### 1. Čtečka elektronických knih (EPUB)
- **Nahrávání knih**: Přetažení (Drag & Drop) nebo výběr souboru `.epub` z disku.
- **Lokální knihovna**: Všechny knihy i data jsou bezpečně uloženy přímo v prohlížeči (`IndexedDB`), funguje i zcela offline.
- **Ukázková kniha v ceně**: Součástí je předpřipravená kniha *Karel Čapek – R.U.R.* pro okamžité vyzkoušení.
- **Navigace**: Obsah knihy (TOC), listování kapitolami, zapamatování přesné pozice čtení.
- **Typografie a motivy**:
  - 5 barevných témat: **Světlý**, **Teplý papír**, **Sépie**, **Tmavý**, **AMOLED černá**.
  - Výběr písem: Georgia (Serif), Merriweather, Inter (Sans-serif) a speciální písmo pro snazší čtení při dyslexii.
  - Nastavitelná velikost písma, řádkování, šířka stránky a zarovnání (do bloku / vlevo).

### 2. Měření rychlosti čtení a statistiky
- **Chytrý měřič aktivity**: Automatická detekce reálného čtení. Pokud odejdete od počítače na více než 45 sekund, stopky se samy pozastaví, aby nezkreslily výsledky.
- **WPM (Words Per Minute)**: Měření rychlosti čtení v reálném čase i celkového průměru.
- **Odhad zbývajícího času (ETR)**: Výpočet času do konce aktuální kapitoly i celé knihy na základě vaší reálné rychlosti.
- **Statistický dashboard**:
  - Přehledové karty: celkový čas čtení, průměrné WPM, celkem přečtených slov, denní série (streak).
  - Graf času čtení za posledních 7 dní.
  - Graf vývoje rychlosti čtení v čase.
  - Export všech dat do formátu JSON.

### 3. Čtecí pravítko (Reading Ruler)
- Pomůcka pro udržení pozornosti a prevenci přeskakování řádků.
- **3 vizuální režimy**:
  - **Zvýrazňovač**: Barevný průhledný pruh přes čtený řádek.
  - **Zaostření (Focus Window)**: Ztmaví zbytek obrazovky a nechá čirý průzor pouze pro 1–3 řádky.
  - **Linka**: Elegantní vodicí linka pod aktuálním řádkem.
- **Režimy pohybu**:
  - **Sledování kurzoru myši** (plynulý pohyb).
  - **Klávesové ovládání** (šipky Nahoru / Dolů).
  - **Automatické tempo (Speed Pacer)**: Pravítko se plynule posouvá zvolenou rychlostí (např. 250 WPM) pro trénink rychločtení.
- Nastavitelná výška, barva (jantarová, tyrkysová, smaragdová, levandulová, břidlicová) a intenzita ztmavení.

---

## 🚀 Jak aplikaci spustit

Aplikace nevyžaduje Node.js ani `npm install` – běží s využitím standardní knihovny Pythonu 3.

### Jedním příkazem v terminálu:
```bash
./start.sh
```

Nebo přímo přes Python:
```bash
python3 server.py
```

Aplikace se automaticky otevře ve vašem výchozím prohlížeči na adrese:
👉 **`http://localhost:8000`**

---

## ⌨️ Klávesové zkratky

| Klávesa | Akce |
| :--- | :--- |
| **`R`** | Zapnout / vypnout čtecí pravítko |
| **`T`** | Otevřít / zavřít obsah knihy (TOC) |
| **`S`** | Otevřít statistický panel s grafy |
| **`Esc`** | Zavřít otevřený panel nebo okno |
| **`Alt + ◄` / `Alt + ►`** | Předchozí / Další kapitola |
| **`Šipka Nahoru / Dolů`** | Posun pravítka (v režimu klávesnice) |

---

## 📁 Struktura projektu

```
BookReader/
├── start.sh                 # Spouštěcí bash skript
├── server.py                # Lehký Python HTTP server s automatickým otevřením prohlížeče
├── generate_sample_book.py  # Generátor ukázkové knihy R.U.R.
├── README.md                # Dokumentace aplikace
└── public/
    ├── index.html           # Hlavní HTML struktura
    ├── css/
    │   ├── style.css        # Styly uživatelského rozhraní, témata, modály
    │   └── reader.css       # Typografie čtení a styly čtecího pravítka
    ├── js/
    │   ├── zip.js           # Zero-dependency ZIP dekomprese (DecompressionStream)
    │   ├── epub-parser.js   # Kompletní parser EPUB standardu (EPUB 2 i 3)
    │   ├── storage.js       # Správce IndexedDB a localStorage
    │   ├── tracker.js       # Měřič rychlosti čtení, WPM a detekce aktivity
    │   ├── ruler.js         # Čtecí pravítko a speed pacer
    │   ├── charts.js        # SVG grafy pro statistiky
    │   └── app.js           # Hlavní koordinátor aplikace a UI událostí
    └── sample-books/
        └── rur.epub         # Vygenerovaná ukázková kniha
```
