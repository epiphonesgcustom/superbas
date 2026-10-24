# Superbase Web

En liten, skrivskyddad webbläsarversion för att titta i databaser från **Superbase 4 för Windows** (`.SBF` = data, `.SBD` = fältdefinitioner).
Öppna en databas, sök och sortera, bläddra som tabell eller formulär och rita enkla diagram.
Ingen byggprocess och inga beroenden. Filerna läses lokalt i webbläsaren – ingenting laddas upp. I Chrome/Edge kan poster även ändras och läggas till (se nedan).

## Användning

Öppna `index.html` via en vanlig statisk webbserver (eller GitHub Pages), klicka **Öppna mapp…** och välj mappen där dina
databaser ligger (du kan också släppa mappen på sidan). Alla `NAMN.SBD` + `NAMN.SBF`-par i mappen och dess undermappar
laddas automatiskt. Webbläsaren kan fråga om du vill ge sidan åtkomst till mappen – filerna läses bara lokalt och laddas aldrig upp.
Fungerar i Chrome, Edge, Firefox och Safari.

Text lagras i den gamla DOS-teckenuppsättningen. Om å/ä/ö ser fel ut, byt **Teckenuppsättning** (standard DOS 850).

### Redigera och lägga till poster (Chrome/Edge)

Öppna mappen med **Öppna mapp…** och klicka **Redigera** (webbläsaren frågar om skrivåtkomst till mappen). Då kan du:

- ändra en post i **Formulär**-vyn och klicka **Uppdatera post**,
- lägga till en post med **Ny post**,
- klicka **Spara till disk** när du är klar (ändrade poster är markerade i tabellen).

Vid sparande kontrolleras att filen inte ändrats på disken sedan du öppnade den, en tidsstämplad säkerhetskopia
(`NAMN.SBF.åååååmmddttmmss.bak`) skrivs, filen skrivs, läses tillbaka och jämförs med det som skulle sparas.
Beräknade fält (`CLC`) räknas om automatiskt. **Ta bort post** lägger postens block i filens lista över lediga block på samma sätt som Superbase gör i de filer jag kunnat studera (datan blir kvar i filen tills blocken återanvänds). Nya poster läggs alltid sist i filen och återanvänder inte lediga block.

> **Viktigt:** indexfilerna (`NAMN.1`, `NAMN.2` …) uppdateras **inte**. Sökningar och sorteringar i själva Superbase kan därför
> missa de nya/ändrade posterna tills du kört omindexering (Reorganize/Index) där. Jag har inte kunnat testa att Superbase 4
> öppnar en ändrad fil – prova först på en kopia av en databas. Redigering fungerar inte i Firefox/Safari (de kan inte skriva till filer). Borttagning är den känsligaste delen – testa den på en kopia först.

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
- Skrivning: bara ändrade/nya poster skrivs om i sina block; nya block läggs sist och filhuvudets antal poster (position 12) och nästa lediga block (position 16) uppdateras. Fältens kodning är densamma som vid läsning (tal skrivs alltid som double, heltal som int16/int32).
- Borttagning: filhuvudet har en länkad lista över lediga block (position 0: nedre 24 bitar = första blocket, position 4 = antal block). Varje block i listan har bit 30 satt och pekar på nästa. Ett ensamt block blir `0x40|nästa`; en post med fortsättningsblock får huvudblock `0xC0` och övriga `0x40`, och sista blocket pekar in i den gamla listan. Mönstret är hämtat från `FIRMOR`/`MUSIKREG` (där listan stämmer exakt med huvudet), men Superbase har inte kunnat testas mot filer som skrivits av den här sidan.
- Indexfiler (`.1`, `.2` …), formulär, program (`.SBP`) och sparade sökningar (`.SBQ`) läses inte.

Testat mot fyra riktiga databaser (antalet poster stämmer med filhuvudena och inga byte blir över). Övriga fälttyper (tid, lång text, bilder) är otestade.

## Utveckling

```
node tests/test.mjs [mapp med .SBF/.SBD-filer]   # tester för läsare och sökning (standard: mappen ovanför)
python -m http.server                             # förhandsgranska
```
