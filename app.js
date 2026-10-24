/* Superbase Web UI. Depends on sb.js (global SB). */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isNum = f => f.type === 'NUM' || f.type === 'NMI';

  const state = { dbs: [], cur: null, tab: 'table', charset: 'cp850', lastInput: 'qWhere' };

  /* ---------- notes ---------- */
  function note(text, err, action) {
    const box = $('#notes');
    const el = document.createElement('div');
    el.className = 'note' + (err ? ' err' : '');
    el.innerHTML = '<span></span><button type="button" aria-label="Stäng">×</button>';
    el.firstChild.textContent = text;
    el.lastChild.onclick = () => el.remove();
    if (action) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'primary'; b.textContent = action.label;
      b.onclick = action.fn;
      el.insertBefore(b, el.lastChild);
    }
    box.appendChild(el);
    while (box.children.length > 4) box.firstChild.remove();
    if (!err && !action) setTimeout(() => el.remove(), 9000);
    return el;
  }

  /* ---------- loading files ---------- */
  async function entriesToFiles(items) {
    const out = [];
    async function walk(e, dir) {
      if (e.isFile) {
        const file = await new Promise((res, rej) => e.file(res, rej));
        out.push({ file, path: dir + file.name });
      } else if (e.isDirectory) {
        const r = e.createReader();
        let batch;
        do {
          batch = await new Promise((res, rej) => r.readEntries(res, rej));
          for (const c of batch) await walk(c, dir + e.name + '/');
        } while (batch.length);
      }
    }
    for (const e of items) await walk(e, '');
    return out;
  }
  async function filesFromDropEntries(dt) {
    const items = [...(dt.items || [])];
    if (items.length && items[0].webkitGetAsEntry) {
      const entries = items.map(i => i.webkitGetAsEntry()).filter(Boolean); // collect before any await
      return entriesToFiles(entries);
    }
    return [...dt.files].map(file => ({ file, path: file.name }));
  }

  // Walk a directory handle (Chromium). Keeps file handles so a database can be saved back later.
  async function walkHandle(dir, path, depth) {
    const out = [], subs = [];
    for await (const [name, h] of dir.entries()) {
      if (h.kind === 'directory') { if (depth < 4) subs.push([name, h]); continue; }
      if (/\.(sbf|sbd)$/i.test(name)) out.push({ file: await h.getFile(), path: path + name, handle: h, dir });
    }
    for (const [name, h] of subs) out.push(...await walkHandle(h, path + name + '/', depth + 1));
    return out;
  }
  async function openFolder() {
    if (window.showDirectoryPicker) {
      try {
        const dir = await window.showDirectoryPicker({ id: 'superbase' });
        return addFiles(await walkHandle(dir, dir.name + '/', 0));
      } catch (e) {
        if (e && e.name === 'AbortError') return;
        note('Mappen kunde inte öppnas direkt (' + (e && e.message) + '). Försöker med vanlig mappväljare – då går det inte att spara ändringar.', true);
      }
    }
    $('#folderInput').click();
  }
  async function filesFromDrop(dt) {
    const items = [...(dt.items || [])];
    if (items.length && items[0].getAsFileSystemHandle) {
      const hs = await Promise.all(items.map(i => i.getAsFileSystemHandle()));
      if (hs.every(h => h && h.kind === 'directory')) {
        const out = [];
        for (const h of hs) out.push(...await walkHandle(h, h.name + '/', 0));
        return out;
      }
    }
    return filesFromDropEntries(dt);
  }

  /* A database is a .SBF + .SBD pair. Every pair found in the chosen folder (and its subfolders) is opened. */
  async function addFiles(list) {
    const groups = new Map();
    for (const item of list) {
      const { path } = item;
      const m = /^(.*?)\.(sbf|sbd)$/i.exec(path);
      if (!m) continue;
      const key = m[1].toUpperCase();
      const g = groups.get(key) || { stem: m[1].split('/').pop() };
      g[m[2].toLowerCase()] = item;
      groups.set(key, g);
    }
    if (!groups.size) { note('Hittade inga .SBD/.SBF-filer i den valda mappen.', true); return; }
    let first = null, opened = 0;
    for (const [key, g] of groups) {
      if (!g.sbf || !g.sbd) { note(`${g.stem}: hoppades över, saknar .${g.sbf ? 'SBD' : 'SBF'}-filen.`, true); continue; }
      const raw = { sbf: new Uint8Array(await g.sbf.file.arrayBuffer()), sbd: new Uint8Array(await g.sbd.file.arrayBuffer()) };
      const old = state.dbs.find(d => d.key === key);
      if (old && dirtyCount(old) && !confirm(`${old.name} har ${dirtyCount(old)} osparade ändringar som går förlorade om databasen öppnas igen. Fortsätta?`)) continue;
      const db = addDb(key, g.stem, raw, true, g.sbf.handle ? { handle: g.sbf.handle, dir: g.sbf.dir, name: g.sbf.file.name } : null);
      if (db) { opened++; first = first || db; }
    }
    if (opened > 1) note(`Öppnade ${opened} databaser.`);
    if (first) select(first);
  }

  function parseDb(db) {
    const d = SB.readDatabase(db.raw.sbf, db.raw.sbd, state.charset);
    db.fields = d.fields; db.view = d.view; db.records = d.records; db.errors = d.errors; db.expected = d.expected;
  }
  function addDb(key, stem, raw, quiet, src) {
    const db = { key, name: stem, raw, src: src || null };
    try { parseDb(db); } catch (e) { note(`${stem}: ${e.message}`, true); return null; }
    const viewSet = new Set(db.view.map(SB.norm));
    const useView = viewSet.size >= 2 && db.fields.some(f => viewSet.has(SB.norm(f.name)));
    db.ui = {
      where: '', order: '', rows: db.records, page: 0, pageSize: 100, formIdx: 0,
      cols: db.fields.map((f, i) => f.type !== 'DEL' && (useView ? viewSet.has(SB.norm(f.name)) : i < 12)),
      chart: defaultChart(db)
    };
    const at = state.dbs.findIndex(d => d.key === key);
    if (at >= 0) state.dbs[at] = db; else state.dbs.push(db);
    if (!quiet || db.errors) note(`Öppnade ${stem}: ${db.records.length} poster, ${db.fields.length} fält` + (db.errors ? ` (${db.errors} oläsliga poster hoppades över)` : '') + '.');
    return db;
  }
  function defaultChart(db) {
    const f = db.fields;
    let x = f.findIndex(a => a.type === 'DAT');
    if (x < 0) x = f.findIndex(a => a.type === 'TXT');
    if (x < 0) x = 0;
    return { type: 'bar', x, group: f[x] && f[x].type === 'DAT' ? 'year' : 'value', measure: 'count', y: Math.max(0, f.findIndex(isNum)), sort: f[x] && f[x].type === 'DAT' ? 'x' : 'val', top: 25 };
  }

  function reparseAll() {
    for (const db of state.dbs) {
      try { parseDb(db); } catch (e) { note(`${db.name}: ${e.message}`, true); }
      runQuery(db, true);
    }
    renderAll();
  }

  /* ---------- querying ---------- */
  function runQuery(db, silent) {
    try {
      db.ui.rows = SB.query(db, db.ui.where, db.ui.order);
      db.ui.page = 0; db.ui.formIdx = Math.min(db.ui.formIdx, Math.max(0, db.ui.rows.length - 1));
      showError('');
      return true;
    } catch (e) {
      if (!silent) showError(e.message);
      return false;
    }
  }
  function showError(msg) {
    const el = $('#qError');
    el.hidden = !msg;
    el.textContent = msg ? 'Sökfel: ' + msg : '';
  }
  const qname = f => (/^[A-Za-z_À-￿][A-Za-z0-9_À-￿]*$/.test(f.name) && !['AND', 'OR', 'NOT', 'LIKE', 'CONTAINS', 'TRUE', 'FALSE', 'OCH', 'ELLER', 'INTE', 'LIK', 'LIKT', 'INNEHÅLLER', 'SANT', 'FALSKT'].includes(f.name.toUpperCase())) ? f.name : '[' + f.name + ']';

  /* ---------- rendering ---------- */
  function select(db) { state.cur = db; renderAll(); }
  function renderAll() {
    const db = state.cur;
    $('#empty').hidden = !!db;
    $('#work').hidden = !db;
    $('#side').hidden = !state.dbs.length;
    renderSide();
    if (!db) return;
    $('#qWhere').value = db.ui.where;
    $('#qOrder').value = db.ui.order;
    showError('');
    renderTab();
  }
  function renderTab() {
    document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === state.tab)));
    for (const t of ['table', 'form', 'chart', 'structure']) $('#tab-' + t).hidden = t !== state.tab;
    const db = state.cur; if (!db) return;
    const n = db.ui.rows.length, tot = db.records.length;
    $('#count').textContent = n === tot ? `${tot.toLocaleString('sv-SE')} poster` : `${n.toLocaleString('sv-SE')} av ${tot.toLocaleString('sv-SE')} poster`;
    $('#btnCsv').disabled = !n;
    const editing = !!(state.edit && db.src), dc = dirtyCount(db);
    $('#btnEdit').textContent = editing ? 'Avsluta redigering' : 'Redigera';
    $('#btnEdit').setAttribute('aria-pressed', String(editing));
    $('#btnEdit').disabled = !db.src;
    $('#btnEdit').title = db.src ? 'Redigera och lägg till poster' : 'Kräver Chrome/Edge och att mappen öppnas med "Öppna mapp…"';
    $('#btnNew').hidden = !editing || state.tab === 'form';
    $('#btnSaveDisk').hidden = !dc;
    $('#btnSaveDisk').textContent = `Spara till disk (${dc})`;
    if (state.tab === 'table') renderTable();
    else if (state.tab === 'form') renderForm();
    else if (state.tab === 'chart') renderChartTab();
    else renderStructure();
  }

  function renderSide() {
    const ul = $('#dbList');
    ul.innerHTML = '';
    for (const db of state.dbs) {
      const li = document.createElement('li');
      li.className = db === state.cur ? 'sel' : '';
      li.innerHTML = `<button class="pick" type="button">${esc(db.name)}<span class="n">${db.records.length}</span></button><button class="x" type="button" aria-label="Stäng ${esc(db.name)}" title="Stäng">×</button>`;
      li.firstChild.onclick = () => select(db);
      li.lastChild.onclick = () => {
        if (dirtyCount(db) && !confirm(`${db.name} har ${dirtyCount(db)} osparade ändringar som går förlorade. Stänga ändå?`)) return;
        state.dbs = state.dbs.filter(d => d !== db);
        select(state.cur === db ? state.dbs[0] || null : state.cur);
      };
      ul.appendChild(li);
    }
    const fl = $('#fieldList');
    fl.innerHTML = '';
    const db = state.cur; if (!db) return;
    db.fields.forEach((f, i) => {
      const li = document.createElement('li');
      if (f.type === 'DEL') li.className = 'del';
      li.innerHTML = (f.type === 'DEL' ? '<span style="width:16px"></span>' : `<label><input type="checkbox" ${db.ui.cols[i] ? 'checked' : ''} aria-label="Visa ${esc(f.name)}"></label>`) +
        `<button type="button" class="nm" title="${esc(f.name)}">${esc(f.name)}</button><span class="ty">${esc(f.type)}</span>`;
      const cb = li.querySelector('input');
      if (cb) cb.onchange = () => { db.ui.cols[i] = cb.checked; if (state.tab === 'table') renderTable(); };
      li.querySelector('.nm').onclick = () => insertAtCursor(qname(f));
      fl.appendChild(li);
    });
  }
  function insertAtCursor(text) {
    const el = $('#' + state.lastInput) || $('#qWhere');
    const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? s;
    const pre = el.value.slice(0, s), post = el.value.slice(e);
    const sp = pre && !/[\s(]$/.test(pre) ? ' ' : '';
    el.value = pre + sp + text + post;
    const pos = (pre + sp + text).length;
    el.focus(); el.setSelectionRange(pos, pos);
  }

  /* table */
  function renderTable() {
    const db = state.cur, ui = db.ui, rows = ui.rows;
    const cols = db.fields.map((f, i) => i).filter(i => ui.cols[i] && db.fields[i].type !== 'DEL');
    const sortF = db.ui.order.split(',')[0] ? parseOrderSafe(db) : null;
    let h = '<thead><tr><th class="num" title="Postnummer">#</th>';
    for (const i of cols) {
      const f = db.fields[i];
      const s = sortF && sortF.idx === i;
      h += `<th data-i="${i}" class="${isNum(f) || f.type === 'DAT' ? 'num' : ''}${f.calc ? ' calc' : ''}" title="${esc(f.name)} (${f.type}${f.calc ? ', beräknat' : ''}) – klicka för att sortera">${esc(f.name)}${s ? `<span class="arr">${sortF.desc ? '▼' : '▲'}</span>` : ''}</th>`;
    }
    h += '</tr></thead><tbody>';
    const a = ui.page * ui.pageSize, b = Math.min(rows.length, a + ui.pageSize);
    for (let r = a; r < b; r++) {
      const rec = rows[r];
      h += `<tr data-r="${r}"${rec.dirty || rec.isNew ? ' class="dirty"' : ''}><td class="rn">${rec.isNew ? 'ny' : rec.id + (rec.dirty ? '*' : '')}</td>`;
      for (const i of cols) {
        const f = db.fields[i];
        h += `<td class="${isNum(f) || f.type === 'DAT' ? 'num' : ''}">${esc(SB.formatValue(f, rec.v[i]))}</td>`;
      }
      h += '</tr>';
    }
    h += '</tbody>';
    const grid = $('#grid');
    grid.innerHTML = rows.length ? h : '';
    if (!rows.length) grid.innerHTML = `<tbody><tr><td class="noresult">Inga poster matchar.</td></tr></tbody>`;
    const pages = Math.max(1, Math.ceil(rows.length / ui.pageSize));
    $('#pager').innerHTML = rows.length ? `<span>Dubbelklicka på en rad för att öppna den i formulärvyn.</span><span style="flex:1"></span>
      <label>Rader <select id="pgSize">${[50, 100, 250, 500].map(n => `<option ${n === ui.pageSize ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <button id="pgPrev" type="button" ${ui.page === 0 ? 'disabled' : ''}>‹</button>
      <span>${(a + 1).toLocaleString('sv-SE')}–${b.toLocaleString('sv-SE')} av ${rows.length.toLocaleString('sv-SE')}</span>
      <button id="pgNext" type="button" ${ui.page >= pages - 1 ? 'disabled' : ''}>›</button>` : '';
    if (rows.length) {
      $('#pgPrev').onclick = () => { ui.page--; renderTable(); };
      $('#pgNext').onclick = () => { ui.page++; renderTable(); };
      $('#pgSize').onchange = e => { ui.pageSize = +e.target.value; ui.page = 0; renderTable(); };
    }
  }
  function parseOrderSafe(db) {
    try { return SB.parseOrder(db.ui.order, db.fields, db.name)[0] || null; } catch (e) { return null; }
  }

  /* form */
  function renderForm() {
    const db = state.cur, ui = db.ui, n = ui.rows.length;
    const editing = !!(state.edit && db.src);
    if (!editing) ui.draft = null;
    const draft = ui.draft;
    $('#editBtns').hidden = !editing;
    $('#fPos').textContent = draft ? 'Ny post (inte sparad än)' : n ? `Post ${ui.formIdx + 1} av ${n.toLocaleString('sv-SE')}  (#${ui.rows[ui.formIdx].isNew ? 'ny' : ui.rows[ui.formIdx].id})` : 'Inga poster';
    for (const id of ['fFirst', 'fPrev']) $('#' + id).disabled = !!draft || ui.formIdx <= 0;
    for (const id of ['fNext', 'fLast']) $('#' + id).disabled = !!draft || ui.formIdx >= n - 1;
    const rec = draft || ui.rows[ui.formIdx];
    let h = '';
    if (rec) db.fields.forEach((f, i) => {
      if (f.type === 'DEL') { h += `<h3>${esc(f.name)}</h3>`; return; }
      const v = SB.formatValue(f, rec.v[i]);
      const ro = f.calc || f.flags.includes('RDO');
      const wide = f.type === 'TXT' && f.len > 70;
      const label = `<span class="lbl">${esc(f.name)}${f.calc ? ' · beräknat' : ''}${editing && f.type === 'TXT' && f.len ? ` · max ${f.len} tecken` : ''}</span>`;
      if (!editing || ro) h += `<div class="fld${wide ? ' wide' : ''}">${label}<div class="val${isNum(f) ? ' num' : ''}">${esc(v) || '&nbsp;'}</div></div>`;
      else {
        const attrs = `data-i="${i}" id="ef-${i}" aria-label="${esc(f.name)}"`;
        const ctl = f.type === 'DAT' ? `<input type="date" ${attrs} value="${esc(v)}">`
          : f.type === 'TXT' && f.len > 70 ? `<textarea rows="3" ${attrs} maxlength="${f.len}">${esc(v)}</textarea>`
          : `<input type="text" ${attrs} value="${esc(v)}"${f.type === 'TXT' && f.len ? ` maxlength="${f.len}"` : ''}${isNum(f) ? ' inputmode="decimal"' : ''}>`;
        h += `<label class="fld${wide ? ' wide' : ''}">${label}${ctl}<span class="ferr" data-err="${i}"></span></label>`;
      }
    });
    $('#formBody').innerHTML = h || '<div class="noresult">Inga poster matchar.</div>';
  }
  function formGo(i) {
    const ui = state.cur.ui;
    ui.draft = null;
    ui.formIdx = Math.max(0, Math.min(ui.rows.length - 1, i));
    renderForm();
  }

  /* ---------- editing ---------- */
  const dirtyCount = db => db.records.reduce((n, r) => n + (r.dirty || r.isNew ? 1 : 0), 0) + (db.deletedRecs ? db.deletedRecs.length : 0);
  let tempId = 1e9;

  // text typed into a form field -> stored value (throws a Swedish message when invalid)
  function parseInput(f, str) {
    if (f.type === 'TXT') {
      const t = str.replace(/\r?\n/g, ' ');
      if (f.len && t.length > f.len) throw new Error(`Max ${f.len} tecken (nu ${t.length}).`);
      SB.encodeText(t, state.charset);
      return t;
    }
    const t = str.trim();
    if (t === '') return null;
    if (f.type === 'DAT') {
      const o = SB.isoToOrd(t);
      if (o === null || SB.ordToISO(o) !== t) throw new Error('Ogiltigt datum (åååå-mm-dd).');
      return o;
    }
    const x = Number(t.replace(',', '.'));
    if (!isFinite(x)) throw new Error('Ogiltigt tal.');
    if (f.type === 'NMI') {
      if (!Number.isInteger(x)) throw new Error('Heltal krävs.');
      if (x < -2147483648 || x > 2147483647) throw new Error('Talet är för stort.');
      return x;
    }
    const d = f.decimals === undefined ? 2 : f.decimals, p = Math.pow(10, d);
    return Math.round(x * p + (x < 0 ? -1e-9 : 1e-9)) / p;
  }
  function getCalc(db) {
    if (db.calc === undefined) {
      try { db.calc = SB.makeCalc(db.fields); } catch (e) { db.calc = null; note('Kunde inte tolka formlerna för beräknade fält (' + e.message + '). De räknas inte om.', true); }
    }
    return db.calc;
  }
  function applyForm() {
    const db = state.cur, ui = db.ui;
    const base = ui.draft || ui.rows[ui.formIdx];
    if (!base) return;
    const v = base.v.slice();
    let bad = 0;
    document.querySelectorAll('#formBody [data-err]').forEach(e => { e.textContent = ''; });
    document.querySelectorAll('#formBody [data-i]').forEach(el => {
      const i = +el.dataset.i;
      try { v[i] = parseInput(db.fields[i], el.value); }
      catch (e) { bad++; $(`[data-err="${i}"]`).textContent = e.message; }
    });
    if (bad) { note(`${bad} fält har fel – rätta dem och försök igen.`, true); return; }
    const calc = getCalc(db);
    if (calc) calc(v);
    if (ui.draft) {
      const rec = { id: ++tempId, v, isNew: true };
      db.records.push(rec);
      ui.draft = null;
      runQuery(db, true);
      const at = ui.rows.indexOf(rec);
      if (at >= 0) ui.formIdx = at; else note('Posten är tillagd men matchar inte den aktuella sökningen. Klicka Rensa för att se den.');
    } else if (JSON.stringify(v) !== JSON.stringify(base.v)) {
      base.v = v; base.dirty = true;
      runQuery(db, true);
      const at = ui.rows.indexOf(base);
      if (at >= 0) ui.formIdx = at;
    }
    renderTab();
  }
  function deleteRecord() {
    const db = state.cur, ui = db.ui, rec = ui.rows[ui.formIdx];
    if (!rec || ui.draft) return;
    if (!confirm('Ta bort den här posten? Den försvinner från databasen när du sparar till disk (en säkerhetskopia av filen skapas först).')) return;
    db.records.splice(db.records.indexOf(rec), 1);
    if (!rec.isNew) { rec.deleted = true; (db.deletedRecs || (db.deletedRecs = [])).push(rec); }
    runQuery(db, true);
    ui.formIdx = Math.min(ui.formIdx, Math.max(0, ui.rows.length - 1));
    renderTab();
  }
  function newRecord() {
    const db = state.cur;
    db.ui.draft = { v: db.fields.map(f => f.type === 'TXT' ? '' : null) };
    state.tab = 'form';
    renderTab();
  }
  async function toggleEdit() {
    const db = state.cur;
    if (!db) return;
    if (state.edit) { state.edit = false; renderTab(); return; }
    if (!db.src) { note('Redigering kräver Chrome eller Edge och att mappen öppnas med "Öppna mapp…" (inte via vanlig filväljare).', true); return; }
    try {
      if ((await db.src.handle.requestPermission({ mode: 'readwrite' })) !== 'granted') { note('Skrivåtkomst nekades.', true); return; }
    } catch (e) { note('Kunde inte begära skrivåtkomst: ' + e.message, true); return; }
    state.edit = true;
    renderTab();
  }
  const bytesEqual = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
  const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const readBytes = async h => new Uint8Array(await (await h.getFile()).arrayBuffer());

  async function saveToDisk() {
    const db = state.cur, n = db && dirtyCount(db);
    if (!db || !n || !db.src) return;
    const btn = $('#btnSaveDisk');
    btn.disabled = true;
    try {
      if ((await db.src.handle.requestPermission({ mode: 'readwrite' })) !== 'granted') throw new Error('Skrivåtkomst nekades.');
      const cur = await readBytes(db.src.handle);
      if (!bytesEqual(cur, db.raw.sbf)) throw new Error('Filen har ändrats på disken sedan du öppnade den (till exempel av Superbase). Inget sparades – öppna mappen igen.');
      const gone = db.deletedRecs || [];
      const { bytes, newIds } = SB.applyEdits(cur, db.fields, db.records.concat(gone), state.charset);
      if (!db.backupName) {
        const name = `${db.src.name}.${stamp()}.bak`;
        const bw = await (await db.src.dir.getFileHandle(name, { create: true })).createWritable();
        await bw.write(cur); await bw.close();
        db.backupName = name;
      }
      const w = await db.src.handle.createWritable();
      await w.write(bytes); await w.close();
      const back = await readBytes(db.src.handle);
      if (!bytesEqual(back, bytes)) throw new Error(`Kontrollen efter skrivning misslyckades. Återställ ${db.src.name} från säkerhetskopian ${db.backupName}.`);
      const ids = new Map(newIds);
      const check = SB.readDatabase(back, db.raw.sbd, state.charset);
      const byId = new Map(check.records.map(r => [r.id, r]));
      const mismatch = db.records.some(r => { const c = byId.get(ids.has(r) ? ids.get(r) : r.id); return !c || JSON.stringify(c.v) !== JSON.stringify(r.v); });
      const goneIds = new Set(gone.map(r => r.id));
      if (mismatch || check.records.length !== db.records.length || check.records.some(r => goneIds.has(r.id))) throw new Error(`Kontrollläsningen stämde inte med det som skulle sparas. Återställ ${db.src.name} från säkerhetskopian ${db.backupName}.`);
      for (const r of db.records) { if (ids.has(r)) r.id = ids.get(r); r.dirty = false; r.isNew = false; }
      db.deletedRecs = [];
      db.raw = { sbf: back, sbd: db.raw.sbd };
      runQuery(db, true);
      note(`Sparade ${n} ändringar i ${db.src.name}. Säkerhetskopia: ${db.backupName}. Indexfilerna (.1, .2 …) är inte uppdaterade – kör omindexering i Superbase innan du söker där.`);
    } catch (e) {
      note('Sparandet misslyckades: ' + e.message, true);
    }
    btn.disabled = false;
    renderTab();
  }

  /* structure */
  function renderStructure() {
    const db = state.cur;
    const live = db.records.length;
    $('#structInfo').innerHTML = `<b>${esc(db.name)}</b> · ${live.toLocaleString('sv-SE')} poster · ${db.fields.length} fält · text avkodad som ${esc(state.charset)}` +
      (db.expected !== live ? ` · <span style="color:var(--danger)">huvudet anger ${db.expected} poster</span>` : '') + (db.errors ? ` · ${db.errors} oläsliga` : '');
    let h = '<thead><tr><th>#</th><th>Namn</th><th>Typ</th><th>Storlek / format</th><th>Egenskaper</th><th>Formel</th></tr></thead><tbody>';
    const names = { TXT: 'Text', NUM: 'Tal', NMI: 'Heltal', DAT: 'Datum', DEL: 'Avdelare' };
    db.fields.forEach((f, i) => {
      const fl = [];
      if (f.indexed) fl.push(f.unique ? 'unikt index' : 'index');
      if (f.calc) fl.push('beräknat');
      if (f.flags.includes('RDO')) fl.push('skrivskyddat');
      h += `<tr><td>${i + 1}</td><td>${esc(f.name)}</td><td>${esc(f.type)} <span class="muted">${names[f.type] || ''}</span></td><td>${esc(f.size)}</td><td>${fl.map(x => `<span class="badge">${x}</span>`).join('')}</td><td style="font-family:ui-monospace,Consolas,monospace;font-size:12px">${esc(f.formula)}</td></tr>`;
    });
    $('#structTable').innerHTML = h + '</tbody>';
  }

  /* ---------- CSV ---------- */
  function exportCsv() {
    const db = state.cur;
    const cols = db.fields.map((f, i) => i).filter(i => db.ui.cols[i] && db.fields[i].type !== 'DEL');
    const q = s => /[",\r\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    const lines = [cols.map(i => q(db.fields[i].name)).join(',')];
    for (const r of db.ui.rows) lines.push(cols.map(i => q(SB.formatValue(db.fields[i], r.v[i]))).join(','));
    download(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), db.name + '.csv');
  }
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  /* ---------- charts ---------- */
  const GROUPS = {
    DAT: [['year', 'År'], ['month', 'Månad'], ['day', 'Dag']],
    NUM: [['value', 'Exakt värde'], ['bucket', '10 intervall']],
    NMI: [['value', 'Exakt värde'], ['bucket', '10 intervall']],
    TXT: [['value', 'Hela texten'], ['first', 'Första bokstaven']]
  };
  const fmtN = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 2 });
  const trunc = (s, n) => s.length > n ? s.slice(0, n - 1) + '…' : s;
  const MEASURE_LABEL = { count: 'Poster', sum: 'Summa', avg: 'Medelvärde', min: 'Minsta', max: 'Största' };

  function fillSelect(sel, opts, value) {
    sel.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
    if (opts.some(o => String(o[0]) === String(value))) sel.value = value;
  }
  function renderChartTab() {
    const db = state.cur, c = db.ui.chart, f = db.fields;
    const scatter = c.type === 'scatter';
    const xs = f.map((x, i) => [i, x.name, x]).filter(([, , x]) => x.type !== 'DEL' && (!scatter || isNum(x) || x.type === 'DAT'));
    if (!xs.length) { $('#chartBox').innerHTML = ''; $('#chartMsg').textContent = 'Inga lämpliga fält för den här diagramtypen.'; return; }
    if (!xs.some(([i]) => i === c.x)) c.x = xs[0][0];
    $('#cType').value = c.type;
    fillSelect($('#cX'), xs.map(([i, n]) => [i, n]), c.x);
    const gopts = GROUPS[f[c.x].type] || GROUPS.TXT;
    if (!gopts.some(o => o[0] === c.group)) c.group = gopts[0][0];
    fillSelect($('#cGroup'), gopts, c.group);
    $('#cMeasure').value = c.measure;
    const nums = f.map((x, i) => [i, x.name, x]).filter(([, , x]) => isNum(x));
    if (!nums.some(([i]) => i === c.y)) c.y = nums.length ? nums[0][0] : 0;
    fillSelect($('#cY'), nums.map(([i, n]) => [i, n]), c.y);
    $('#cSort').value = c.sort;
    $('#cTop').value = c.top;
    $('#cGroupWrap').hidden = scatter;
    $('#cMeasureWrap').hidden = scatter;
    $('#cYWrap').hidden = !(scatter || c.measure !== 'count');
    $('#cYLabel').textContent = scatter ? 'Y-axel' : 'Fält';
    $('#cSortWrap').hidden = c.type === 'line' || scatter || c.type === 'pie';
    $('#cTopWrap').hidden = c.type === 'line' || scatter || f[c.x].type === 'DAT';
    drawChart();
  }

  function palette() {
    const cs = getComputedStyle(document.documentElement);
    const g = n => cs.getPropertyValue(n).trim();
    return { series: [1, 2, 3, 4, 5, 6, 7, 8].map(i => g('--c' + i)), ink: g('--ink'), muted: g('--muted'), line: g('--line'), bg: g('--panel') };
  }
  function niceTicks(lo, hi, want) {
    if (lo === hi) { hi = lo + 1; }
    const raw = (hi - lo) / want, pow = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / pow;
    const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * pow;
    const a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step, t = [];
    for (let v = a; v <= b + step / 2; v += step) t.push(+v.toPrecision(12));
    return t;
  }

  function aggregate(db, rows, c) {
    const fx = db.fields[c.x], gx = c.group;
    let bucketFn = null;
    if (isNum(fx) && gx === 'bucket') {
      let lo = Infinity, hi = -Infinity;
      for (const r of rows) { const v = r.v[c.x]; if (typeof v === 'number') { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
      const w = (hi - lo) / 10 || 1;
      bucketFn = v => { const k = Math.min(9, Math.floor((v - lo) / w)); return [k, `${fmtN.format(lo + k * w)}–${fmtN.format(lo + (k + 1) * w)}`]; };
    }
    const map = new Map();
    for (const r of rows) {
      const v = r.v[c.x];
      let key, label;
      if (v == null || v === '') { key = Infinity; label = '(tom)'; }
      else if (fx.type === 'DAT' && typeof v === 'number') {
        const p = SB.ordParts(v);
        if (gx === 'year') { key = p.y; label = String(p.y); }
        else if (gx === 'month') { key = p.y * 100 + p.m; label = p.y + '-' + String(p.m).padStart(2, '0'); }
        else { key = v; label = SB.ordToISO(v); }
      } else if (typeof v === 'number') {
        if (bucketFn) [key, label] = bucketFn(v); else { key = v; label = SB.formatValue(fx, v); }
      } else {
        const s = gx === 'first' ? v.trim().charAt(0).toUpperCase() : v.trim();
        key = s.toLowerCase(); label = s || '(tom)'; if (!s) key = Infinity;
      }
      let e = map.get(key);
      if (!e) { e = { key, label, n: 0, cnt: 0, sum: 0, min: Infinity, max: -Infinity }; map.set(key, e); }
      e.n++;
      if (c.measure !== 'count') {
        const y = r.v[c.y];
        if (typeof y === 'number') { e.cnt++; e.sum += y; e.min = Math.min(e.min, y); e.max = Math.max(e.max, y); }
      }
    }
    const out = [...map.values()].map(e => {
      let val;
      switch (c.measure) {
        case 'count': val = e.n; break;
        case 'sum': val = e.sum; break;
        case 'avg': val = e.cnt ? e.sum / e.cnt : 0; break;
        case 'min': val = e.cnt ? e.min : 0; break;
        default: val = e.cnt ? e.max : 0;
      }
      return { label: e.label, key: e.key, val };
    });
    const cmpKey = (a, b) => {
      if (a.key === b.key) return 0;
      if (a.key === Infinity) return 1; if (b.key === Infinity) return -1;
      return typeof a.key === 'number' && typeof b.key === 'number' ? a.key - b.key : String(a.key).localeCompare(String(b.key), 'sv', { numeric: true });
    };
    out.sort(cmpKey);
    return { entries: out, cmpKey };
  }

  let lastSvg = '';
  function drawChart() {
    const db = state.cur, c = db.ui.chart, rows = db.ui.rows, P = palette();
    const msg = $('#chartMsg'), box = $('#chartBox');
    msg.textContent = '';
    if (!rows.length) { box.innerHTML = '<div class="noresult">Inga poster att rita.</div>'; lastSvg = ''; return; }
    let svg;
    const fx = db.fields[c.x];
    if (c.type === 'scatter') {
      const pts = [];
      for (const r of rows) { const x = r.v[c.x], y = r.v[c.y]; if (typeof x === 'number' && typeof y === 'number') pts.push([x, y, r]); }
      if (!pts.length) { box.innerHTML = '<div class="noresult">Inga poster har numeriska värden i båda fälten.</div>'; lastSvg = ''; return; }
      svg = scatterSvg(pts, fx, db.fields[c.y], P);
      msg.textContent = `${pts.length.toLocaleString('sv-SE')} punkter`;
    } else {
      const { entries, cmpKey } = aggregate(db, rows, c);
      let data = entries;
      const sortVal = c.sort === 'val' || c.type === 'pie';
      if ((c.type === 'bar' || c.type === 'hbar' || c.type === 'pie') && fx.type !== 'DAT' && c.top > 0 && data.length > c.top) {
        const byVal = data.slice().sort((a, b) => b.val - a.val);
        const keep = byVal.slice(0, c.top), rest = byVal.slice(c.top);
        if (c.type === 'pie') keep.push({ label: `Övrigt (${rest.length})`, key: -Infinity, val: rest.reduce((s, e) => s + e.val, 0) });
        data = keep;
        msg.textContent = `Visar de ${c.top} största av ${entries.length} grupper.`;
      }
      if (c.type !== 'line') data = sortVal ? data.slice().sort((a, b) => b.val - a.val) : data.slice().sort(cmpKey);
      const yName = c.measure === 'count' ? 'Poster' : `${MEASURE_LABEL[c.measure]} av ${db.fields[c.y].name}`;
      if (c.type === 'pie') {
        const pos = data.filter(d => d.val > 0);
        if (!pos.length) { box.innerHTML = '<div class="noresult">Cirkeldiagram kräver positiva värden.</div>'; lastSvg = ''; return; }
        svg = pieSvg(pos, yName, fx.name, P);
      } else if (c.type === 'hbar') svg = hbarSvg(data, yName, fx.name, P);
      else if (c.type === 'line') svg = lineSvg(data, yName, fx.name, P);
      else svg = barSvg(data, yName, fx.name, P);
    }
    lastSvg = svg;
    box.innerHTML = svg;
  }

  const SVG_HEAD = (W, H, P) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif" font-size="12" role="img"><rect width="${W}" height="${H}" fill="${P.bg}"/>`;
  const axisTitle = (x, y, text, P, rot) => `<text x="${x}" y="${y}" text-anchor="middle" fill="${P.muted}" font-size="12"${rot ? ` transform="rotate(-90 ${x} ${y})"` : ''}>${esc(text)}</text>`;

  function yScale(vals, top, bottom) {
    let lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
    if (hi === lo) hi = lo + 1;
    const ticks = niceTicks(lo, hi, 6);
    lo = ticks[0]; hi = ticks[ticks.length - 1];
    return { ticks, y: v => bottom - (v - lo) / (hi - lo) * (bottom - top) };
  }
  function grid(s, W, m, P) {
    return s.ticks.map(t => `<line x1="${m.l}" x2="${W - m.r}" y1="${s.y(t)}" y2="${s.y(t)}" stroke="${P.line}"${t === 0 ? ' stroke-width="1.5"' : ''}/><text x="${m.l - 8}" y="${s.y(t) + 4}" text-anchor="end" fill="${P.muted}">${fmtN.format(t)}</text>`).join('');
  }

  function barSvg(d, yName, xName, P) {
    const W = 900, H = 440, n = d.length, maxLen = Math.max(...d.map(e => Math.min(24, e.label.length)));
    const rot = n > 10 || maxLen > 9;
    const m = { l: 68, r: 20, t: 20, b: rot ? Math.min(150, 36 + maxLen * 5.4) + 18 : 56 };
    const s = yScale(d.map(e => e.val), m.t, H - m.b);
    const band = (W - m.l - m.r) / n, bw = Math.min(60, band * 0.72);
    let g = SVG_HEAD(W, H, P) + grid(s, W, m, P);
    d.forEach((e, i) => {
      const cx = m.l + band * (i + 0.5), y0 = s.y(0), y1 = s.y(e.val);
      g += `<g><title>${esc(e.label)}: ${fmtN.format(e.val)}</title><rect x="${cx - bw / 2}" y="${Math.min(y0, y1)}" width="${bw}" height="${Math.max(1, Math.abs(y1 - y0))}" rx="2" fill="${P.series[0]}"/></g>`;
      if (n <= 20) g += `<text x="${cx}" y="${(e.val >= 0 ? y1 - 5 : y1 + 13)}" text-anchor="middle" fill="${P.ink}" font-size="11">${fmtN.format(e.val)}</text>`;
      const ly = H - m.b + 16;
      g += rot ? `<text x="${cx}" y="${ly}" text-anchor="end" fill="${P.muted}" transform="rotate(-40 ${cx} ${ly})">${esc(trunc(e.label, 24))}</text>`
        : `<text x="${cx}" y="${ly}" text-anchor="middle" fill="${P.muted}">${esc(e.label)}</text>`;
    });
    return g + axisTitle(16, (m.t + H - m.b) / 2, yName, P, true) + axisTitle((m.l + W - m.r) / 2, H - 6, xName, P) + '</svg>';
  }

  function hbarSvg(d, yName, xName, P) {
    const rowH = 26, n = d.length, maxLen = Math.max(...d.map(e => Math.min(28, e.label.length)));
    const m = { l: Math.min(240, 24 + maxLen * 6.4), r: 56, t: 14, b: 48 };
    const W = 900, H = m.t + m.b + n * rowH;
    const lo = Math.min(0, ...d.map(e => e.val)), hiRaw = Math.max(0, ...d.map(e => e.val));
    const ticks = niceTicks(lo, hiRaw === lo ? lo + 1 : hiRaw, 6), a = ticks[0], b = ticks[ticks.length - 1];
    const x = v => m.l + (v - a) / (b - a) * (W - m.l - m.r);
    let g = SVG_HEAD(W, H, P);
    for (const t of ticks) g += `<line x1="${x(t)}" x2="${x(t)}" y1="${m.t}" y2="${H - m.b}" stroke="${P.line}"/><text x="${x(t)}" y="${H - m.b + 16}" text-anchor="middle" fill="${P.muted}">${fmtN.format(t)}</text>`;
    d.forEach((e, i) => {
      const y = m.t + i * rowH, x0 = x(0), x1 = x(e.val);
      g += `<g><title>${esc(e.label)}: ${fmtN.format(e.val)}</title><rect x="${Math.min(x0, x1)}" y="${y + 4}" width="${Math.max(1, Math.abs(x1 - x0))}" height="${rowH - 8}" rx="2" fill="${P.series[0]}"/></g>`;
      g += `<text x="${m.l - 8}" y="${y + rowH / 2 + 4}" text-anchor="end" fill="${P.ink}">${esc(trunc(e.label, 30))}</text>`;
      g += `<text x="${Math.max(x0, x1) + 5}" y="${y + rowH / 2 + 4}" fill="${P.muted}" font-size="11">${fmtN.format(e.val)}</text>`;
    });
    return g + axisTitle((m.l + W - m.r) / 2, H - 6, yName, P) + axisTitle(14, (m.t + H - m.b) / 2, xName, P, true) + '</svg>';
  }

  function lineSvg(d, yName, xName, P) {
    const W = 900, H = 440, n = d.length, maxLen = Math.max(...d.map(e => Math.min(24, e.label.length)));
    const rot = maxLen > 6;
    const m = { l: 68, r: 24, t: 20, b: rot ? Math.min(120, 36 + maxLen * 5) + 18 : 56 };
    const s = yScale(d.map(e => e.val), m.t, H - m.b);
    const xAt = i => n === 1 ? (m.l + W - m.r) / 2 : m.l + 12 + (W - m.l - m.r - 24) * i / (n - 1);
    const every = Math.max(1, Math.ceil(n / 16));
    let g = SVG_HEAD(W, H, P) + grid(s, W, m, P);
    g += `<polyline fill="none" stroke="${P.series[0]}" stroke-width="2.5" stroke-linejoin="round" points="${d.map((e, i) => xAt(i) + ',' + s.y(e.val)).join(' ')}"/>`;
    d.forEach((e, i) => {
      if (n <= 80) g += `<circle cx="${xAt(i)}" cy="${s.y(e.val)}" r="3.5" fill="${P.series[0]}"><title>${esc(e.label)}: ${fmtN.format(e.val)}</title></circle>`;
      if (i % every === 0) {
        const ly = H - m.b + 16;
        g += rot ? `<text x="${xAt(i)}" y="${ly}" text-anchor="end" fill="${P.muted}" transform="rotate(-40 ${xAt(i)} ${ly})">${esc(trunc(e.label, 24))}</text>`
          : `<text x="${xAt(i)}" y="${ly}" text-anchor="middle" fill="${P.muted}">${esc(e.label)}</text>`;
      }
    });
    return g + axisTitle(16, (m.t + H - m.b) / 2, yName, P, true) + axisTitle((m.l + W - m.r) / 2, H - 6, xName, P) + '</svg>';
  }

  function pieSvg(d, yName, xName, P) {
    const W = 900, H = 440, cx = 230, cy = 220, R = 180;
    const total = d.reduce((s, e) => s + e.val, 0);
    let g = SVG_HEAD(W, H, P), ang = -Math.PI / 2;
    const col = i => P.series[i % P.series.length];
    d.forEach((e, i) => {
      const a = e.val / total * Math.PI * 2;
      const title = `<title>${esc(e.label)}: ${fmtN.format(e.val)} (${(e.val / total * 100).toFixed(1)}%)</title>`;
      if (d.length === 1) g += `<circle cx="${cx}" cy="${cy}" r="${R}" fill="${col(i)}">${title}</circle>`;
      else {
        const x0 = cx + R * Math.cos(ang), y0 = cy + R * Math.sin(ang), x1 = cx + R * Math.cos(ang + a), y1 = cy + R * Math.sin(ang + a);
        g += `<path d="M${cx} ${cy} L${x0} ${y0} A${R} ${R} 0 ${a > Math.PI ? 1 : 0} 1 ${x1} ${y1} Z" fill="${col(i)}" stroke="${P.bg}" stroke-width="2">${title}</path>`;
      }
      ang += a;
    });
    const rowH = Math.min(24, (H - 40) / d.length);
    d.forEach((e, i) => {
      const y = 28 + i * rowH;
      g += `<rect x="470" y="${y - 10}" width="12" height="12" rx="2" fill="${col(i)}"/><text x="490" y="${y}" fill="${P.ink}">${esc(trunc(e.label, 40))}</text><text x="${W - 20}" y="${y}" text-anchor="end" fill="${P.muted}">${fmtN.format(e.val)} · ${(e.val / total * 100).toFixed(1)}%</text>`;
    });
    return g + axisTitle(470 + 190, H - 8, `${yName} per ${xName}`, P) + '</svg>';
  }

  function scatterSvg(pts, fx, fy, P) {
    const W = 900, H = 440, m = { l: 68, r: 24, t: 20, b: 52 };
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const tx = niceTicks(Math.min(...xs), Math.max(...xs), 8), ty = niceTicks(Math.min(...ys), Math.max(...ys), 6);
    const x = v => m.l + (v - tx[0]) / (tx[tx.length - 1] - tx[0]) * (W - m.l - m.r);
    const y = v => H - m.b - (v - ty[0]) / (ty[ty.length - 1] - ty[0]) * (H - m.t - m.b);
    let g = SVG_HEAD(W, H, P);
    for (const t of ty) g += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}" stroke="${P.line}"/><text x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end" fill="${P.muted}">${fmtN.format(t)}</text>`;
    for (const t of tx) g += `<line x1="${x(t)}" x2="${x(t)}" y1="${m.t}" y2="${H - m.b}" stroke="${P.line}"/><text x="${x(t)}" y="${H - m.b + 16}" text-anchor="middle" fill="${P.muted}">${fx.type === 'DAT' ? SB.ordToISO(Math.round(t)).slice(0, 7) : fmtN.format(t)}</text>`;
    for (const [px, py] of pts) g += `<circle cx="${x(px)}" cy="${y(py)}" r="4" fill="${P.series[0]}" fill-opacity=".55"><title>${esc(fx.name)} ${esc(SB.formatValue(fx, px))}, ${esc(fy.name)} ${fmtN.format(py)}</title></circle>`;
    return g + axisTitle((m.l + W - m.r) / 2, H - 8, fx.name, P) + axisTitle(16, (m.t + H - m.b) / 2, fy.name, P, true) + '</svg>';
  }

  /* ---------- events ---------- */
  function chartChanged() {
    const c = state.cur.ui.chart;
    const prevType = c.type;
    c.type = $('#cType').value;
    c.x = +$('#cX').value || 0;
    c.group = $('#cGroup').value || c.group;
    c.measure = $('#cMeasure').value;
    c.y = +$('#cY').value || 0;
    c.sort = $('#cSort').value;
    c.top = Math.max(0, parseInt($('#cTop').value, 10) || 0);
    if (prevType !== c.type && c.type === 'line') c.sort = 'x';
    renderChartTab();
  }

  function init() {
    $('#btnOpen').onclick = openFolder; $('#btnOpen2').onclick = openFolder;
    $('#folderInput').onchange = e => { addFiles([...e.target.files].map(file => ({ file, path: file.webkitRelativePath || file.name }))); e.target.value = ''; };
    
    $('#charset').onchange = e => {
      if (state.dbs.some(dirtyCount)) { e.target.value = state.charset; note('Spara eller avsluta ändringarna innan du byter teckenuppsättning.', true); return; }
      state.charset = e.target.value; reparseAll();
    };
    $('#btnEdit').onclick = toggleEdit;
    $('#btnNew').onclick = newRecord; $('#fNew').onclick = newRecord;
    $('#fApply').onclick = applyForm;
    $('#fDelete').onclick = deleteRecord;
    $('#fRevert').onclick = () => { const ui = state.cur.ui; if (ui.draft) { ui.draft = null; renderTab(); } else renderForm(); };
    $('#btnSaveDisk').onclick = saveToDisk;
    window.addEventListener('beforeunload', e => { if (state.dbs.some(dirtyCount)) { e.preventDefault(); e.returnValue = ''; } });

    let depth = 0;
    window.addEventListener('dragenter', e => { e.preventDefault(); depth++; document.body.classList.add('dragging'); });
    window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; document.body.classList.remove('dragging'); } });
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', async e => {
      e.preventDefault(); depth = 0; document.body.classList.remove('dragging');
      addFiles(await filesFromDrop(e.dataTransfer));
    });

    $('#queryForm').onsubmit = e => {
      e.preventDefault();
      const db = state.cur; if (!db) return;
      const prev = [db.ui.where, db.ui.order];
      db.ui.where = $('#qWhere').value; db.ui.order = $('#qOrder').value;
      if (!runQuery(db)) { [db.ui.where, db.ui.order] = prev; return; }
      renderTab();
    };
    $('#qClear').onclick = () => {
      const db = state.cur; db.ui.where = ''; db.ui.order = '';
      $('#qWhere').value = ''; $('#qOrder').value = '';
      runQuery(db); renderTab();
    };
    for (const id of ['qWhere', 'qOrder']) $('#' + id).addEventListener('focus', () => { state.lastInput = id; });

    document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => { state.tab = b.dataset.tab; renderTab(); });
    document.querySelectorAll('[data-cols]').forEach(b => b.onclick = () => {
      const db = state.cur; if (!db) return;
      const how = b.dataset.cols;
      const viewSet = new Set(db.view.map(SB.norm));
      db.ui.cols = db.fields.map((f, i) => f.type !== 'DEL' && (how === 'all' ? true : how === 'none' ? false : (viewSet.size >= 2 ? viewSet.has(SB.norm(f.name)) : i < 12)));
      renderSide(); if (state.tab === 'table') renderTable();
    });

    $('#grid').addEventListener('click', e => {
      const th = e.target.closest('th[data-i]');
      if (!th) return;
      const db = state.cur, f = db.fields[+th.dataset.i];
      const cur = parseOrderSafe(db);
      let next = qname(f);
      if (cur && cur.idx === +th.dataset.i) next = cur.desc ? '' : next + ' FALLANDE';
      db.ui.order = next; $('#qOrder').value = next;
      runQuery(db); renderTab();
    });
    $('#grid').addEventListener('dblclick', e => {
      const tr = e.target.closest('tbody tr[data-r]');
      if (!tr) return;
      state.cur.ui.formIdx = +tr.dataset.r; state.tab = 'form'; renderTab();
    });

    $('#fFirst').onclick = () => formGo(0);
    $('#fPrev').onclick = () => formGo(state.cur.ui.formIdx - 1);
    $('#fNext').onclick = () => formGo(state.cur.ui.formIdx + 1);
    $('#fLast').onclick = () => formGo(state.cur.ui.rows.length - 1);
    document.addEventListener('keydown', e => {
      if (state.tab !== 'form' || !state.cur || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
      if (e.key === 'ArrowLeft') formGo(state.cur.ui.formIdx - 1);
      else if (e.key === 'ArrowRight') formGo(state.cur.ui.formIdx + 1);
    });

    for (const id of ['cType', 'cX', 'cGroup', 'cMeasure', 'cY', 'cSort', 'cTop']) $('#' + id).addEventListener('change', chartChanged);
    $('#cTop').addEventListener('input', () => { if ($('#cTop').value !== '') chartChanged(); });
    $('#cSave').onclick = () => { if (lastSvg) download(new Blob([lastSvg], { type: 'image/svg+xml' }), state.cur.name + '-chart.svg'); };
    $('#btnCsv').onclick = exportCsv;
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (state.tab === 'chart' && state.cur) drawChart(); });
  }

  init();
  window.__sbApp = { deleteRecord, toggleEdit, applyForm, saveToDisk, newRecord, state, addFiles, addDb, select, renderTab };
})();
