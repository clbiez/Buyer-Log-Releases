/* ===================================================================
   ALAN EŞLEME DÜZENLEYİCİSİ (v7.81, P4-yazma)

   Kaynak ayrıntısındaki "N alanı gözden geçir" buraya açılır.

   NE GÖSTERİR — ve neyi göstermez:

   Varsayılan görünüm YALNIZ sorunlu alanları listeler. Eski ekran 37–50
   satırlık tam listeyi açıyordu ve bakılması gereken bir avuç alan içinde
   kayboluyordu. Tam liste isteyen açabilir ama bu ikinci bir karardır.

   TEK ALAN YAZILIR. İstemci bütün eşlemeyi geri göndermez: bayat bir
   görünüm üzerinden tam eşleme göndermek, o arada eklenmiş başka bir alanı
   SESSİZCE düşürürdü. Kullanıcı üç alanı düzeltirken dördüncüyü kaybetmemeli.

   SÜTUN LİSTESİ ŞEMADAN GELİR, UYDURULMAZ. Ölçüler ve sütunlar ayrı
   işaretlenir: ikisini karıştırmak DAX üretiminde sessizce yanlış sonuç
   verir (ör. FOB bir ölçüdür, aynı adlı bir boyut sütunu varsa bile).
   =================================================================== */
(() => {
  'use strict';

  const en = () => typeof appLang !== 'undefined' && appLang === 'en';
  const T = (tr, enText) => (en() ? enText : tr);
  const esc = value => (typeof escapeHtml === 'function'
    ? escapeHtml(String(value == null ? '' : value))
    : String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])));

  const STATUS = {
    foreign: { tr: 'Beklenen adla örtüşmüyor', en: 'Does not match the expected name', tone: 'warn' },
    weak: { tr: 'Yalnız kısmi ad benzerliğiyle tuttu', en: 'Matched only by partial name similarity', tone: 'warn' },
    unmapped: { tr: 'Eşlenmemiş', en: 'Not mapped', tone: 'bad' },
  };

  let host = null;
  let context = null;       // {sourceId, sourceName, server, catalog, revision, problems}
  let schema = null;        // {columns:[], measures:[]}
  /* Şema (sunucu+katalog) başına önbelleklenir. Ekran her kayıttan sonra
     yeniden çizildiği için düzenleyici de yeniden açılır; her açılışta şemayı
     tekrar okumak gereksiz bir DMV sorgusu demek olurdu. */
  const schemaCache = new Map();
  let schemaError = '';
  let busy = false;
  let messages = [];
  let messageTone = 'info';
  let onSaved = null;
  let onClosed = null;

  const TONE_RANK = { info: 0, warn: 1, bad: 2 };
  function say(text, tone = 'info') {
    const value = String(text || '').trim();
    if (!value) return;
    if (!messages.includes(value)) messages.push(value);
    if (TONE_RANK[tone] > TONE_RANK[messageTone]) messageTone = tone;
  }

  /* ---------------------------------------------------------------- */

  async function loadSchema() {
    schemaError = '';
    const key = `${context.server}|${context.catalog}`;
    const cached = schemaCache.get(key);
    if (cached) { schema = cached.schema; schemaError = cached.error; return; }
    try {
      const response = await fetch('/api/model-connections/schema', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server: context.server, catalog: context.catalog }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.error || T('şema okunamadı', 'schema could not be read'));
      schema = { columns: payload.columns || [], measures: payload.measures || [] };
      schemaCache.set(key, { schema, error: '' });
    } catch (error) {
      /* Şema okunamazsa düzenleyici KAPANMAZ: kullanıcı sütun adını elle
         yazabilir. Kaynağa erişilemediği için eşleme düzeltilemez demek,
         kurtarılabilir bir durumu çıkmaza çevirirdi. */
      schema = null;
      schemaError = String(error && error.message || error);
      // Hata ÖNBELLEKLENMEZ: geçici bir arıza kalıcı bir engel olmamalı.
    }
  }

  function columnEntries() {
    if (!schema) return [];
    const measures = (schema.measures || []).map(entry => ({
      value: `measure|${entry.table || ''}|${entry.name}`,
      label: entry.name,
      hint: `${T('ölçü', 'measure')}${entry.table ? ` · ${entry.table}` : ''}`,
    }));
    const columns = (schema.columns || []).map(entry => ({
      value: `column|${entry.table || ''}|${entry.name}`,
      label: entry.name,
      hint: entry.table || '',
    }));
    /* Ölçüler ÖNCE. autoMapSchema da öyle yapıyor: FOB ve miktar alanları
       tabular modelde genellikle ölçüdür ve aynı adı taşıyan bir boyut sütunu
       varsa bile doğru olan ölçüdür. */
    return measures.concat(columns);
  }

  function row(problem) {
    const status = STATUS[problem.status] || STATUS.unmapped;
    const blocking = problem.status === 'unmapped' && problem.required;
    return `<li class="dmmRow${blocking ? ' isBlocking' : ''}">
      <span class="dmmMark" aria-hidden="true">${blocking ? '⛔' : '⚠'}</span>
      <span class="dmmField">${esc(problem.header)}${problem.required ? `<span class="dmReq">${esc(T('zorunlu', 'required'))}</span>` : ''}</span>
      <button type="button" class="dmmColumn" data-pick="${esc(problem.header)}" ${busy ? 'disabled' : ''}>
        ${problem.column ? esc(problem.column) : `<em>${esc(T('sütun seç', 'select column'))}</em>`}
      </button>
      <span class="dmmWhy">
        ${esc(status[en() ? 'en' : 'tr'])}
        ${problem.identity ? ` · ${esc(T('sipariş eşleşmesi bu alanı birebir kullanır', 'order matching uses this field exactly'))}` : ''}
        ${problem.expected && problem.expected.length ? `<span class="dmmExpected">${esc(T('beklenen', 'expected'))}: ${problem.expected.map(esc).join(', ')}</span>` : ''}
      </span>
      ${problem.column ? `<button type="button" class="dmfDrop" data-clear="${esc(problem.header)}" ${busy ? 'disabled' : ''}
        title="${esc(T('Eşlemeyi kaldır', 'Remove mapping'))}">🗑</button>` : '<span></span>'}
    </li>`;
  }

  function render() {
    if (!host) return;
    const problems = context.problems || [];

    host.innerHTML = `<div class="dmMappingEditor" role="region" aria-label="${esc(context.sourceName)}">
      <div class="dmfHead">
        <span class="dmfTitle">${esc(T('Alan eşlemesi', 'Field mapping'))} — ${esc(context.sourceName)}</span>
        <span class="dmsHint">${esc(context.server)} / ${esc(context.catalog)}</span>
      </div>

      ${schemaError ? `<p class="dmfMessage is-warn">${esc(T(
        `Model şeması okunamadı (${schemaError}). Sütun adını elle yazabilirsiniz.`,
        `Model schema could not be read (${schemaError}). You can type the column name.`))}</p>` : ''}

      ${problems.length
        ? `<ul class="dmmList">${problems.map(row).join('')}</ul>`
        : `<p class="dmfEmpty">${esc(T('Gözden geçirilecek alan yok.', 'No fields need review.'))}</p>`}

      <div class="dmfFoot">
        ${messages.length ? `<span class="dmfMessage is-${esc(messageTone)}">${messages.map(esc).join(' ')}</span>` : ''}
        <span class="dmfSpacer"></span>
        <button type="button" class="tbtn" data-close ${busy ? 'disabled' : ''}>${esc(T('Kapat', 'Close'))}</button>
      </div>
    </div>`;
  }

  /* ---------------------------------------------------------------- */

  async function write(header, entry) {
    busy = true; render();
    try {
      const response = await fetch(`/api/data-management/source/${encodeURIComponent(context.sourceId)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // TEK alan gönderilir; tam eşleme değil (bkz. dosya başlığı).
          mappingEntry: { header, entry },
          expectedSourceRevision: context.revision,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.error || T('Eşleme kaydedilemedi.', 'Could not save the mapping.'));
      /* Yazdıktan sonra BU MODÜL bir şey çizmez. Ekran tazelenince kendi
         DOM'unu baştan kurar ve düzenleyicinin bağlı olduğu yuva silinir;
         burada render() çağırmak öksüz bir düğüme yazmak olurdu (canlı
         ölçümde tam olarak bu oldu). Yeniden açmak çağıranın işi. */
      const reopen = typeof onSaved === 'function' ? onSaved : null;
      close({ notify: false });
      // İkinci argüman geriye dönük uyumludur: eski çağıranlar yalnız ilk
      // argümandaki warnings listesini okumaya devam eder. Onarım akışı ise
      // gerçekten hedeflenen alanın kaydedildiğini buradan doğrular.
      if (reopen) await reopen(payload.warnings || [], { header, entry });
      return;
    } catch (error) {
      say(String(error && error.message || error), 'bad');
    } finally {
      if (host) { busy = false; render(); }
    }
  }

  function onClick(event) {
    const closeBtn = event.target.closest('[data-close]');
    if (closeBtn) { close(); return; }

    const clear = event.target.closest('[data-clear]');
    if (clear) { void write(clear.dataset.clear, null); return; }

    const pick = event.target.closest('[data-pick]');
    if (!pick) return;
    const header = pick.dataset.pick;
    const entries = columnEntries();
    window.BLDataPicker?.open?.(pick, entries, value => {
      /* Elle yazılan metin "|" içermez; o zaman sütun olarak kabul edilir.
         Şema okunamadığında tek yol budur. */
      const parts = String(value).split('|');
      const entry = parts.length >= 3
        ? { kind: parts[0], table: parts[1], name: parts.slice(2).join('|') }
        : { kind: 'column', table: '', name: String(value) };
      void write(header, entry);
    }, {
      placeholder: schema ? T('Sütun veya ölçü ara…', 'Search columns or measures…')
        : T('Sütun adını yazıp Enter…', 'Type the column name and press Enter…'),
      allowFree: true,
    });
  }

  /* ---------------------------------------------------------------- */

  function close({ notify = true } = {}) {
    window.BLDataPicker?.close?.();
    if (!host) return;
    const notifier = notify ? onClosed : null;
    host.innerHTML = '';
    host.classList.remove('isOpen');
    host.removeEventListener('click', onClick);
    host = null;
    context = null;
    busy = false;
    if (typeof notifier === 'function') notifier();
  }

  async function open(container, options = {}) {
    close();
    host = container;
    context = { ...options };
    onSaved = options.onSaved || null;
    onClosed = options.onClosed || null;
    messages = []; messageTone = 'info'; busy = false; schema = null;

    host.classList.add('isOpen');
    host.addEventListener('click', onClick);
    host.innerHTML = `<p class="dmsHint">${esc(T('Model şeması okunuyor…', 'Reading the model schema…'))}</p>`;
    await loadSchema();
    render();
  }

  window.BLDataMappingEditor = { open, close };
})();
