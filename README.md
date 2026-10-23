# Superbase Web

En liten, skrivskyddad webbläsarversion för att titta i databaser från **Superbase 4 för Windows** (`.SBF` = data, `.SBD` = fältdefinitioner).
Öppna en databas, sök och sortera, bläddra som tabell eller formulär och rita enkla diagram.
Ingen byggprocess och inga beroenden. Filerna läses lokalt i webbläsaren – ingenting laddas upp.

## Användning

Öppna `index.html` via en vanlig statisk webbserver (eller GitHub Pages), klicka **Öppna mapp…** och välj mappen där dina
databaser ligger (du kan också släppa mappen på sidan). Alla `NAMN.SBD` + `NAMN.SBF`-par i mappen och dess undermappar
laddas automatiskt. Webbläsaren kan fråga om du vill ge sidan åtkomst till mappen – filerna läses bara lokalt och laddas aldrig upp.
Fungerar i Chrome, Edge, Firefox och Safari.

Text lagras i den gamla DOS-teckenuppsättningen. Om å/ä/ö ser fel ut, byt **Teckenuppsättning** (standard DOS 850).

### Sökspråk

```
PLATS = "Larsson" OCH DATUM >= 2013-01-01
[TYP AV PROVNING] INNEHÅLLER "nya" ELLER INTE (ANTAL_VINER >= 4)
ÅR(DATUM) = 2013 OCH VIN1 LIKT "*Reserva*"
PROVNINGSPRIS.NYVIN1 > 500          -- Superbase-formen FÄLT.FIL fungerar också
```

Operatorer: `= <> < > <= >=`, `LIKT` (`*` `?`), `INNEHÅLLER`, `OCH ELLER INTE`, `+ - * /`.
Funktioner: `STORA SMÅ TRIM LÄNGD VÄNSTER HÖGER MITT VAL STR ABS HELTAL AVRUNDA ÅR MÅNAD DAG`.
De engelska orden (`AND OR NOT LIKE CONTAINS YEAR` …) fungerar också.
Sortering: `DATUM FALLANDE, PLATS`. Ett klick på en kolumnrubrik sorterar också.

### Diagram

Stapel, liggande stapel, linje, cirkel och punktdiagram. Gruppera valfritt fält (datum per år/månad/dag,
tal i intervall, text per värde eller första bokstav) och mät antal / summa / medelvärde / minsta / största
av ett numeriskt fält. **Spara SVG** exporterar diagrammet.

## Publicera på GitHub Pages

1. Lägg innehållet i den här mappen i roten av ett repo (eller i `/docs`).
2. **Settings → Pages → Build and deployment → Deploy from a branch**, välj gren och mapp.
3. Öppna `https://<användare>.github.io/<repo>/`.

> Checka inte in databaser med personuppgifter i ett publikt repo. Läsaren behöver aldrig filerna på servern – besökaren öppnar sina egna filer lokalt.

## Filformat (framtaget genom analys)

- `.SBD` – ren text, ett fält per rad: `NAMN;TYP EGENSKAPER;storlek/format;id;0;`. Typer som förekommit: `TXT`, `NUM`, `NMI` (heltal), `DAT`, `DEL` (avdelare). Egenskaper: `IXD`/`IXU` index, `CLC` beräknat (nästa rad är formeln, värdet lagras), `RDO` skrivskyddat.
- `.SBF` – block med fast storlek (storleken står på position 20 i huvudet). Block 0 är huvudet (antal poster på position 12). Varje block börjar med ett `u32`: bit 31 = levande post, bit 30 = raderad, de 24 lägsta bitarna = nästa block för poster som är längre än ett block. Därefter kommer fälten i definitionsordning: text är NUL-terminerad, tal är `FF`, en storleksbyte (2 = int16, 4 = int32, 8 = double) och värdet, ett ensamt `00` är ett tomt fält. Datum är antal dagar sedan 0001-01-01.
- Indexfiler (`.1`, `.2` …), formulär, program (`.SBP`) och sparade sökningar (`.SBQ`) läses inte.

Testat mot fyra riktiga databaser (antalet poster stämmer med filhuvudena och inga byte blir över). Övriga fälttyper (tid, lång text, bilder) är otestade.

## Utveckling

```
node tests/test.mjs [mapp med .SBF/.SBD-filer]   # tester för läsare och sökning (standard: mappen ovanför)
python -m http.server                             # förhandsgranska
```
