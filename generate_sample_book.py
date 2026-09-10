#!/usr/bin/env python3
"""
generate_sample_book.py
Generuje validní EPUB knihu: Karel Čapek - R.U.R. (Rossum's Universal Robots)
obsahující metadata, strukturu kapitol, CSS styly a obálku ve formátu SVG.
"""

import os
import zipfile

def create_sample_epub(output_path="public/sample-books/rur.epub"):
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    
    # Obsah jednotlivých částí knihy
    mimetype = b"application/epub+zip"
    
    container_xml = """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"""

    cover_svg = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 900" width="100%" height="100%">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1e1b4b" />
      <stop offset="50%" stop-color="#312e81" />
      <stop offset="100%" stop-color="#0f172a" />
    </linearGradient>
    <linearGradient id="accent" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#38bdf8" />
      <stop offset="100%" stop-color="#818cf8" />
    </linearGradient>
  </defs>
  <rect width="600" height="900" fill="url(#bg)"/>
  <circle cx="300" cy="360" r="140" fill="none" stroke="url(#accent)" stroke-width="4" stroke-dasharray="8 6"/>
  <circle cx="300" cy="360" r="90" fill="#1e293b" opacity="0.8"/>
  <path d="M 270 330 L 330 330 L 330 390 L 270 390 Z" fill="none" stroke="#38bdf8" stroke-width="4"/>
  <circle cx="285" cy="350" r="6" fill="#38bdf8"/>
  <circle cx="315" cy="350" r="6" fill="#38bdf8"/>
  <line x1="285" y1="375" x2="315" y2="375" stroke="#38bdf8" stroke-width="3"/>
  <text x="300" y="160" font-family="system-ui, sans-serif" font-size="28" font-weight="600" fill="#94a3b8" text-anchor="middle" letter-spacing="4">KAREL ČAPEK</text>
  <text x="300" y="600" font-family="system-ui, sans-serif" font-size="64" font-weight="900" fill="#ffffff" text-anchor="middle" letter-spacing="8">R. U. R.</text>
  <text x="300" y="650" font-family="system-ui, sans-serif" font-size="20" font-weight="400" fill="#38bdf8" text-anchor="middle" letter-spacing="2">Rossumovi Univerzální Roboti</text>
  <text x="300" y="800" font-family="system-ui, sans-serif" font-size="16" fill="#64748b" text-anchor="middle">Kolektivní drama o vstupní komedii a třech dějstvích</text>
</svg>"""

    stylesheet_css = """
body {
    font-family: Georgia, serif;
    line-height: 1.6;
    margin: 5%;
    color: inherit;
}
h1, h2, h3 {
    text-align: center;
    font-family: system-ui, -apple-system, sans-serif;
    color: inherit;
}
.character {
    font-weight: bold;
    margin-top: 1em;
    letter-spacing: 0.5px;
}
.stage-direction {
    font-style: italic;
    color: #666;
    margin: 0.5em 0;
}
p {
    margin-bottom: 0.8em;
    text-indent: 1.2em;
}
p.no-indent {
    text-indent: 0;
}
.center {
    text-align: center;
}
"""

    intro_xhtml = """<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="cs">
<head>
  <title>R.U.R. - Úvod</title>
  <link rel="stylesheet" type="text/css" href="stylesheet.css"/>
</head>
<body>
  <h1>R.U.R.</h1>
  <h3 class="center">Rossum’s Universal Robots</h3>
  <p class="center"><strong>Karel Čapek</strong></p>
  <hr/>
  <h2>Osoby</h2>
  <p class="no-indent"><strong>HARRY DOMIN</strong>, centrální ředitel Rossumových Univerzálních Robotů</p>
  <p class="no-indent"><strong>INŽ. FABRY</strong>, generální technický ředitel R.U.R.</p>
  <p class="no-indent"><strong>DR. GALL</strong>, přednosta fyziologického a výzkumného oddělení R.U.R.</p>
  <p class="no-indent"><strong>DR. HALLEMEIER</strong>, přednosta ústavu pro výchovu a psychologii Robotů</p>
  <p class="no-indent"><strong>STAVITEL ALQUIST</strong>, šéf staveb R.U.R.</p>
  <p class="no-indent"><strong>KONZUL BUSMAN</strong>, generální komerční ředitel R.U.R.</p>
  <p class="no-indent"><strong>HELENA GLORYOVÁ</strong>, dcera prezidenta Gloryho</p>
  <p class="no-indent"><strong>NÁNA</strong>, její chůva</p>
  <p class="no-indent"><strong>RADIUS</strong>, robot</p>
  <p class="no-indent"><strong>PRIMUS</strong>, robot</p>
  <p class="no-indent"><strong>HELENA</strong>, robotka</p>
</body>
</html>"""

    predzpev_xhtml = """<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="cs">
<head>
  <title>Předehra</title>
  <link rel="stylesheet" type="text/css" href="stylesheet.css"/>
</head>
<body>
  <h2>Předehra</h2>
  <p class="stage-direction">Centrální kancelář továrny Rossum’s Universal Robots. Vpravo okna s výhledem na nekonečné řady továrních budov; vlevo další kanceláře. Harry Domin sedí u velkého psacího stolu.</p>

  <p class="character">DOMIN (diktuje písařce):</p>
  <p>„...že za vady materiálu neručíme. Zboží bylo odesláno na parníku Amelia a splňuje veškeré požadavky moderní práce. Zároveň expedujeme další zásilku patnácti tisíc dělnických Robotů do Buenos Aires.“ Máte to, slečno?</p>

  <p class="character">SULLA:</p>
  <p>Ano, pane řediteli.</p>

  <p class="character">DOMIN:</p>
  <p>Nový dopis: „E. Weinger and Co., Hamburk. Dnes vám zasíláme vzorek robotické pracovní síly pro předení lnu. Výkonnost jednoho Robota nahrazuje dva a půl lidského dělníka při spotřebě pouhých dvou set gramů výživné pasty denně...“</p>

  <p class="stage-direction">(Vstoupí sluha s vizitkou.)</p>

  <p class="character">DOMIN:</p>
  <p>Kdo je to? Helena Gloryová? Dcera prezidenta Gloryho? Ukažte ji dál!</p>

  <p class="stage-direction">(Vchází Helena Gloryová. Mladá, elegantní, zvídavá dáma.)</p>

  <p class="character">HELENA:</p>
  <p>Dobrý den, pane generální řediteli. Přicházím jménem Ligy lidskosti.</p>

  <p class="character">DOMIN:</p>
  <p>Vítejte na našem ostrově, slečno Gloryová! Málokdo zvenčí se dostane až sem, do kolébky nového věku. Čemu vděčíme za tuto neobyčejnou čest?</p>

  <p class="character">HELENA:</p>
  <p>Chci vidět vaši výrobu. Chci vědět, jak zacházíte se svými stvořeními. Svět se dívá s obavami i fascinací na to, co zde vzniká. Jsou Roboti opravdu jen stroje, nebo mají duši?</p>

  <p class="character">DOMIN (s úsměvem):</p>
  <p>Slečno, starý Rossum byl geniální chemik a filozof. Chtěl dokázat, že Bůh je zbytečný. Vzal zkumavky, protoplazmu a začal tvořit život. Chtěl stvořit člověka. Ale mladý Rossum, inženýr, pochopil něco daleko důležitějšího: člověk je drahý, neefektivní a zbytečně složitý mechanismus. Mladý Rossum řekl: Uděláme dělníka. Zbavíme ho citů, umění, lásky, vzdoru a smutku. Vytvoříme dokonalý biologický stroj!</p>
</body>
</html>"""

    dejstvi1_xhtml = """<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="cs">
<head>
  <title>První dějství</title>
  <link rel="stylesheet" type="text/css" href="stylesheet.css"/>
</head>
<body>
  <h2>První dějství</h2>
  <p class="stage-direction">O deset let později. Salon v Dominově vile. Na stole kytice, v pozadí velká terasa s výhledem na přístav. Helena sedí v křesle, Nána jí upravuje šaty.</p>

  <p class="character">NÁNA:</p>
  <p>Já vám povídám, slečno Helenko – tedy paní ředitelová –, že tohle nemůže dobře skončit. Vyrábět lidi v kádích jako pivo! To je rouhání proti Pánu Bohu. A ty jejich tváře bez úsměvu, oči jako skleněné kuličky... Mně z nich běhá mráz po zádech!</p>

  <p class="character">HELENA:</p>
  <p>Náno, buď zticha. Roboti dělají všechnu těžkou práci za lidi. Lidé už nemusí dřít v dolech, nemusí umírat u tavicích pecí. Může to být ráj na zemi.</p>

  <p class="character">NÁNA:</p>
  <p>Ráj? A proč se tedy za celých deset let na celém světě nenarodilo jediné lidské dítě? Povězte mi to! Bůh se odvrátil od lidstva, protože lidé zlenivěli a dali se obsluhovat bezduchými loutkami.</p>

  <p class="stage-direction">(Vstupuje Alquist, stavitel.)</p>

  <p class="character">ALQUIST:</p>
  <p>Dobrý den, Heleno. Přinesl jsem vám květiny ze skleníku.</p>

  <p class="character">HELENA:</p>
  <p>Děkuji, Alquiste. Vy jediný tady ještě pracujete vlastníma rukama. Všichni ostatní už jen velí Robotům.</p>

  <p class="character">ALQUIST:</p>
  <p>Práce rukama očišťuje, Heleno. Modlím se prací. Dnes ráno jsem dostal zprávu z loděnice. Poslední nákladní parník nepřivezl žádnou poštu. Na všech mořích se děje něco zvláštního. Roboti v přístavech odmítají vykládat zboží. Postávají v tichých skupinách a dívají se jeden na druhého.</p>

  <p class="character">HELENA (znepokojeně):</p>
  <p>Myslíte, že se bouří? Že Dr. Gall změnil jejich mozek příliš?</p>

  <p class="character">ALQUIST:</p>
  <p>Nevím. Ale když se podíváte z okna na oceán, uvidíte dělovou loď Ultimus. Všechny kanóny jsou namířeny na továrnu...</p>
</body>
</html>"""

    dejstvi2_xhtml = """<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="cs">
<head>
  <title>Druhé dějství</title>
  <link rel="stylesheet" type="text/css" href="stylesheet.css"/>
</head>
<body>
  <h2>Druhé dějství</h2>
  <p class="stage-direction">Táž místnost. Všechna okna jsou zabedněná těžkými okenicemi. Zvenčí doléhá hrozivé hučení tisícihlavého davu Robotů obkličujících vilu.</p>

  <p class="character">DOMIN:</p>
  <p>Kabel do elektrické sítě pod plotem je připojen? Fabry, odpovídejte!</p>

  <p class="character">FABRY:</p>
  <p>Ano, proud je zapojen. Pokud se dotknou železného zábradlí, zabije je to. Máme ještě pár hodin energie z centrální parní turbíny.</p>

  <p class="character">BUSMAN (počítá na kalkulačce):</p>
  <p>Pánové, já to spočítal. Kdybychom jim prodali tajemství výroby – ten starý Rossumův rukopis s receptem na protoplazmu –, nechají nás odjet. Máme v trezoru miliardy. Můžeme si koupit nový život kdekoliv na světě!</p>

  <p class="character">HELENA (bledá):</p>
  <p>Harry... ten rukopis...</p>

  <p class="character">DOMIN:</p>
  <p>Co je s rukopisem, Heleno? Je bezpečně uložen v ohnivzdorném trezoru. Je to jediná zbraň, kterou proti nim máme. Bez něj se nemohou dále množit!</p>

  <p class="character">HELENA:</p>
  <p>Já... já jsem ho spálila. Dnes ráno v krbu.</p>

  <p class="stage-direction">(Těžké, omračující ticho.)</p>

  <p class="character">DOMIN (tiše):</p>
  <p>Tys ho spálila? Proč jsi to udělala?</p>

  <p class="character">HELENA:</p>
  <p>Chtěla jsem, aby to skončilo! Aby lidé už nevyráběli další miliony otroků! Myslela jsem, že tím zachráním svět...</p>

  <p class="character">HALLEMEIER (od okna):</p>
  <p>Právě zhasla světla v docích. Vypnuli elektrárnu. Proud v plotě je pryč. Jdou sem.</p>
</body>
</html>"""

    content_opf = """<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="BookId">urn:uuid:12345678-rur-capek-demo</dc:identifier>
    <dc:title>R.U.R. (Rossum's Universal Robots)</dc:title>
    <dc:creator>Karel Čapek</dc:creator>
    <dc:language>cs</dc:language>
    <dc:publisher>LuminaReader Classics</dc:publisher>
    <dc:description>Klasické vědeckofantastické drama Karla Čapka, které světu dalo slovo ROBOT.</dc:description>
    <meta property="dcterms:modified">2026-09-08T12:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="cover" href="cover.svg" media-type="image/svg+xml" properties="cover-image"/>
    <item id="style" href="stylesheet.css" media-type="text/css"/>
    <item id="toc" href="toc.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="intro" href="intro.xhtml" media-type="application/xhtml+xml"/>
    <item id="predzpev" href="predzpev.xhtml" media-type="application/xhtml+xml"/>
    <item id="dejstvi1" href="dejstvi1.xhtml" media-type="application/xhtml+xml"/>
    <item id="dejstvi2" href="dejstvi2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="intro"/>
    <itemref idref="predzpev"/>
    <itemref idref="dejstvi1"/>
    <itemref idref="dejstvi2"/>
  </spine>
</package>"""

    toc_xhtml = """<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="cs">
<head>
  <title>Obsah</title>
  <link rel="stylesheet" type="text/css" href="stylesheet.css"/>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Obsah knihy</h1>
    <ol>
      <li><a href="intro.xhtml">Titulní strana a Osoby</a></li>
      <li><a href="predzpev.xhtml">Předehra: V kanceláři Dominově</a></li>
      <li><a href="dejstvi1.xhtml">První dějství: O deset let později</a></li>
      <li><a href="dejstvi2.xhtml">Druhé dějství: V obležení</a></li>
    </ol>
  </nav>
</body>
</html>"""

    # Vytvoříme zip soubor
    with zipfile.ZipFile(output_path, 'w') as epub:
        # mimetype musí být první soubor a bez komprese
        epub.writestr('mimetype', mimetype, compress_type=zipfile.ZIP_STORED)
        
        # Ostatní soubory komprimované
        epub.writestr('META-INF/container.xml', container_xml, compress_type=zipfile.ZIP_DEFLATED)
        epub.writestr('OEBPS/content.opf', content_opf, compress_type=zipfile.ZIP_DEFLATED)
        epub.writestr('OEBPS/cover.svg', cover_svg, compress_type=zipfile.ZIP_DEFLATED)
        epub.writestr('OEBPS/stylesheet.css', stylesheet_css, compress_type=zipfile.ZIP_DEFLATED)
        epub.writestr('OEBPS/toc.xhtml', toc_xhtml, compress_type=zipfile.ZIP_DEFLATED)
        epub.writestr('OEBPS/intro.xhtml', intro_xhtml, compress_type=zipfile.ZIP_DEFLATED)
        epub.writestr('OEBPS/predzpev.xhtml', predzpev_xhtml, compress_type=zipfile.ZIP_DEFLATED)
        epub.writestr('OEBPS/dejstvi1.xhtml', dejstvi1_xhtml, compress_type=zipfile.ZIP_DEFLATED)
        epub.writestr('OEBPS/dejstvi2.xhtml', dejstvi2_xhtml, compress_type=zipfile.ZIP_DEFLATED)

    print(f"Sample EPUB kniha úspěšně vytvořena: {output_path}")

if __name__ == "__main__":
    create_sample_epub()
