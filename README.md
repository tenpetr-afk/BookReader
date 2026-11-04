# LuminaReader 📖

Moderní, rychlá a na soukromí orientovaná webová aplikace pro čtení elektronických knih a dokumentů ve formátech **EPUB** a **PDF** s analytickým měřením rychlosti čtení, statistikami, cloudovou synchronizací a adaptivním čtecím pravítkem.

---

## ✨ Hlavní funkce

### 1. Čtečka elektronických knih (EPUB & PDF)
- **Nahrávání knih a dokumentů**: Přetažení (Drag & Drop) nebo výběr souborů `.epub` a `.pdf` z disku.
- **Lokální knihovna**: Všechny knihy i data jsou bezpečně uloženy přímo v prohlížeči (`IndexedDB`), funguje i zcela offline.
- **Navigace**: Obsah knihy (TOC), listování kapitolami a stránkami, zapamatování přesné pozice čtení.
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
- **Cloudová synchronizace**: Volitelná synchronizace historie a statistik se Supabase.

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
├── .github/
│   └── workflows/
│       └── deploy.yml       # GitHub Actions deployment na GitHub Pages
├── css/
│   ├── reader.css           # Typografie čtení a styly čtecího pravítka
│   └── style.css            # Styly uživatelského rozhraní, témata, panely a modály
├── js/
│   ├── app.js               # Hlavní koordinátor aplikace a UI událostí
│   ├── charts.js            # SVG grafy pro statistiky
│   ├── epub-parser.js       # Kompletní parser EPUB standardu (EPUB 2 i 3)
│   ├── pdf-loader.js        # Integrace Mozilla PDF.js pro načítání PDF knih
│   ├── ruler.js             # Adaptivní čtecí pravítko a pacer
│   ├── storage.js           # Správce IndexedDB a localStorage
│   ├── supabase-client.js   # Klient pro cloudovou databázi Supabase
│   ├── supabase-sync.js     # Synchronizace čtecích relací a dat se Supabase
│   ├── tracker.js           # Měřič rychlosti čtení, WPM a detekce aktivity
│   └── zip.js               # Zero-dependency ZIP dekomprese (DecompressionStream)
├── index.html               # Hlavní HTML struktura aplikace
├── server.py                # Lehký Python HTTP server s automatickým otevřením prohlížeče
├── start.sh                 # Spouštěcí bash skript
├── bump_version.py          # Nástroj pro správu verze a cache-busting
├── supabase_schema.sql      # SQL schéma pro tabulky v Supabase
└── README.md                # Dokumentace aplikace
```
