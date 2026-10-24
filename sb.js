/* Superbase 4 file reader + small query language. Works in browsers and Node. */
(function (root) {
  'use strict';

  /* ---------- character sets (Superbase stores DOS/OEM text) ---------- */
  const HIGH = {
    cp850: '\xc7\xfc\xe9\xe2\xe4\xe0\xe5\xe7\xea\xeb\xe8\xef\xee\xec\xc4\xc5\xc9\xe6\xc6\xf4\xf6\xf2\xfb\xf9\xff\xd6\xdc\xf8\xa3\xd8\xd7\u0192\xe1\xed\xf3\xfa\xf1\xd1\xaa\xba\xbf\xae\xac\xbd\xbc\xa1\xab\xbb\u2591\u2592\u2593\u2502\u2524\xc1\xc2\xc0\xa9\u2563\u2551\u2557\u255d\xa2\xa5\u2510\u2514\u2534\u252c\u251c\u2500\u253c\xe3\xc3\u255a\u2554\u2569\u2566\u2560\u2550\u256c\xa4\xf0\xd0\xca\xcb\xc8\u0131\xcd\xce\xcf\u2518\u250c\u2588\u2584\xa6\xcc\u2580\xd3\xdf\xd4\xd2\xf5\xd5\xb5\xfe\xde\xda\xdb\xd9\xfd\xdd\xaf\xb4\xad\xb1\u2017\xbe\xb6\xa7\xf7\xb8\xb0\xa8\xb7\xb9\xb3\xb2\u25a0\xa0',
    cp437: '\xc7\xfc\xe9\xe2\xe4\xe0\xe5\xe7\xea\xeb\xe8\xef\xee\xec\xc4\xc5\xc9\xe6\xc6\xf4\xf6\xf2\xfb\xf9\xff\xd6\xdc\xa2\xa3\xa5\u20a7\u0192\xe1\xed\xf3\xfa\xf1\xd1\xaa\xba\xbf\u2310\xac\xbd\xbc\xa1\xab\xbb\u2591\u2592\u2593\u2502\u2524\u2561\u2562\u2556\u2555\u2563\u2551\u2557\u255d\u255c\u255b\u2510\u2514\u2534\u252c\u251c\u2500\u253c\u255e\u255f\u255a\u2554\u2569\u2566\u2560\u2550\u256c\u2567\u2568\u2564\u2565\u2559\u2558\u2552\u2553\u256b\u256a\u2518\u250c\u2588\u2584\u258c\u2590\u2580\u03b1\xdf\u0393\u03c0\u03a3\u03c3\xb5\u03c4\u03a6\u0398\u03a9\u03b4\u221e\u03c6\u03b5\u2229\u2261\xb1\u2265\u2264\u2320\u2321\xf7\u2248\xb0\u2219\xb7\u221a\u207f\xb2\u25a0\xa0'
  };
  HIGH.latin1 = Array.from({ length: 128 }, (_, i) => String.fromCharCode(128 + i)).join('');
  const CHARSETS = ['cp850', 'cp437', 'latin1'];

  function decode(bytes, start, end, cs) {
    const tbl = HIGH[cs] || HIGH.cp850;
    let s = '';
    for (let i = start; i < end; i++) {
      const b = bytes[i];
      s += b < 128 ? String.fromCharCode(b) : tbl[b - 128];
    }
    return s;
  }

  /* ---------- dates: Superbase stores days since 0001-01-01 (1 = that day) ---------- */
  const EPOCH_ORD = 719163; // ordinal of 1970-01-01
  function ordToISO(n) {
    const d = new Date((n - EPOCH_ORD) * 86400000);
    if (isNaN(d)) return String(n);
    const y = d.getUTCFullYear();
    return String(y).padStart(4, '0') + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  }
  function isoToOrd(s) {
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(s).trim());
    if (!m) return null;
    return Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000) + EPOCH_ORD;
  }
  function ordParts(n) {
    const d = new Date((n - EPOCH_ORD) * 86400000);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
  }

  /* ---------- .SBD: field definitions (plain text, one field per line) ---------- */
  function parseSBD(text) {
    const lines = text.split(/\r?\n/);
    const fields = [];
    const view = [];
    let i = 0;
    for (; i < lines.length; i++) {
      const l = lines[i];
      if (l.indexOf(';') < 0) { if (l.trim() === '' && fields.length) { i++; break; } continue; }
      const p = l.split(';').map(x => x.trim());
      const tf = p[1].split(/\s+/);
      const f = { name: p[0], type: tf[0], flags: tf.slice(1), size: p[2], id: +p[3], calc: false, formula: '' };
      if (f.flags.includes('CLC')) {
        f.calc = true;
        f.formula = (lines[++i] || '').trim();
      }
      f.indexed = f.flags.includes('IXD') || f.flags.includes('IXU');
      f.unique = f.flags.includes('IXU');
      if (f.type === 'TXT') f.len = parseInt(f.size, 10) || 0;
      if (f.type === 'NUM' || f.type === 'NMI') {
        const dot = f.size.indexOf('.');
        f.decimals = f.type === 'NMI' || dot < 0 ? 0 : f.size.length - dot - 1;
      }
      fields.push(f);
    }
    for (; i < lines.length; i++) if (lines[i].trim()) view.push(lines[i].trim());
    return { fields, view };
  }

  /* ---------- .SBF: records stored in fixed-size slots ----------
     header: u32[3] = record count, u32[5] = slot size.
     slot  : u32 flags (bit31 active head, bit30 deleted, low 24 bits = next slot of a long
             record) followed by payload. Fields are concatenated in definition order:
             text = NUL-terminated, number = 0xFF,size,bytes (2=int16, 4=int32, 8=double),
             NUL alone = empty. */
  function readDatabase(sbf, sbd, charset) {
    charset = charset || 'cp850';
    const def = parseSBD(typeof sbd === 'string' ? sbd : decode(sbd, 0, sbd.length, charset));
    const fields = def.fields;
    if (!fields.length) throw new Error('Inga fältdefinitioner hittades i .SBD-filen');
    if (sbf.length < 24) throw new Error('Inte en Superbase-datafil (för liten)');
    const dv = new DataView(sbf.buffer, sbf.byteOffset, sbf.byteLength);
    const slot = dv.getUint32(20, true);
    if (slot < 32 || slot > 65536 || sbf.length < slot) throw new Error('Inte en Superbase-datafil (felaktig blockstorlek)');
    const expected = dv.getUint32(12, true);
    const nslots = Math.floor(sbf.length / slot);
    const records = [];
    let errors = 0;
    for (let i = 1; i < nslots; i++) {
      const w = dv.getUint32(i * slot, true);
      if (((w >>> 24) & 0xC0) !== 0x80) continue;
      const parts = [sbf.subarray(i * slot + 4, (i + 1) * slot)];
      let nxt = w & 0xffffff, guard = 0;
      while (nxt && nxt < nslots && guard++ < 4096) {
        parts.push(sbf.subarray(nxt * slot + 4, (nxt + 1) * slot));
        nxt = dv.getUint32(nxt * slot, true) & 0xffffff;
      }
      let buf = parts[0];
      if (parts.length > 1) {
        buf = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
        let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; }
      }
      try { records.push({ id: i, v: parseRecord(buf, fields, charset) }); }
      catch (e) { errors++; }
    }
    return { fields, view: def.view, records, errors, expected, charset };
  }
  function parseRecord(buf, fields, cs) {
    const out = new Array(fields.length);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let pos = 0;
    for (let k = 0; k < fields.length; k++) {
      const f = fields[k];
      if (pos >= buf.length) { out[k] = f.type === 'TXT' ? '' : null; continue; }
      if (f.type === 'DEL') { out[k] = null; pos++; continue; }
      const c = buf[pos];
      if (c === 0xff && (buf[pos + 1] === 2 || buf[pos + 1] === 4 || buf[pos + 1] === 8)) {
        const sz = buf[pos + 1];
        out[k] = sz === 8 ? dv.getFloat64(pos + 2, true) : sz === 4 ? dv.getInt32(pos + 2, true) : dv.getInt16(pos + 2, true);
        pos += 2 + sz;
      } else {
        let e = pos; while (e < buf.length && buf[e] !== 0) e++;
        const s = decode(buf, pos, e, cs);
        pos = e + 1;
        out[k] = s === '' && f.type !== 'TXT' ? null : s;
      }
    }
    return out;
  }


  /* ---------- writing ----------
     Records are re-encoded the same way they are read. Only changed or new records are touched: they keep
     their slot (and continuation chain), grow into new slots appended at the end of the used area, and the
     header's record count (u32[3]) and next-free-slot (u32[4]) are updated. Index files are NOT updated. */
  const INV = {};
  function encodeChar(ch, cs) {
    const c = ch.charCodeAt(0);
    if (c < 128) return c;
    if (cs === 'latin1') { if (c < 256) return c; throw new Error("Tecknet '" + ch + "' kan inte lagras"); }
    const tbl = HIGH[cs] || HIGH.cp850;
    const m = INV[cs] || (INV[cs] = new Map(Array.from(tbl, (t, i) => [t, 128 + i])));
    if (!m.has(ch)) throw new Error("Tecknet '" + ch + "' kan inte lagras i teckenuppsättningen " + cs);
    return m.get(ch);
  }
  function encodeText(str, cs) {
    const out = [];
    for (const ch of String(str)) {
      if (ch === '\0') continue;
      out.push(encodeChar(ch, cs));
    }
    return out;
  }
  function encodeRecord(fields, v, cs) {
    const out = [];
    fields.forEach((f, k) => {
      const x = v[k];
      if (f.type === 'DEL') { out.push(0); return; }
      if (x === null || x === undefined || (x === '' && f.type !== 'TXT')) { out.push(0); return; }
      if (typeof x === 'string') { out.push(...encodeText(x, cs), 0); return; }
      if (!isFinite(x)) { out.push(0); return; }
      const b = new Uint8Array(10), dv = new DataView(b.buffer);
      if (f.type === 'NUM') { b[0] = 0xff; b[1] = 8; dv.setFloat64(2, x, true); out.push(...b.subarray(0, 10)); }
      else if (f.type === 'NMI' && x >= -32768 && x <= 32767) { b[0] = 0xff; b[1] = 2; dv.setInt16(2, x, true); out.push(...b.subarray(0, 4)); }
      else { b[0] = 0xff; b[1] = 4; dv.setInt32(2, x, true); out.push(...b.subarray(0, 6)); }
    });
    return Uint8Array.from(out);
  }

  /* records: db.records ({id, v, dirty, isNew}). Returns {bytes, newIds: [[record, id]...]}. */
  function applyEdits(sbf, fields, records, cs) {
    const dv0 = new DataView(sbf.buffer, sbf.byteOffset, sbf.byteLength);
    const S = dv0.getUint32(20, true), P = S - 4, n0 = Math.floor(sbf.length / S);
    if (S < 32 || S > 65536) throw new Error('Felaktig blockstorlek');
    const u32 = i => dv0.getUint32(i * S, true);
    let last = 0;
    for (let i = n0 - 1; i >= 1 && !last; i--) {
      if (u32(i) !== 0) { last = i; break; }
      for (let j = i * S + 4; j < (i + 1) * S; j++) if (sbf[j]) { last = i; break; }
    }
    let next = Math.max(dv0.getUint32(16, true), last + 1);
    const writes = new Map(), newIds = [];
    const put = (slot, flag, nextPtr, chunk) => {
      const b = new Uint8Array(S);
      new DataView(b.buffer).setUint32(0, ((flag | nextPtr) >>> 0), true);
      b.set(chunk, 4);
      writes.set(slot, b);
    };
    let added = 0;
    const doomed = [];
    for (const r of records) {
      if (r.deleted) { if (!r.isNew) doomed.push(r); continue; }
      if (!r.isNew && !r.dirty) continue;
      const body = encodeRecord(fields, r.v, cs);
      const need = Math.max(1, Math.ceil(body.length / P));
      let chain = [];
      if (r.isNew) { chain = [next++]; added++; }
      else {
        chain = [r.id];
        let p = u32(r.id) & 0xffffff, guard = 0;
        while (p && p < n0 && guard++ < 4096) { chain.push(p); p = u32(p) & 0xffffff; }
      }
      while (chain.length < need) chain.push(next++);
      for (let k = 0; k < need; k++) {
        put(chain[k], k === 0 ? 0x80000000 : 0, k + 1 < need ? chain[k + 1] : 0, body.subarray(k * P, (k + 1) * P));
      }
      for (let k = need; k < chain.length; k++) put(chain[k], 0, 0, new Uint8Array(0)); // release unused continuation slots
      if (r.isNew) newIds.push([r, chain[0]]);
    }
    /* Deleting: the record's slots are pushed onto the file's free list. Header u32[0] low 24 bits = head
       of the list, u32[1] = number of slots in it; each listed slot has bit 30 set and points to the next
       listed slot. A one-slot record becomes 0x40|next; a longer record keeps its chain: head 0xC0, the
       other slots 0x40, and the last slot continues into the old list (layout seen in real files). */
    let listHead = dv0.getUint32(0, true) & 0xffffff, listSlots = dv0.getUint32(4, true), headFlags = dv0.getUint32(0, true) >>> 24 | 0x40;
    const chainOf = id => {
      const c = [id];
      let p = u32(id) & 0xffffff, guard = 0;
      while (p && p < n0 && guard++ < 4096) { c.push(p); p = u32(p) & 0xffffff; }
      return c;
    };
    const rehead = (slot, word) => {
      const b = sbf.slice(slot * S, (slot + 1) * S);
      new DataView(b.buffer).setUint32(0, word >>> 0, true);
      writes.set(slot, b);
    };
    for (const r of doomed) {
      const c = chainOf(r.id);
      if (c.length === 1) rehead(c[0], 0x40000000 | listHead);
      else {
        headFlags |= 0x80;
        c.forEach((slot, k) => rehead(slot, ((k === 0 ? 0xc0 : 0x40) << 24 | (k + 1 < c.length ? c[k + 1] : listHead)) >>> 0));
      }
      listHead = c[0]; listSlots += c.length;
    }
    const total = Math.max(n0, next);
    const bytes = new Uint8Array(total * S);
    bytes.set(sbf.subarray(0, n0 * S));
    for (const [slot, b] of writes) bytes.set(b, slot * S);
    const dv = new DataView(bytes.buffer);
    if (doomed.length) {
      dv.setUint32(0, ((headFlags << 24) | listHead) >>> 0, true);
      dv.setUint32(4, listSlots, true);
    }
    dv.setUint32(12, dv0.getUint32(12, true) + added - doomed.length, true);
    dv.setUint32(16, next, true);
    return { bytes, newIds };
  }

  /* recompute calculated (CLC) fields of a record's value array in definition order */
  function makeCalc(fields) {
    const fns = [];
    fields.forEach((f, i) => {
      if (!f.calc || !f.formula) return;
      const fn = compileExpr(f.formula, fields, null, true);
      fns.push(v => {
        let x = fn({ v });
        if (typeof x === 'boolean') x = x ? -1 : 0;
        if (typeof x === 'number' && isFinite(x)) {
          if (f.decimals !== undefined) { const p = Math.pow(10, f.decimals); x = Math.round(x * p + (x < 0 ? -1e-9 : 1e-9)) / p; }
          v[i] = x;
        } else v[i] = typeof x === 'string' ? x : (f.type === 'TXT' ? '' : null);
      });
    });
    return v => { for (const fn of fns) fn(v); return v; };
  }

  /* ---------- formatting ---------- */
  function formatValue(f, v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    if (f.type === 'DAT') return ordToISO(v);
    if (f.type === 'NMI') return String(Math.round(v));
    if (f.type === 'NUM') return v.toFixed(Math.min(f.decimals === undefined ? 2 : f.decimals, 6));
    return String(v);
  }

  /* ---------- query language ----------
     OR / AND / NOT, = <> != < > <= >= LIKE CONTAINS, + - * /, functions, field names
     (bare, NAME.FILE, [with spaces] or WITH_SPACES), 'text' or "text", 2013-10-16 */
  const norm = s => String(s).trim().toUpperCase().replace(/\s+/g, '_');

  function tokenize(src, dbName) {
    const toks = [];
    let i = 0;
    const idStart = /[A-Za-z_\u00C0-\uFFFF]/, idPart = /[A-Za-z0-9_\u00C0-\uFFFF$]/;
    while (i < src.length) {
      const c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      const rest = src.slice(i);
      let m;
      if ((m = /^\d{4}-\d{1,2}-\d{1,2}/.exec(rest))) {
        const o = isoToOrd(m[0]);
        if (o === null) throw new Error('Ogiltigt datum ' + m[0]);
        toks.push({ t: 'num', v: o }); i += m[0].length; continue;
      }
      if ((m = /^(\d+(\.\d+)?|\.\d+)/.exec(rest))) {
        toks.push({ t: 'num', v: parseFloat(m[0]) }); i += m[0].length; continue;
      }
      if (c === '"' || c === "'") {
        const j = src.indexOf(c, i + 1);
        if (j < 0) throw new Error('Texten saknar avslutande citattecken');
        toks.push({ t: 'str', v: src.slice(i + 1, j) }); i = j + 1; continue;
      }
      if (c === '[') {
        const j = src.indexOf(']', i);
        if (j < 0) throw new Error('Saknar ]');
        toks.push({ t: 'id', v: src.slice(i + 1, j), quoted: true }); i = j + 1; continue;
      }
      if (idStart.test(c)) {
        let j = i; while (j < src.length && idPart.test(src[j])) j++;
        const name = src.slice(i, j);
        // FIELD.FILE: drop the file qualifier
        if (src[j] === '.' && idStart.test(src[j + 1] || '')) {
          let k = j + 1; while (k < src.length && idPart.test(src[k])) k++;
          if (!dbName || norm(src.slice(j + 1, k)) === norm(dbName)) j = k;
        }
        toks.push({ t: 'id', v: name }); i = j; continue;
      }
      const two = src.substr(i, 2);
      if (two === '<=' || two === '>=' || two === '<>' || two === '!=') { toks.push({ t: 'op', v: two === '!=' ? '<>' : two }); i += 2; continue; }
      if ('=<>+-*/(),'.includes(c)) { toks.push({ t: 'op', v: c }); i++; continue; }
      throw new Error("Oväntat tecken '" + c + "'");
    }
    return toks;
  }

  const ALIAS = { OCH: 'AND', ELLER: 'OR', INTE: 'NOT', LIK: 'LIKE', LIKT: 'LIKE', INNEHÅLLER: 'CONTAINS', INNEHALLER: 'CONTAINS', SANT: 'TRUE', FALSKT: 'FALSE' };
  const canon = n => ALIAS[n] || n;
  const KW = new Set(['AND', 'OR', 'NOT', 'LIKE', 'CONTAINS']);
  const text = s => (s == null ? '' : String(s));
  const FUNCS = {
    UPPER: s => text(s).toUpperCase(),
    LOWER: s => text(s).toLowerCase(),
    TRIM: s => text(s).trim(),
    LEN: s => text(s).length,
    LEFT: (s, n) => text(s).slice(0, n),
    RIGHT: (s, n) => n <= 0 ? '' : text(s).slice(-n),
    MID: (s, a, n) => text(s).substr(a - 1, n === undefined ? 1e9 : n),
    VAL: s => { const n = parseFloat(text(s).replace(',', '.')); return isNaN(n) ? 0 : n; },
    STR: s => text(s),
    ABS: Math.abs, INT: Math.floor,
    ROUND: (x, d) => { const p = Math.pow(10, d || 0); return Math.round(x * p) / p; },
    YEAR: n => n == null ? null : ordParts(n).y,
    MONTH: n => n == null ? null : ordParts(n).m,
    DAY: n => n == null ? null : ordParts(n).d
  };

  const FALIAS = { STORA: 'UPPER', SMÅ: 'LOWER', LÄNGD: 'LEN', VÄNSTER: 'LEFT', HÖGER: 'RIGHT', MITT: 'MID', VAL: 'VAL', HELTAL: 'INT', AVRUNDA: 'ROUND', ÅR: 'YEAR', MÅNAD: 'MONTH', DAG: 'DAY' };
  const truthy = v => v === true || (typeof v === 'number' && v !== 0) || (typeof v === 'string' && v !== '');
  const num = v => v == null || v === '' ? 0 : typeof v === 'number' ? v : (isNaN(parseFloat(v)) ? 0 : parseFloat(v));
  function coerce(a, b) {
    if (typeof a === 'number' && typeof b === 'string') {
      const d = isoToOrd(b);
      if (d !== null) return [a, d];
      if (b.trim() !== '' && !isNaN(Number(b))) return [a, Number(b)];
      return [String(a), b];
    }
    if (typeof b === 'number' && typeof a === 'string') { const r = coerce(b, a); return [r[1], r[0]]; }
    return [a, b];
  }
  function compare(a, b, op) {
    if (a == null && typeof b === 'number') a = 0;
    if (b == null && typeof a === 'number') b = 0;
    if (a == null) a = '';
    if (b == null) b = '';
    [a, b] = coerce(a, b);
    if (typeof a === 'string') { a = a.toLowerCase(); b = String(b).toLowerCase(); }
    switch (op) {
      case '=': return a === b;
      case '<>': return a !== b;
      case '<': return a < b;
      case '>': return a > b;
      case '<=': return a <= b;
      default: return a >= b;
    }
  }
  function like(a, pat) {
    const re = new RegExp('^' + String(pat).replace(/[.+^${}()|\\[\]]/g, '\\$&').replace(/[*%]/g, '.*').replace(/[?_]/g, '.') + '$', 'i');
    return re.test(text(a));
  }
  const contains = (a, b) => text(a).toLowerCase().includes(text(b).toLowerCase());

  function compileExpr(src, fields, dbName, raw) {
    const toks = tokenize(src, dbName);
    const byName = new Map();
    fields.forEach((f, i) => { if (!byName.has(norm(f.name))) byName.set(norm(f.name), i); });
    let p = 0;
    const peek = () => toks[p];
    const isKw = w => peek() && peek().t === 'id' && !peek().quoted && canon(norm(peek().v)) === w;
    const isOp = o => peek() && peek().t === 'op' && peek().v === o;

    function parseOr() {
      let l = parseAnd();
      while (isKw('OR')) { p++; const a = l, b = parseAnd(); l = r => truthy(a(r)) || truthy(b(r)); }
      return l;
    }
    function parseAnd() {
      let l = parseNot();
      while (isKw('AND')) { p++; const a = l, b = parseNot(); l = r => truthy(a(r)) && truthy(b(r)); }
      return l;
    }
    function parseNot() {
      if (isKw('NOT')) { p++; const a = parseNot(); return r => !truthy(a(r)); }
      return parseCmp();
    }
    function parseCmp() {
      const a = parseAdd();
      const t = peek();
      if (!t) return a;
      if (t.t === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(t.v)) {
        p++; const b = parseAdd(); const op = t.v;
        return r => compare(a(r), b(r), op);
      }
      if (isKw('LIKE')) { p++; const b = parseAdd(); return r => like(a(r), b(r)); }
      if (isKw('CONTAINS')) { p++; const b = parseAdd(); return r => contains(a(r), b(r)); }
      if (isKw('NOT') && toks[p + 1] && ['LIKE', 'CONTAINS'].includes(canon(norm(toks[p + 1].v)))) {
        const w = canon(norm(toks[p + 1].v)); p += 2; const b = parseAdd();
        return r => !(w === 'LIKE' ? like(a(r), b(r)) : contains(a(r), b(r)));
      }
      return a;
    }
    function parseAdd() {
      let l = parseMul();
      while (isOp('+') || isOp('-')) {
        const op = toks[p++].v, a = l, b = parseMul();
        l = op === '+'
          ? r => { const x = a(r), y = b(r); return typeof x === 'string' || typeof y === 'string' ? text(x) + text(y) : num(x) + num(y); }
          : r => num(a(r)) - num(b(r));
      }
      return l;
    }
    function parseMul() {
      let l = parseUnary();
      while (isOp('*') || isOp('/')) {
        const op = toks[p++].v, a = l, b = parseUnary();
        l = op === '*' ? r => num(a(r)) * num(b(r)) : r => { const d = num(b(r)); return d === 0 ? null : num(a(r)) / d; };
      }
      return l;
    }
    function parseUnary() {
      if (isOp('-')) { p++; const a = parseUnary(); return r => -num(a(r)); }
      return parsePrimary();
    }
    function parsePrimary() {
      const t = toks[p++];
      if (!t) throw new Error('Uttrycket slutar för tidigt');
      if (t.t === 'num' || t.t === 'str') return () => t.v;
      if (t.t === 'op' && t.v === '(') {
        const e = parseOr();
        if (!isOp(')')) throw new Error('Saknar )');
        p++; return e;
      }
      if (t.t === 'id') {
        const n = t.quoted ? norm(t.v) : canon(norm(t.v));
        if (!t.quoted && isOp('(')) {
          const fn = FUNCS[FALIAS[n.replace(/\$$/, '')] || n.replace(/\$$/, '')];
          if (!fn) throw new Error('Okänd funktion ' + t.v);
          p++;
          const args = [];
          if (!isOp(')')) { do { args.push(parseOr()); } while (isOp(',') && ++p); }
          if (!isOp(')')) throw new Error('Saknar )');
          p++;
          return r => fn.apply(null, args.map(a => a(r)));
        }
        if (!t.quoted && n === 'TRUE') return () => true;
        if (!t.quoted && n === 'FALSE') return () => false;
        if (!t.quoted && KW.has(n)) throw new Error('Oväntat ' + t.v);
        const idx = byName.get(n);
        if (idx === undefined) throw new Error('Okänt fält "' + t.v + '"');
        return r => r.v[idx];
      }
      throw new Error("Oväntat '" + t.v + "'");
    }

    const e = toks.length ? parseOr() : () => true;
    if (p < toks.length) throw new Error("Oväntat '" + toks[p].v + "'");
    return raw ? e : r => truthy(e(r));
  }

  /* ORDER BY "FIELD [ASC|DESC], ..." -> [{idx, desc}] */
  function parseOrder(src, fields, dbName) {
    const out = [];
    if (!src || !src.trim()) return out;
    const byName = new Map();
    fields.forEach((f, i) => { if (!byName.has(norm(f.name))) byName.set(norm(f.name), i); });
    for (let part of src.split(',')) {
      part = part.trim();
      if (!part) continue;
      let desc = false;
      const m = /\s+(ASC|DESC|ASCENDING|DESCENDING|STIGANDE|FALLANDE)$/i.exec(part);
      if (m) { desc = /^(D|F)/i.test(m[1]); part = part.slice(0, m.index).trim(); }
      part = part.replace(/^\[|\]$/g, '');
      let idx = byName.get(norm(part));
      if (idx === undefined && dbName) {
        const q = '.' + norm(dbName);
        if (norm(part).endsWith(q)) idx = byName.get(norm(part).slice(0, -q.length));
      }
      if (idx === undefined) throw new Error('Okänt fält "' + part + '" i sorteringen');
      out.push({ idx, desc });
    }
    return out;
  }
  function sortRecords(recs, order) {
    if (!order.length) return recs;
    const coll = new Intl.Collator('sv', { sensitivity: 'base', numeric: true });
    return recs.slice().sort((x, y) => {
      for (const o of order) {
        const a = x.v[o.idx], b = y.v[o.idx];
        let c;
        const ea = a == null || a === '', eb = b == null || b === '';
        if (ea || eb) c = ea === eb ? 0 : ea ? -1 : 1;
        else if (typeof a === 'number' && typeof b === 'number') c = a - b;
        else c = coll.compare(String(a), String(b));
        if (c) return o.desc ? -c : c;
      }
      return (x.id || 0) - (y.id || 0);
    });
  }

  function query(db, where, orderBy) {
    const test = where && where.trim() ? compileExpr(where, db.fields, db.name) : null;
    const order = parseOrder(orderBy, db.fields, db.name);
    const rows = test ? db.records.filter(test) : db.records.slice();
    return sortRecords(rows, order);
  }

  const api = { applyEdits, encodeRecord, encodeText, makeCalc, CHARSETS, decode, ordToISO, isoToOrd, ordParts, parseSBD, readDatabase, formatValue, compileExpr, parseOrder, sortRecords, query, norm };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SB = api;
})(typeof self !== 'undefined' ? self : this);
