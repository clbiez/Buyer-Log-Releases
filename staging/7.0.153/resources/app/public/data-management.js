/* ===================================================================
   VERİ YÖNETİMİ — Overview (v7.81, P2)

   Bu ekran, kaynak yapılandırmasının TEK bakış noktasıdır. Bugüne kadar
   aynı bilgi dört yere dağılmıştı: Kaynak Veri çekmecesi, "Horizon ve
   Bağlantı" modalı, sayfa içi Horizon rozetleri ve sayfa başına ayrı
   Yenile düğmeleri.

   P2'DE NE VAR, NE YOK — bilerek:

   VAR : kaynakların durumu, hangi modülü hangi filtreyle beslediği,
         paylaşılan filtrelerin kaç modülde kullanıldığı, yapısal olarak
         imkânsız bağlantıların açıkça imkânsız gösterilmesi.
   YOK : düzenleme. Bir filtreye ya da eşlemeye tıklamak MEVCUT çalışan
         modalı açar.

   Yarım bir editör çizmiyoruz: çalışmayan bir alan, olmayan bir alandan
   daha kötüdür. Düzenleme P3'te bu ekrana taşınacak.

   ÜÇ HÜCRE DURUMU birbirine karıştırılmaz (read-model.js ile aynı sözleşme):
     on          bağlı ve etkin
     off         bağlanabilir ama kapalı
     unavailable bu kaynak bu modülü YAPISAL OLARAK besleyemez

   Üçüncüsü olmadan ekran, var olmayan bağlantıları kapatılabilir bir
   anahtar gibi gösterir ve kullanıcıya yanlış bir zihinsel model öğretir.
   =================================================================== */
(() => {
  'use strict';

  const en = () => typeof appLang !== 'undefined' && appLang === 'en';
  const T = (tr, enText) => (en() ? enText : tr);
  const esc = value => (typeof escapeHtml === 'function'
    ? escapeHtml(String(value == null ? '' : value))
    : String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])));

  let root = null;
  let model = null;
  let lab = null;
  let labTab = 'integrations';
  let selectedLabSourceId = '';
  let selectedAutomationId = '';
  let labBusy = '';
  let labMessage = '';
  let automationPreview = null;
  let groups = { items: [], revision: 0, refreshableModules: [] };
  let creatingGroup = false;
  let groupDraft = { name: '', moduleIds: [] };
  let groupError = '';
  let loading = false;
  let loadError = '';
  let view = 'list';           // 'list' | 'matrix'
  let expandedSourceId = '';
  /* Eşleme düzenleyicisi hangi kaynak için açık. Açıkken o kaynağın statik
     sorun listesi çizilmez: aynı iki satırın ekranda iki kez görünmesi
     §48'in istemediği gürültüydü (canlı ölçümde görüldü). */
  let mappingEditorSourceId = '';
  // Aynı gerekçe CP sütunları için de geçerli: açıkken satır içi özet çizilmez.
  let cpColumnsSourceId = '';
  // Eşleştirme kuralları açıkken satır içi özet çizilmez (aynı gürültü gerekçesi).
  let matchRuleOpen = false;
  // Satır içi açılan araç (şu an yalnız Data Maintenance).
  let openTool = '';
  // Yazma sürerken o hücre kilitlenir: çift tıklama iki istek göndermemeli.
  let busyCell = '';
  let writeError = '';

  /* ---------------------------------------------------------------- */

  const STATUS_TEXT = {
    ready: { tr: 'Bağlı', en: 'Connected', tone: 'ok' },
    'needs-mapping': { tr: 'Zorunlu alan eksik', en: 'Required field missing', tone: 'bad' },
    'needs-filter': { tr: 'Filtre gerekli', en: 'Filter required', tone: 'warn' },
    error: { tr: 'Son yenileme başarısız', en: 'Last refresh failed', tone: 'bad' },
    disabled: { tr: 'Kapalı', en: 'Disabled', tone: 'muted' },
    unconfigured: { tr: 'Yapılandırılmamış', en: 'Not configured', tone: 'muted' },
  };

  /* Filtre hangi katmandan geliyor. 'source' rozet GÖSTERMEZ: ortak ayarın
     geçerli olması normal durumdur ve her satıra rozet basmak gürültüdür.
     Rozet yalnız ortak ayarın EZİLDİĞİ hâlde çıkar — çünkü açıklanması
     gereken durum odur. */
  const LAYER = {
    personal: { tr: 'Kişisel', en: 'Personal', hint: { tr: 'Bu modül için kendi ayarınız ortak ayarı eziyor.', en: 'Your own setting for this module overrides the shared one.' } },
    personalDefault: { tr: 'Kişisel', en: 'Personal', hint: { tr: 'Tüm modüller için tanımladığınız kişisel varsayılan geçerli.', en: 'Your personal default for all modules is in effect.' } },
    roleTemplate: { tr: 'Rol şablonu', en: 'Role template', hint: { tr: 'Rolünüzden miras alınan şablon geçerli.', en: 'A template inherited from your role is in effect.' } },
    roleDefault: { tr: 'Rol şablonu', en: 'Role template', hint: { tr: 'Rolünüzün genel şablonu geçerli.', en: 'Your role’s general template is in effect.' } },
    /* v7.81: 'preset' ve 'group' katmanları KALDIRILDI (kullanıcı kararı).
       İkisi de kullanıcının görmediği katmanlardı ve bu ekranda ayarlanan
       ortak filtreyi sessizce eziyordu. Geriye kullanıcının kendi ayarı ve
       rolünün şablonu kaldı; ikisi de bu rozetten kaldırılabilir/görülebilir. */
  };

  const LOCAL_REASON = {
    derived: { tr: 'başka modülün verisinden hesaplanır', en: 'computed from another module’s data' },
    local: { tr: 'kullanıcının kendi çalışma verisi', en: 'the user’s own working data' },
    tool: { tr: 'veri taşımaz', en: 'carries no data' },
  };

  function shortTime(value) {
    const text = String(value || '').trim();
    if (!text) return '—';
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) return text;
    const pad = n => String(n).padStart(2, '0');
    const today = new Date();
    const sameDay = date.toDateString() === today.toDateString();
    const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    return sameDay ? clock : `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${clock}`;
  }

  /* ---------------------------------------------------------------- */

  // Uçuştaki yükleme paylaşılır: sekmeye geçiş ile "Yönet" odaklanması aynı
  // anda gelirse iki ayrı istek atılmamalı.
  let loadPromise = null;
  function load() {
    if (!loadPromise) loadPromise = runLoad().finally(() => { loadPromise = null; });
    return loadPromise;
  }

  async function runLoad() {
    loading = true;
    loadError = '';
    render();
    try {
      const [overviewRes, groupsRes, labRes] = await Promise.all([
        fetch(`/api/data-management/overview?language=${en() ? 'en' : 'tr'}`, { cache: 'no-store' }),
        fetch('/api/data-management/refresh-groups', { cache: 'no-store' }),
        fetch(`/api/data-management/integration-lab?language=${en() ? 'en' : 'tr'}`, { cache: 'no-store' }).catch(() => null),
      ]);
      const payload = await overviewRes.json().catch(() => ({}));
      if (!overviewRes.ok || !payload.ok) throw new Error(payload.error || T('Veri Yönetimi özeti okunamadı.', 'Could not read the Data Management summary.'));
      model = payload;
      // Gruplar okunamazsa ekran yine açılır; yalnız grup bölümü boş kalır.
      const groupPayload = await groupsRes.json().catch(() => ({}));
      if (groupsRes.ok && groupPayload.ok) groups = groupPayload;
      const labPayload = labRes ? await labRes.json().catch(() => null) : null;
      if (labRes && labRes.ok && labPayload && labPayload.ok) {
        lab = labPayload;
        if (!selectedLabSourceId) selectedLabSourceId = lab.selectedInspector && lab.selectedInspector.sourceId || '';
        if (!selectedAutomationId) selectedAutomationId = lab.automations && lab.automations[0] && lab.automations[0].id || '';
      }
    } catch (error) {
      loadError = String(error && error.message || error);
      model = null;
    } finally {
      loading = false;
      render();
    }
  }

  /* ---------------------------------------------------------------- */

  function connectorKindText(source) {
    const connector = source && source.connector || {};
    const kind = String(connector.kind || '').toLowerCase();
    if (kind === 'analysis-services') return 'Analysis Services / MSOLAP';
    if (kind === 'sqlserver') return 'SQL Server';
    if (kind === 'odbc') return String(connector.family || '').toLowerCase() === 'oracle' ? 'Oracle / ODBC' : 'ODBC';
    if (kind === 'oledb') return String(connector.family || '').toLowerCase() === 'oracle' ? 'Oracle / OLE DB' : 'OLE DB';
    return source && source.profileLabel || T('Database', 'Database');
  }

  function connectorAuthText(source) {
    const auth = source && source.connector && source.connector.auth || {};
    if (auth.type === 'windows') return T('Windows / Integrated', 'Windows / Integrated');
    if (auth.type === 'username-password') return T('Kullanıcı adı + parola', 'Username + password');
    if (auth.type === 'office-managed') return T('Ayrı kimlik doğrulama gerekebilir', 'Separate authentication may be required');
    return T('Belirlenemedi', 'Unknown');
  }

  function isCustomDatabase(source) {
    return Boolean(source && source.profileId === 'custom-database' && source.connector);
  }

  function sourceCard(source) {
    const status = STATUS_TEXT[source.status] || STATUS_TEXT.unconfigured;
    const expanded = expandedSourceId === source.id;
    const problem = source.lastRun && !source.lastRun.ok && source.lastRun.error;
    const customDb = isCustomDatabase(source);
    const connMeta = customDb
      ? `${connectorKindText(source)} · ${source.connection.server}${source.connection.catalog ? ` / ${source.connection.catalog}` : ''}`
      : `${source.connection.server} / ${source.connection.catalog}`;
    return `<button type="button" class="dmSourceCard${expanded ? ' isOpen' : ''}" data-source="${esc(source.id)}" aria-expanded="${expanded}">
      <span class="dmSourceTop">
        <span class="dmDot dmDot--${status.tone}" aria-hidden="true"></span>
        <span class="dmSourceName">${esc(source.name)}</span>
      </span>
      <span class="dmSourceMeta">${esc(status[en() ? 'en' : 'tr'])} · ${esc(customDb ? connectorKindText(source) : source.profileLabel)}</span>
      <span class="dmSourceMeta dmSourceMeta--quiet">${esc(connMeta)}</span>
      <span class="dmSourceFoot">
        <span>${customDb ? esc(T('Bağımsız database', 'Standalone database')) : `${source.moduleCount} ${esc(T('modül', 'modules'))}`}</span>
        <span>${esc(shortTime(source.lastRun && source.lastRun.at))}</span>
      </span>
      ${source.mapping && source.mapping.needsAttention ? `<span class="dmSourceNote${source.mapping.blocking ? ' isBad' : ''}">
        ${source.mapping.blocking ? '⛔' : '⚠'} ${esc(T(`${source.mapping.needsAttention} alan eşlemesi bakım istiyor`, `${source.mapping.needsAttention} field mappings need attention`))}
      </span>` : ''}
      ${problem ? `<span class="dmSourceError">${esc(source.lastRun.error)}</span>` : ''}
    </button>`;
  }

  const MAPPING_STATUS = {
    foreign: { tr: 'Beklenen adla örtüşmüyor', en: 'Does not match the expected name' },
    weak: { tr: 'Yalnız kısmi ad benzerliğiyle tuttu', en: 'Matched only by partial name similarity' },
    unmapped: { tr: 'Eşlenmemiş', en: 'Not mapped' },
  };

  /* Eşleme bölümü. Tam liste BURADA GÖSTERİLMEZ — zaten sunucudan da gelmez.
     Amaç kullanıcının 38 satır yerine 3 satıra bakması; tam listeyi görmek
     isteyen mevcut eşleme ekranını açar. */
  function mappingSection(source) {
    const health = source.mapping;
    if (!health) return '';
    if (!health.needsAttention) {
      return `<div class="dmMapping dmMapping--ok">
        <span class="dmLabel">${esc(T('Alan eşlemesi', 'Field mapping'))}</span>
        <span class="dmValue">${esc(T(`${health.ok} alan eşlendi, hepsi beklenen adla tutuyor.`, `${health.ok} fields mapped, all match their expected names.`))}</span>
      </div>`;
    }
    const rows = health.problems.map(problem => {
      const label = MAPPING_STATUS[problem.status] || MAPPING_STATUS.unmapped;
      const blocking = problem.status === 'unmapped' && problem.required;
      return `<li class="dmMapRow${blocking ? ' isBlocking' : ''}">
        <span class="dmMapMark" aria-hidden="true">${blocking ? '⛔' : '⚠'}</span>
        <span class="dmMapField">${esc(problem.header)}${problem.required ? `<span class="dmReq">${esc(T('zorunlu', 'required'))}</span>` : ''}</span>
        <span class="dmMapArrow" aria-hidden="true">→</span>
        <span class="dmMapCol">${problem.column ? esc(problem.column) : `<em>${esc(T('seçilmedi', 'not selected'))}</em>`}</span>
        <span class="dmMapWhy">${esc(label[en() ? 'en' : 'tr'])}${problem.identity ? ` · ${esc(T('sipariş eşleşmesi bu alanı birebir kullanır', 'order matching uses this field exactly'))}` : ''}</span>
      </li>`;
    }).join('');
    return `<div class="dmMapping">
      <div class="dmMappingHead">
        <span class="dmLabel">${esc(T('Alan eşlemesi', 'Field mapping'))}</span>
        <span class="dmMappingSummary">
          <span class="isOk">✓ ${health.ok} ${esc(T('otomatik eşlendi', 'auto-mapped'))}</span>
          ${health.review ? `<span class="isWarn">⚠ ${health.review} ${esc(T('gözden geçirilmeli', 'need review'))}</span>` : ''}
          ${health.blocking ? `<span class="isBad">⛔ ${health.blocking} ${esc(T('zorunlu alan eksik', 'required missing'))}</span>` : ''}
        </span>
      </div>
      <ul class="dmMapList">${rows}</ul>
      ${health.blocking ? `<p class="dmMapNote">${esc(T('Zorunlu alan eşlenmeden bu kaynak yenilenemez.', 'This source cannot refresh until the required field is mapped.'))}</p>` : ''}
    </div>`;
  }

  /* CP SÜTUNLARI ÖZETİ (§7 — eski ekrandan taşınan yetenek).

     Yalnız bu yeteneğe sahip kaynaklarda çıkar: pivot raporunda (INTAKE)
     "CP sütunu" diye bir kavram yok ve boş bir bölüm göstermek kullanıcıya
     var olmayan bir ayar arattırırdı. */
  function cpColumnsSection(source) {
    if (!(source.capabilities || []).includes('extra-columns')) return '';
    if (cpColumnsSourceId === source.id) return '';
    const columns = source.cpColumns || [];
    return `<div class="dmDetailRow">
      <span class="dmLabel">${esc(T('CP sütunları', 'CP columns'))}</span>
      <span class="dmValue">
        ${columns.length
          ? esc(columns.map(column => column.label).join(' · '))
          : esc(T('yok', 'none'))}
        ${model.canManage ? `<button type="button" class="dmInlineLink" data-open-cpcolumns="${esc(source.id)}">
          ${esc(columns.length ? T('düzenle', 'edit') : T('ekle', 'add'))}</button>` : ''}
      </span>
    </div>`;
  }

  function sourceDetail(source) {
    const feeds = (model.modules || []).filter(module => module.feeds.some(feed => feed.sourceId === source.id));
    const canNotFeed = (model.modules || []).filter(module => !source.feedableModules.includes(module.id));
    const customDb = isCustomDatabase(source);
    const connector = source.connector || {};
    const discovery = source.discovery || {};
    const queryText = customDb
      ? (source.query && source.query.trim() ? T('Elle yazılmış / Excel’den keşfedilmiş', 'Hand-written / discovered from Excel') : T('Tanımlı değil', 'Not defined'))
      : (source.queryMode === 'manual' ? T('Elle yazılmış', 'Hand-written') : T('Otomatik üretilir', 'Generated'));
    const customMeta = customDb ? `<div class="dmDetailRow dmDatabaseMeta">
      <span class="dmLabel">${esc(T('Database metadata', 'Database metadata'))}</span>
      <span class="dmValue">${esc(connectorKindText(source))}${connector.driver ? ` · ${esc(connector.driver)}` : ''}${connector.provider ? ` · ${esc(connector.provider)}` : ''}${connector.dsn ? ` · DSN: ${esc(connector.dsn)}` : ''} · ${esc(connectorAuthText(source))}</span>
    </div>${discovery.origin === 'excel-workbook' ? `<div class="dmDetailRow dmDetailRow--quiet"><span class="dmLabel">${esc(T('Tanımlama kaynağı', 'Definition origin'))}</span><span class="dmValue">${esc(T('Excel bağlantısından', 'From Excel connection'))}${discovery.workbookName ? ` · ${esc(discovery.workbookName)}` : ''}${discovery.connectionName ? ` · ${esc(discovery.connectionName)}` : ''}</span></div>` : ''}` : '';
    return `<div class="dmDetail" role="region" aria-label="${esc(source.name)}">
      <div class="dmDetailGrid">
        <div><span class="dmLabel">${esc(T('Bağlantı', 'Connection'))}</span>
          <span class="dmValue">${esc(source.connection.server)} / ${esc(source.connection.catalog)}</span></div>
        <div><span class="dmLabel">${esc(T('Kaynak türü', 'Source type'))}</span>
          <span class="dmValue">${esc(customDb ? connectorKindText(source) : source.profileLabel)}</span></div>
        <div><span class="dmLabel">${esc(T('Sorgu', 'Query'))}</span>
          <span class="dmValue">${esc(queryText)}
            ${model.canManage && (source.capabilities || []).includes('manual-query')
              ? `<button type="button" class="dmInlineLink" data-open-query="${esc(source.id)}">${esc(source.query && source.query.trim() ? T('düzenle', 'edit') : T('ekle', 'add'))}</button>` : ''}
          </span></div>
        <div><span class="dmLabel">${esc(customDb ? T('Authentication', 'Authentication') : T('Eşlenmiş alan', 'Mapped fields'))}</span>
          <span class="dmValue">${customDb ? esc(connectorAuthText(source)) : source.mappedFieldCount}</span></div>
      </div>
      ${customMeta}
      ${mappingEditorSourceId === source.id ? '' : mappingSection(source)}
      <div class="dmMappingSlot" data-mapping-slot="${esc(source.id)}"></div>
      ${cpColumnsSection(source)}
      <div class="dmCpSlot" data-cpcolumns-slot="${esc(source.id)}"></div>
      <div class="dmQuerySlot" data-query-slot="${esc(source.id)}"></div>
      <div class="dmConnSlot" data-connection-slot="${esc(source.id)}"></div>
      ${customDb ? '' : `<div class="dmDetailRow">
        <span class="dmLabel">${esc(T('Beslediği modüller', 'Feeds'))}</span>
        <span class="dmValue">${feeds.length ? feeds.map(module => esc(module.label)).join(' · ') : esc(T('henüz yok', 'none yet'))}</span>
      </div>
      ${canNotFeed.length ? `<div class="dmDetailRow dmDetailRow--quiet">
        <span class="dmLabel">${esc(T('Besleyemez', 'Cannot feed'))}</span>
        <span class="dmValue">${canNotFeed.map(module => esc(module.label)).join(' · ')}</span>
      </div>` : ''}`}
      <div class="dmDetailActions">
        ${source.mapping && source.mapping.needsAttention ? `<button type="button" class="navActionBtn" data-open-mapping="${esc(source.id)}">
          ${esc(T(`${source.mapping.needsAttention} alanı gözden geçir`, `Review ${source.mapping.needsAttention} fields`))}
        </button>` : ''}
        ${model.canManage && customDb ? `<button type="button" class="tbtn" data-test-database="${esc(source.id)}">${esc(T('Bağlantıyı Test Et', 'Test Connection'))}</button>` : ''}
        ${model.canManage && !customDb ? `<button type="button" class="tbtn" data-open-connection="${esc(source.id)}">
          ${esc(T('Bağlantıyı düzenle', 'Edit connection'))}
        </button>` : ''}
        ${model.canManage ? `<span class="dmDetailSpacer"></span>
        <button type="button" class="tbtn danger" data-delete-source="${esc(source.id)}"
          title="${esc(T('Kaynağı ve ona bağlı bütün ayarları kalıcı olarak siler', 'Permanently deletes the source and every setting attached to it'))}">
          ${esc(T('Kaynağı sil', 'Delete source'))}
        </button>` : ''}
      </div>
    </div>`;
  }

  /* KAYNAĞI SİL.

     Silme geri alınamaz ve kapatmaktan farklıdır: bağlantı, alan eşlemesi,
     kapsam filtreleri ve park edilmiş bağlantılar birlikte gider. Bu yüzden
     onay kutusu NE KAYBEDİLECEĞİNİ sayar ve kullanıcıya kaynağın adını
     yazdırır — kart listesinde yanlış kartı silmek fazlasıyla kolaydı.
     "Emin misiniz?" diye sorup içeriği söylememek karar değil, kumar. */
  async function deleteSource(sourceId) {
    const source = (model.sources || []).find(entry => entry.id === sourceId);
    if (!source || !model.canManage) return;

    const feeds = (model.modules || [])
      .filter(module => module.feeds.some(feed => feed.sourceId === source.id))
      .map(module => module.label);
    const losses = [
      feeds.length ? T(`${feeds.length} modül bağlantısı (${feeds.join(', ')})`, `${feeds.length} module bindings (${feeds.join(', ')})`) : '',
      source.mappedFieldCount ? T(`${source.mappedFieldCount} alan eşlemesi`, `${source.mappedFieldCount} field mappings`) : '',
      (source.parkedModules || []).length ? T(`${source.parkedModules.length} park edilmiş bağlantı`, `${source.parkedModules.length} parked bindings`) : '',
    ].filter(Boolean);

    /* UYGULAMA İÇİ metin girişi kullanılır, native prompt() DEĞİL.
       Bu bir üslup tercihi değil: prompt() bastırıldığında null döner ve
       "vazgeçildi"den ayırt edilemez — silme sessizce hiç çalışmazdı.
       openHorizonTextInput app-main.js'te tanımlı ve bu uygulamanın kendi
       metin giriş yüzeyi; ikinci bir kopya üretmek §9'a aykırı olurdu. */
    const question = T(
      `"${source.name}" kalıcı olarak silinecek. Birlikte gidecekler: ${losses.length ? losses.join(', ') : 'kayıtlı bir ayar yok'}. Onaylamak için kaynağın adını yazın.`,
      `"${source.name}" will be permanently deleted. This also removes: ${losses.length ? losses.join(', ') : 'no stored settings'}. Type the source name to confirm.`);
    if (typeof openHorizonTextInput !== 'function') {
      /* native prompt()'a DÜŞÜLMEZ. Bastırıldığında null döner ve "vazgeçildi"
         ile ayırt edilemez; geri alınamaz bir işlemi belirsiz bir onaya
         bağlamak kabul edilemez. Giriş yüzeyi yoksa silme yapılmaz. */
      if (typeof showToast === 'function') {
        showToast(T('Onay penceresi açılamadı; sayfayı yenileyip tekrar deneyin.',
          'The confirmation dialog could not open; reload the page and try again.'));
      }
      return;
    }
    const typed = await openHorizonTextInput({
      title: T('Kaynağı sil', 'Delete source'),
      label: question,
      confirmLabel: T('Sil', 'Delete'),
      maxLength: 80,
    });
    if (typed == null) return;

    try {
      const response = await fetch(`/api/data-management/source/${encodeURIComponent(sourceId)}`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedName: typed, expectedSourceRevision: source.revision }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.error || T('Kaynak silinemedi.', 'Could not delete the source.'));
      if (typeof showToast === 'function') {
        const removed = payload.removed || {};
        showToast(T(`${removed.name || source.name} silindi.`, `${removed.name || source.name} deleted.`)
          + (payload.warnings && payload.warnings.length ? ` ${payload.warnings.join(' ')}` : ''));
      }
      if (expandedSourceId === sourceId) expandedSourceId = '';
      if (mappingEditorSourceId === sourceId) mappingEditorSourceId = '';
      await load();
    } catch (error) {
      if (typeof showToast === 'function') showToast(String(error && error.message || error));
    }
  }

  /* ---------------------------------------------------------------- */

  function moduleRow(module) {
    if (!module.feeds.length) {
      /* Bağlanma yolu BURADA DA olmalı. Yalnız dolu satırlara koymak, tamamen
         kopmuş bir modülü liste görünümünden geri bağlanamaz hâle getiriyordu:
         kullanıcı "hiçbir kaynağa bağlı değil" yazısını görüp matrise geçmenin
         gerektiğini tahmin etmek zorunda kalıyordu. */
      return `<div class="dmModuleRow dmModuleRow--empty">
        <span class="dmModuleName">${esc(module.label)}</span>
        <span class="dmModuleFeeds">
          <span class="dmModuleEmpty">${esc(T('Hiçbir kaynağa bağlı değil', 'Not connected to any source'))}</span>
          ${connectables(module)}
        </span>
      </div>
      <div class="dmFilterSlot" data-filter-slot="${esc(module.id)}"></div>`;
    }
    const feeds = module.feeds.map(feed => {
      const shared = feed.filterUsedByCount > 1;
      const name = feed.filterName || (feed.filterBounded ? feed.filterText : T('Filtre yok', 'No filter'));
      const layer = LAYER[feed.layer];
      /* Ortak ayar ezildiyse neyin üstüne yazıldığı da söylenir. Yoksa
         kullanıcı ortak filtreyi değiştirip ekranında hiçbir şey değişmeyince
         sebebini bulamıyordu. */
      const overridden = layer && feed.sharedFilterText
        ? `\n${T('Ezilen ortak filtre', 'Overridden shared filter')}: ${feed.sharedFilterName || feed.sharedFilterText}`
        : '';
      return `<span class="dmFeed${feed.enabled ? '' : ' isOff'}">
        <span class="dmFeedSource">${esc(feed.sourceName)}</span>
        <button type="button" class="dmFeedFilter${feed.filterBounded ? '' : ' isUnbounded'}"
          data-open-filter="${esc(module.id)}:${esc(feed.sourceId)}" title="${esc((feed.filterText || T('Filtre tanımlı değil', 'No filter defined')) + overridden)}">
          ${esc(name)}${shared ? `<span class="dmShared" title="${esc(T(
          `Bu filtreyi şu an ${feed.filterUsedByCount} modül çalıştırıyor. Düzenlemek ona bağlı ${feed.boundModuleCount} modülü etkiler.`,
          `${feed.filterUsedByCount} modules currently run this filter. Editing it affects the ${feed.boundModuleCount} modules bound to it.`))}">${feed.filterUsedByCount}×</span>` : ''}
        </button>
        ${layer ? (feed.layerRemovable
          /* KENDİ ayarı olan katman rozetten kaldırılabilir. Eskiden buraya
             tıklanamıyordu ve ortak filtreyi açmaya çalışan kullanıcı "önce
             onu kaldırın" uyarısıyla çıkmaza giriyordu — kaldırılacak yer
             başka bir ekrandı. */
          ? `<button type="button" class="dmLayer dmLayer--${esc(feed.layer)} isRemovable" data-clear-layer="${esc(module.id)}:${esc(feed.sourceId)}"
              title="${esc(`${layer.hint[en() ? 'en' : 'tr']}\n${T('Kaldırmak için tıklayın — ortak filtre yeniden geçerli olur.', 'Click to remove — the shared filter takes effect again.')}`)}">${esc(layer[en() ? 'en' : 'tr'])} ×</button>`
          : `<span class="dmLayer dmLayer--${esc(feed.layer)}" title="${esc(layer.hint[en() ? 'en' : 'tr'])}">${esc(layer[en() ? 'en' : 'tr'])}</span>`) : ''}
        ${model.canManage && !feed.locked ? `<button type="button" class="dmDisconnect" data-toggle="${esc(feed.sourceId)}:${esc(module.id)}" data-next="off"
          ${busyCell === `${feed.sourceId}:${module.id}` ? 'disabled' : ''}
          title="${esc(T(`${feed.sourceName} bağlantısını kapat — filtre ve eşleme korunur`, `Disconnect ${feed.sourceName} — filter and mapping are preserved`))}"
          aria-label="${esc(T('Bağlantıyı kapat', 'Disconnect'))}">×</button>` : ''}
        ${feed.locked ? `<span class="dmLockMark" title="${esc(T('Bu bağlantı kapatılamaz', 'This connection cannot be turned off'))}" aria-hidden="true">🔒</span>` : ''}
      </span>`;
    }).join('');
    return `<div class="dmModuleRow${module.needsFilter ? ' hasWarning' : ''}">
      <span class="dmModuleName">${esc(module.label)}</span>
      <span class="dmModuleFeeds">${feeds}${connectables(module)}</span>
      ${module.needsFilter ? `<span class="dmWarn" title="${esc(T('Sınırsız sorgu çalıştırılamaz; bu modül yenilenmeden önce bir filtre gerekir.', 'An unbounded query cannot run; this module needs a filter before it can refresh.'))}">${esc(T('filtre gerekli', 'filter required'))}</span>` : ''}
    </div>
    <div class="dmFilterSlot" data-filter-slot="${esc(module.id)}"></div>`;
  }

  /* Bu modülü besleyebilecek ama şu an bağlı OLMAYAN kaynaklar. Matrise gitmeden
     bağlanabilmeli; matris ikincil görünüm, liste varsayılan. */
  function connectables(module) {
    if (!model.canManage) return '';
    return (model.sources || []).map(source => {
      if (model.matrix.cells[`${source.id}:${module.id}`] !== 'off') return '';
      const parked = (source.parkedModules || []).find(entry => entry.moduleId === module.id);
      const busy = busyCell === `${source.id}:${module.id}`;
      /* Park edilmiş kaynak "eklenebilir bir seçenek" değil, KAPATILMIŞ BİR
         BESLEMEDİR. Düğme bunu kendi söyler: yoksa kullanıcı kısalmış satıra
         bakıp verinin neden gelmediğini bilemez ve boş sütunları arıza sanar.
         Durum ile eylemi iki ayrı öğeye bölmek satırı gereksiz kalabalıklaştırırdı
         (§48); tek düğme ikisini de taşır. */
      return `<button type="button" class="dmConnect${parked ? ' isParked' : ''}" data-toggle="${esc(source.id)}:${esc(module.id)}" data-next="on" ${busy ? 'disabled' : ''}
        title="${esc(parked
          ? T(`${source.name} verisi bu modüle çekilmiyor. Tekrar bağla — eski filtren geri gelir.`, `${source.name} data is not pulled for this module. Reconnect — your previous filter returns.`)
          : T(`${source.name} ile bağla — sonra bir filtre tanımlaman gerekir`, `Connect ${source.name} — you will need to define a filter`))}">
        ${parked
          ? `↻ ${esc(source.name)} <span class="dmParkedNote">${esc(T('çekilmiyor', 'not pulled'))}</span>`
          : `+ ${esc(source.name)}`}
      </button>`;
    }).join('');
  }

  function matrixTable() {
    // Bağımsız custom database kaynakları modül besleme matrisi değildir;
    // hepsi 'uygulanamaz' sütunu olarak görünmesin. Kaynak kartında yaşamaya devam eder.
    const sources = (model.sources || []).filter(source => Array.isArray(source.feedableModules) && source.feedableModules.length);
    const modules = model.modules;
    const head = sources.map(source => `<th scope="col" title="${esc(source.connection.catalog)}">${esc(source.name)}</th>`).join('');
    const rows = modules.map(module => {
      const cells = sources.map(source => {
        const state = model.matrix.cells[`${source.id}:${module.id}`] || 'unavailable';
        const feed = module.feeds.find(entry => entry.sourceId === source.id);

        if (state === 'unavailable') {
          return `<td class="dmCell dmCell--na" title="${esc(T(`${source.name} bu modülü besleyemez`, `${source.name} cannot feed this module`))}"><span aria-hidden="true">—</span><span class="srOnly">${esc(T('uygulanamaz', 'not applicable'))}</span></td>`;
        }
        if (state === 'locked') {
          /* Açık ama kapatılamaz. Tıklanabilir göstermek, kullanıcının basıp
             hiçbir şey olmadığını görmesi demekti. */
          return `<td class="dmCell dmCell--locked" title="${esc(T(
            `${module.label} bu kaynakta her zaman açıktır; kapatılamaz.`,
            `${module.label} is always on for this source and cannot be turned off.`))}">
            <span class="dmPill dmPill--locked">${esc(T('AÇIK', 'ON'))}</span>
            <span class="dmCellSub">${esc(T('kilitli', 'locked'))}</span>
          </td>`;
        }

        const parked = (source.parkedModules || []).find(entry => entry.moduleId === module.id);
        const disabled = !model.canManage || busyCell === `${source.id}:${module.id}`;
        return `<td class="dmCell dmCell--${state}">
          <button type="button" class="dmToggle${state === 'on' ? ' isOn' : ''}"
            data-toggle="${esc(source.id)}:${esc(module.id)}" data-next="${state === 'on' ? 'off' : 'on'}"
            ${disabled ? 'disabled' : ''} aria-pressed="${state === 'on'}"
            title="${esc(state === 'on'
              ? T('Bağlantıyı kapat — filtre ve eşleme korunur', 'Disconnect — filter and mapping are preserved')
              : parked ? T(`Tekrar bağla — eski filtren (${parked.filterName || T('adsız', 'unnamed')}) geri gelir`, `Reconnect — your previous filter (${parked.filterName || 'unnamed'}) returns`)
                : T('Bağla — sonra bir filtre tanımlaman gerekir', 'Connect — you will need to define a filter'))}">
            ${esc(state === 'on' ? T('AÇIK', 'ON') : T('KAPALI', 'OFF'))}
          </button>
          ${state === 'on' && feed && feed.conditionCount ? `<span class="dmCellSub">${feed.conditionCount} ${esc(T('filtre', 'filters'))}</span>` : ''}
          ${state === 'off' && parked ? `<span class="dmCellSub dmCellSub--parked" title="${esc(T('Ayarların saklandı', 'Your settings were kept'))}">${esc(T('ayarlar saklı', 'settings kept'))}</span>` : ''}
        </td>`;
      }).join('');
      return `<tr><th scope="row">${esc(module.label)}</th>${cells}</tr>`;
    }).join('');
    return `<div class="dmMatrixWrap"><table class="dmMatrix">
      <thead><tr><th scope="col">${esc(T('Modül', 'Module'))}</th>${head}</tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="dmMatrixNote">${esc(T('— işareti kapalı bir anahtar değildir: o kaynak o modülü besleyemez. “Kilitli” ise açık ama kapatılamaz.', '— is not a switch that is off: that source cannot feed that module. “Locked” means on but not switchable.'))}</p>`;
  }

  /* ---------------------------------------------------------------- */

  /* ---------------------------------------------------------------- */

  const moduleLabel = moduleId => {
    const found = (model.modules || []).find(entry => entry.id === moduleId);
    return found ? found.label : moduleId.toUpperCase();
  };

  /* Yenileme grupları. §23: "Bundan daha karmaşık configuration istemiyorum."
     Ad + onay kutuları, o kadar. Zamanlama ve koşul BİLEREK yok — otomatik
     yenileme zaten ayrı bir ayar ve onu buraya kopyalamak aynı yapılandırmanın
     iki yerde yaşaması demek olurdu. */
  /* =================================================================
     KAYNAK MODU (§7 — "Kaynak Veri" şeridinden taşındı)

     "Bu sayfa ailesi Excel'den mi, Database'den mi besleniyor?" Bu soru
     aşağıdaki bağlantı kartlarından ÖNCE gelir: Excel seçiliyse o kartlardaki
     model bağlantısı hiç sorgulanmaz. Şeritte dururken kullanıcı bağlantıyı
     kurup neden çalışmadığını anlamıyordu; karar artık sonucunu göreceği
     yerde, kartların hemen üstünde.

     MARKUP BİREBİR TAŞINDI. Kimlikler (#asasSourceControl…) ve veri
     öznitelikleri (data-asas-source-mode…) korunuyor; app-main.js'teki
     renderAsasSourceControl / renderAntrepoSourceControl / renderLflSourceControl
     seçiciyle çalıştığı için değiştirilmeden çalışmaya devam ediyor. İkinci bir
     durum yönetimi yazmak, iki ayrı doğruluk kaynağı demek olurdu (§9).

     TIKLAMA BAĞLAMASI DEĞİŞTİ. Eskiden düğmelere açılışta TEK SEFER
     bağlanıyordu; bu ekran her çizimde DOM'u yeniden kurduğu için o bağlama
     kaybolurdu. Ekranın kendi olay delegasyonu kullanılıyor. */
  const SOURCE_MODES = [
    {
      id: 'asasSourceControl', attr: 'data-asas-source-mode', fileId: 'asasSourceFile',
      label: { tr: 'ASAS Kaynağı', en: 'ASAS Source' },
      hint: {
        tr: 'CP, Siparişler, Backlog ve LFL sipariş satırlarını nereden alır.',
        en: 'Where CP, Orders, Backlog and LFL read their order lines from.',
      },
      modes: [['excel', 'Excel'], ['database', 'Database']],
      set: mode => setAsasSourceMode(mode),
    },
    {
      id: 'antrepoSourceControl', attr: 'data-source-mode', fileId: 'antrepoSourceFile',
      label: { tr: 'Antrepo Kaynağı', en: 'Bonded Warehouse Source' },
      hint: {
        tr: 'Antrepo/parsiyel satırlarının geldiği yer.',
        en: 'Where bonded warehouse / partial shipment rows come from.',
      },
      modes: [['excel', 'Excel'], ['database', 'Database'], ['dashboard', 'Dashboard']],
      set: mode => setAntrepoSourceMode(mode),
    },
    {
      id: 'lflSourceControl', attr: 'data-lfl-source-mode', fileId: 'lflSourceFile',
      label: { tr: 'LFL Kaynağı', en: 'LFL Source' },
      hint: {
        tr: 'LFL karşılaştırma satırları; ASAS ile aynı kitaptan beslenir ama seçimi bağımsızdır.',
        en: 'LFL comparison rows; fed from the same workbook as ASAS but selected independently.',
      },
      modes: [['excel', 'Excel'], ['database', 'Database']],
      set: mode => setLflSourceMode(mode),
    },
  ];

  function sourceModePanel() {
    if (!model.canManage) return '';
    return `<div class="dmPanel dmModes">
      <div class="dmPanelHead">
        <span class="dmPanelTitle">${esc(T('Kaynak modu', 'Source mode'))}</span>
        <span class="dmsHint">${esc(T(
          'Excel seçiliyse aşağıdaki model bağlantısı hiç sorgulanmaz.',
          'When Excel is selected, the model connection below is never queried.'))}</span>
      </div>
      ${SOURCE_MODES.map(group => `<div class="dmModeRow">
        <span class="dmModeText">
          <span class="dmToolName">${esc(group.label[en() ? 'en' : 'tr'])}</span>
          <span class="dmToolHint">${esc(group.hint[en() ? 'en' : 'tr'])}</span>
        </span>
        <span class="sourceModeGroup" id="${esc(group.id)}" aria-label="${esc(group.label[en() ? 'en' : 'tr'])}">
          ${group.modes.map(([value, text]) =>
            `<button type="button" class="sourceModeBtn" ${group.attr}="${esc(value)}">${esc(text)}</button>`).join('')}
          <span class="sourceModeFile" id="${esc(group.fileId)}">—</span>
        </span>
      </div>`).join('')}
    </div>`;
  }

  /* Ekran her çizimde DOM'u baştan kurduğu için aktif durum yeniden
     uygulanmalı. Durumun kendisi app-main.js'te yaşıyor; buradan yalnız
     "yeniden çiz" deniyor, ikinci bir kopya tutulmuyor. */
  function syncSourceModes() {
    for (const fn of ['renderAsasSourceControl', 'renderAntrepoSourceControl',
      'renderLflSourceControl', 'renderAutoRefreshState']) {
      try { if (typeof window[fn] === 'function') window[fn](); } catch (_) { /* ekranı düşürme */ }
    }
  }

  /* =================================================================
     ARAÇLAR (§7 — "Kaynak Veri" ayarlar menüsünden taşınanlar)

     Bu on üç iş eskiden kenar çubuğundaki Ayarlar açılır menüsünde, tek bir
     etiketsiz yığın hâlinde duruyordu: iş kuralları, referans veri, dosya
     yüklemeleri, sistem ayarları ve tanı araçları yan yana. Kullanıcı bir
     şeyi bulmak için hepsini okumak zorundaydı ve hiçbiri ne yaptığını
     söylemiyordu.

     BURADA ÜÇ SORUYA GÖRE AYRILIYORLAR:

       Hesaplama kuralları  → "uygulama bu sayıyı nasıl hesaplıyor?"
       Referans veri        → "bu liste nereden geliyor, nasıl güncellenir?"
       Depolama ve bakım    → "veri nerede duruyor, sağlıklı mı?"

     Her satır NE YAPTIĞINI yazar. Bir kurulum ekranında asıl maliyet tıklama
     değil, doğru aracı bulmak için açıp kapamaktır.

     DÜZENLEYİCİLER YENİDEN YAZILMADI. Her satır bugün çalışan editörü çağırır;
     ikinci bir kopya üretmek §9'a aykırı olurdu. Tembel yüklenen modüller
     (e-posta grupları, yedekleme) çağrılmadan önce beklenir. */
  const TOOL_GROUPS = [
    {
      id: 'rules',
      label: { tr: 'Hesaplama kuralları', en: 'Calculation rules' },
      hint: {
        tr: 'Ortak kurallar: değiştirmek herkesin gördüğü sayıyı değiştirir.',
        en: 'Shared rules: changing one changes the numbers everyone sees.',
      },
      tools: [
        { id: 'transit', requires: 'manageBusinessRules', icon: 'i-ship',
          label: { tr: 'Yol Süreleri', en: 'Transfer Lead Times' },
          hint: { tr: 'Üretim ülkesi ve sevkiyat tipine göre transit gün sayısı; tahmini varış bundan hesaplanır.',
            en: 'Transit days by production country and shipment type; estimated arrival is derived from this.' },
          run: () => openTransitRulesModal() },
        { id: 'landed', requires: 'manageBusinessRules', icon: 'i-calculator',
          label: { tr: 'Landed Çarpanları', en: 'Landed Multipliers' },
          hint: { tr: 'Koleksiyon TR ve Overseas landed maliyet çarpanları.',
            en: 'Collection TR and Overseas landed cost multipliers.' },
          run: () => openLandedMultipliersModal() },
        { id: 'royalty', requires: 'manageBusinessRules', icon: 'i-calculator',
          label: { tr: 'License Royalty', en: 'License Royalty' },
          hint: { tr: 'OPD tarih aralığı, sezon, üretim ülkesi, Licensor ve License bazlı royalty ve hologram hesapları.',
            en: 'Royalty and hologram calculations by OPD date range, season, production country, Licensor and License.' },
          run: () => openSuppFobRulesModal() },
        { id: 'nondtr', requires: 'manageBusinessRules', icon: 'i-users-group',
          label: { tr: 'Non-DTR Üreticiler', en: 'Non-DTR Manufacturers' },
          hint: { tr: 'DTR dışı sayılan üreticiler; maliyet ve royalty hesabı bu listeye bakar.',
            en: 'Manufacturers treated as non-DTR; cost and royalty calculations read this list.' },
          run: () => openNonDtrManufacturersModal() },
      ],
    },
    {
      id: 'reference',
      label: { tr: 'Referans veri ve yüklemeler', en: 'Reference data and uploads' },
      hint: {
        tr: 'Bağlantıdan değil, dosya ya da elle girişten gelen ortak veri.',
        en: 'Shared data that arrives from a file or manual entry rather than a connection.',
      },
      tools: [
        { id: 'emailgroups', icon: 'i-mail-send',
          label: { tr: 'E-Mail Grupları', en: 'E-Mail Groups' },
          hint: { tr: 'Üretici e-posta adresleri, ülke ve gruplara göre.',
            en: 'Manufacturer email addresses by country and group.' },
          run: async () => { await feature('deferredUi'); window.BLEmailGroups?.open?.(); } },
        { id: 'fx', requires: 'manageBusinessRules', icon: 'i-coins',
          label: { tr: 'Kur Excel’i', en: 'FX Excel' },
          hint: { tr: 'Döviz kuru tablosunu Excel’den yükler.', en: 'Loads the exchange-rate table from Excel.' },
          run: () => document.getElementById('sourceFxFile')?.click() },
        { id: 'endeksmatik', requires: 'manageModelConnections', icon: 'i-file-import',
          label: { tr: 'Endeksmatik Güncelle', en: 'Update Endeksmatik' },
          hint: { tr: 'Yeni ENDEKSMATİK çalışma kitabını doğrular ve yükler.',
            en: 'Validates and loads a new ENDEKSMATIK workbook.' },
          run: () => triggerEndeksmatikUpload() },
        { id: 'folder', icon: 'i-folder',
          label: { tr: 'Kaynak Klasör', en: 'Source Folder' },
          hint: { tr: 'Excel kaynaklarının okunduğu klasör; model erişilemezse kullanılan yol.',
            en: 'The folder Excel sources are read from; the fallback path when the model is unreachable.' },
          /* SEÇİLİ YOL GÖSTERİLİR. Eski düğme onu kendi etiketinde taşıyordu;
             araç satırına taşınırken düşürülseydi kullanıcı hangi klasörün
             bağlı olduğunu hiçbir yerde göremezdi. */
          value: () => (model.environment || {}).sourceFolder || '',
          run: () => chooseSourceFolder() },
      ],
    },
    {
      id: 'storage',
      label: { tr: 'Depolama ve bakım', en: 'Storage and maintenance' },
      hint: {
        tr: 'Verinin nerede durduğu ve sağlığı. Analiz salt okunurdur.',
        en: 'Where the data lives and how healthy it is. Analysis is read-only.',
      },
      tools: [
        { id: 'maintenance', icon: 'i-database-import', inline: true,
          label: { tr: 'Data Maintenance', en: 'Data Maintenance' },
          hint: { tr: 'Yerel veri, PLM, cache ve Shared Sync sağlığını analiz eder; iş verisi silinmez.',
            en: 'Analyzes local data, PLM, cache and Shared Sync health; business data is never deleted.' } },
        { id: 'sync', icon: 'i-folder',
          label: { tr: 'Sync & Local Data', en: 'Sync & Local Data' },
          hint: { tr: 'Yerel veritabanının yeri ve paylaşılan senkron klasörü.',
            en: 'Local database location and the shared sync folder.' },
          run: () => openSyncLocalDataModal() },
        { id: 'backup', requires: 'manageModelConnections', icon: 'i-database-import',
          label: { tr: 'Yedekleme', en: 'Backup' },
          hint: { tr: 'Yedek al, geri yükle, zamanlanmış yedeklemeyi ayarla.',
            en: 'Take a backup, restore one, schedule automatic backups.' },
          run: async () => { await feature('deferredUi'); window.buyerLogBackupModal?.(); } },
        { id: 'imagelimit', icon: 'i-photo-size',
          label: { tr: 'Görsel Boyut Limiti', en: 'Image Size Limit' },
          hint: { tr: 'Kaydedilen model görsellerinin üst dosya boyutu.',
            en: 'Maximum file size for stored model images.' },
          run: () => openModelImageLimitModal() },
        { id: 'browser', icon: 'i-globe',
          label: { tr: 'Browser ve Remote Debugging', en: 'Browser & Remote Debugging' },
          hint: { tr: 'Kurumsal sitelerde mevcut tarayıcı oturumunu kullanan bağlantı.',
            en: 'The connection that reuses your existing browser session on corporate sites.' },
          run: () => openBrowserDebugSettingsModal() },
      ],
    },
  ];

  /* Tembel modül bekleyicisi. BLPerf yoksa (test koşumu) sessizce geçer. */
  function feature(name) {
    return window.BLPerf && typeof window.BLPerf.ensureFeature === 'function'
      ? window.BLPerf.ensureFeature(name)
      : Promise.resolve();
  }

  /* Ortak ayar düzenleyicileri Moderatörün verdiği izinle açılır; cihaza özel
     araçlar (kaynak klasör, senkron, görsel limiti, tarayıcı, bakım) Kaynak
     Veri alanı olan herkese açıktır. E-posta grupları herkese görünür,
     düzenleme yetkisi modülün içinde denetlenir. */
  function toolAllowed(tool) {
    if (!tool || !tool.requires) return true;
    return typeof window.BLHasPermission === 'function' ? window.BLHasPermission(tool.requires) : Boolean(model.canManage);
  }
  function visibleToolGroups() {
    return TOOL_GROUPS.map(group => ({ ...group, tools: group.tools.filter(toolAllowed) })).filter(group => group.tools.length);
  }

  function toolsPanel() {
    const groups = visibleToolGroups();
    if (!groups.length) return '';
    return `<div class="dmPanel dmTools">
      <div class="dmPanelHead"><span class="dmPanelTitle">${esc(T('Araçlar', 'Tools'))}</span></div>
      ${groups.map(group => `<div class="dmToolGroup">
        <div class="dmToolGroupHead">
          <span class="dmToolGroupTitle">${esc(group.label[en() ? 'en' : 'tr'])}</span>
          <span class="dmsHint">${esc(group.hint[en() ? 'en' : 'tr'])}</span>
        </div>
        <ul class="dmToolList">
          ${group.tools.map(tool => `<li class="dmToolRow${openTool === tool.id ? ' isOpen' : ''}">
            <button type="button" class="dmTool" data-tool="${esc(tool.id)}">
              <svg class="ic" aria-hidden="true"><use href="#${esc(tool.icon)}"/></svg>
              <span class="dmToolText">
                <span class="dmToolName">${esc(tool.label[en() ? 'en' : 'tr'])}</span>
                <span class="dmToolHint">${esc(tool.hint[en() ? 'en' : 'tr'])}</span>
                ${typeof tool.value === 'function' && tool.value()
                  ? `<span class="dmToolValue" title="${esc(tool.value())}">${esc(tool.value())}</span>` : ''}
              </span>
            </button>
            ${tool.inline ? `<div class="dmToolSlot" data-tool-slot="${esc(tool.id)}"></div>` : ''}
          </li>`).join('')}
        </ul>
      </div>`).join('')}
    </div>`;
  }

  function findTool(id) {
    for (const group of TOOL_GROUPS) {
      const found = group.tools.find(tool => tool.id === id);
      if (found) return found;
    }
    return null;
  }

  async function runTool(id) {
    const tool = findTool(id);
    if (!tool || !toolAllowed(tool)) return;

    if (tool.inline) {
      /* Satır içi araç ikinci tıklamada KAPANIR. Diğer düzenleyicilerle aynı
         davranış; açık bir paneli kapatmak için başka bir yol aramak gerekmez. */
      if (openTool === tool.id) { closeInlineTool(); return; }
      openTool = tool.id;
      render();
      const slot = root.querySelector(`[data-tool-slot="${CSS.escape(tool.id)}"]`);
      if (!slot) { openTool = ''; return; }
      slot.__onDataMaintClosed = () => { openTool = ''; render(); };
      if (tool.id === 'maintenance' && typeof openDataMaintenanceModal === 'function') {
        void openDataMaintenanceModal(slot);
      }
      return;
    }

    try { await tool.run(); }
    catch (error) { if (typeof showToast === 'function') showToast(String(error && error.message || error)); }
  }

  function closeInlineTool() {
    const slot = root && root.querySelector('[data-tool-slot]');
    if (slot) slot.innerHTML = '';
    openTool = '';
    render();
  }

  function refreshGroupsPanel() {
    const busy = Boolean(window.BL_REFRESH_BUSY);
    const rows = groups.items.map(group => `<div class="dmGroupRow">
      <span class="dmGroupName">${esc(group.name)}</span>
      <span class="dmGroupModules">${group.moduleIds.map(id => esc(moduleLabel(id))).join(' · ')}</span>
      <button type="button" class="tbtn" data-run-group="${esc(group.id)}" ${busy ? 'disabled' : ''}
        title="${esc(busy ? T('Bir yenileme zaten sürüyor', 'A refresh is already running') : T('Bu gruptaki modülleri birlikte yenile', 'Refresh these modules together'))}">
        <svg class="ic"><use href="#i-refresh"/></svg>${esc(T('Yenile', 'Refresh'))}</button>
      ${model.canManage ? `<button type="button" class="dmDisconnect" data-delete-group="${esc(group.id)}"
        title="${esc(T('Grubu sil — modüller ve filtreler etkilenmez', 'Delete the group — modules and filters are unaffected'))}" aria-label="${esc(T('Grubu sil', 'Delete group'))}">×</button>` : ''}
    </div>`).join('');

    const checkboxes = (groups.refreshableModules || []).map(moduleId => `<label class="dmCheck">
      <input type="checkbox" data-draft-module="${esc(moduleId)}" ${groupDraft.moduleIds.includes(moduleId) ? 'checked' : ''}>
      <span>${esc(moduleLabel(moduleId))}</span>
    </label>`).join('');

    return `<div class="dmPanel">
      <div class="dmPanelHead">
        <span class="dmPanelTitle">${esc(T('Yenileme', 'Refresh'))}</span>
        ${model.canManage && !creatingGroup ? `<button type="button" class="tbtn" data-new-group>+ ${esc(T('Grup oluştur', 'Create group'))}</button>` : ''}
      </div>

      ${model.canManage ? `<div class="dmModeRow dmAutoRefresh">
        <span class="dmModeText">
          <span class="dmToolName">${esc(T('Otomatik yenileme', 'Auto refresh'))}</span>
          <span class="dmToolHint" id="autoRefreshNote"></span>
        </span>
        <select id="autoRefreshSelect" class="dmAutoSelect" aria-label="${esc(T('Otomatik yenileme', 'Auto refresh'))}">
          <option value="0">${esc(T('Kapalı', 'Off'))}</option>
          <option value="15">15 dk</option>
          <option value="30">30 dk</option>
          <option value="60">60 dk</option>
          <option value="120">2 sa</option>
          <option value="240">4 sa</option>
        </select>
      </div>` : ''}

      <div class="dmModeRow dmRefreshTiming">
        <span class="dmModeText">
          <span class="dmToolName">${esc(T('Son yenileme süresi', 'Last refresh duration'))}</span>
          <span class="dmToolHint">${esc(T(
            'Tüm sayfalar için en son çalışan yenilemenin süresi.',
            'Duration of the most recent refresh across all pages.'))}</span>
        </span>
        <span class="sourceRefreshTimer" data-source-timer="all"
          aria-label="${esc(T('Yenileme süresi', 'Refresh duration'))}">—</span>
      </div>

      <div class="dmSectionLabel dmSectionLabel--sub">${esc(T('Gruplar', 'Groups'))}</div>

      ${rows || (creatingGroup ? '' : `<p class="dmGroupEmpty">${esc(T('Henüz grup yok. Birlikte yenilenmesini istediğin modülleri tek bir adla topla.', 'No groups yet. Collect the modules you want refreshed together under one name.'))}</p>`)}

      ${creatingGroup ? `<div class="dmGroupForm">
        <label class="dmGroupNameField">
          <span class="dmLabel">${esc(T('Ad', 'Name'))}</span>
          <input type="text" id="_dmGroupName" value="${esc(groupDraft.name)}" maxlength="60"
            placeholder="${esc(T('Örn. Buying Core', 'e.g. Buying Core'))}" autocomplete="off">
        </label>
        <div class="dmGroupChecks">${checkboxes}</div>
        ${groupError ? `<p class="dmGroupError">${esc(groupError)}</p>` : ''}
        <div class="dmGroupActions">
          <button type="button" class="tbtn" data-cancel-group>${esc(T('İptal', 'Cancel'))}</button>
          <button type="button" class="navActionBtn" data-save-group>${esc(T('Oluştur', 'Create'))}</button>
        </div>
      </div>` : ''}

      ${(groups.refreshableModules || []).length && !creatingGroup ? `<p class="dmGroupNote">${esc(T(
        'INTAKE bu listede yoktur: kendi ekranından yenilenir.',
        'INTAKE is not in this list: it refreshes from its own screen.'))}</p>` : ''}
    </div>`;
  }

  const LAB_STATUS = {
    healthy: { tr: 'Sağlıklı', en: 'Healthy', tone: 'ok' },
    configured: { tr: 'Hazır', en: 'Configured', tone: 'ok' },
    warning: { tr: 'Uyarı', en: 'Warning', tone: 'warn' },
    failed: { tr: 'Başarısız', en: 'Failed', tone: 'bad' },
    unavailable: { tr: 'Kullanılamıyor', en: 'Unavailable', tone: 'muted' },
  };

  function labTabs() {
    const tabs = [['integrations', T('Entegrasyonlar', 'Integrations')]];
    if (model.canManage) tabs.push(
      ['inspector', T('Veri Denetçisi', 'Data Inspector')],
      ['automation', T('Troy Otomasyon Laboratuvarı', 'Troy Automation Lab')]);
    return `<div class="dmLabTabs" data-bl-tabs="line" role="tablist" aria-label="${esc(T('Entegrasyon laboratuvarı bölümleri', 'Integration lab sections'))}">${tabs.map(([id, label]) =>
      `<button type="button" id="dmLabTab-${id}" class="dmLabTab${labTab === id ? ' isActive' : ''}" data-lab-tab="${id}" role="tab" aria-controls="dmLabPanel" aria-selected="${labTab === id}" tabindex="${labTab === id ? '0' : '-1'}">${esc(label)}</button>`).join('')}</div>`;
  }

  function labInventory() {
    if (!lab || !(lab.inventory || []).length) return `<p class="dmLabEmpty">${esc(T('Kayıtlı entegrasyon bulunamadı.', 'No registered integrations found.'))}</p>`;
    return `<div class="dmLabTableWrap"><table class="dmLabTable">
      <thead><tr><th>${esc(T('Ad', 'Name'))}</th><th>${esc(T('Tür', 'Type'))}</th><th>${esc(T('Veri durumu', 'Data status'))}</th><th>${esc(T('Son kontrol', 'Last check'))}</th><th>${esc(T('Durum', 'Status'))}</th><th>${esc(T('Not', 'Note'))}</th><th></th></tr></thead>
      <tbody>${lab.inventory.map(item => {
        const status = LAB_STATUS[item.status] || { tr: item.status, en: item.status, tone: 'muted' };
        const database = item.kind === 'database';
        return `<tr>
          <td><strong>${esc(item.name)}</strong></td>
          <td>${esc(database ? T('Veritabanı', 'Database') : T('Web uygulaması', 'Web app'))}</td>
          <td>${item.rowCount == null ? '—' : `${Number(item.rowCount).toLocaleString(en() ? 'en-US' : 'tr-TR')} ${esc(T('satır', 'rows'))}`}</td>
          <td>${esc(shortTime(item.lastCheckedAt))}</td>
          <td><span class="dmLabStatus dmLabStatus--${status.tone}"><span class="dmDot dmDot--${status.tone}"></span>${esc(status[en() ? 'en' : 'tr'])}</span></td>
          <td>${esc(item.note || '—')}</td>
          <td>${model.canManage ? (database ? `<button type="button" class="tbtn" data-lab-inspect="${esc(item.id)}">${esc(T('İncele', 'Inspect'))}</button>` : `<button type="button" class="tbtn" data-lab-automation="${esc(String(item.id).replace(/^automation:/, ''))}">${esc(T('Dry run', 'Dry run'))}</button>`) : ''}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;
  }

  function currentInspector() {
    if (!lab) return null;
    return (lab.inspectors || []).find(item => item.sourceId === selectedLabSourceId) || lab.selectedInspector || null;
  }

  function labInspector() {
    const inspector = currentInspector();
    if (!inspector) return `<p class="dmLabEmpty">${esc(T('İncelenecek veritabanı bulunamadı.', 'No database is available to inspect.'))}</p>`;
    const options = (lab.inventory || []).filter(item => item.kind === 'database');
    return `<div class="dmLabInspector">
      <div class="dmLabTools">
        <label class="dmLabField"><span>${esc(T('Kaynak', 'Source'))}</span><select data-lab-source>${options.map(item => `<option value="${esc(item.id)}"${item.id === inspector.sourceId ? ' selected' : ''}>${esc(item.name)}</option>`).join('')}</select></label>
        <label class="dmLabField dmLabTrace"><span>${esc(T('Bir siparişi/kaydı izle', 'Trace one order/record'))}</span><input data-lab-trace type="text" autocomplete="off" placeholder="450123"></label>
        <button type="button" class="navActionBtn" data-lab-run-inspector ${labBusy ? 'disabled' : ''}>${esc(labBusy === 'inspect' ? T('Sınanıyor…', 'Testing…') : T('Canlı bağlantıyı sına', 'Test live connection'))}</button>
      </div>
      <div class="dmLabPipeline">${(inspector.pipeline || []).map((item, index) => `<div class="dmLabStage dmLabStage--${esc(item.status)}">
        <span class="dmLabStageNo">${index + 1}</span><strong>${esc(item.label)}</strong>
        <span>${item.count == null ? '' : Number(item.count).toLocaleString(en() ? 'en-US' : 'tr-TR')}</span>
        <small>${esc(item.note)}</small>
      </div>`).join('')}</div>
      <div class="dmLabMetrics">
        <span><strong>${Number(inspector.metrics && inspector.metrics.rawRows || 0).toLocaleString(en() ? 'en-US' : 'tr-TR')}</strong>${esc(T('Ham satır', 'Raw rows'))}</span>
        <span><strong>${Number(inspector.metrics && inspector.metrics.duplicateRows || 0).toLocaleString(en() ? 'en-US' : 'tr-TR')}</strong>${esc(T('Yinelenen', 'Duplicates'))}</span>
        <span><strong>${Number(inspector.metrics && inspector.metrics.missingOrderKeys || 0).toLocaleString(en() ? 'en-US' : 'tr-TR')}</strong>${esc(T('Sipariş anahtarı eksik', 'Missing order key'))}</span>
        <span><strong>${Number(inspector.metrics && inspector.metrics.rowLoss || 0).toLocaleString(en() ? 'en-US' : 'tr-TR')}</strong>${esc(inspector.metrics && inspector.metrics.joinInputRows != null ? T('ASAS–IAS eşleşmeyen', 'Unmatched ASAS–IAS') : T('Ölçülen satır kaybı', 'Measured row loss'))}</span>
      </div>
      ${inspector.join ? `<details class="dmLabJoin" open>
        <summary>${esc(T('ASAS–IAS eşleştirme kanıtı', 'ASAS–IAS matching evidence'))}</summary>
        <p><strong>${esc(inspector.join.ruleLabel || inspector.join.rule || '—')}</strong></p>
        <div class="dmLabJoinConditions">${(inspector.join.conditions || []).map(condition => `<span>${esc(condition.asasLabel)} = ${esc(condition.iasLabel)}</span>`).join('')}</div>
        ${(inspector.join.samples || []).length ? `<ul>${inspector.join.samples.map(sample => `<li><strong>${esc(sample.anchor)}</strong>: ${esc((sample.mismatch || []).join(', ') || T('eşleşmedi', 'not matched'))}</li>`).join('')}</ul>` : `<p>${esc(T('Örnek ayrışma yok.', 'No mismatch sample.'))}</p>`}
      </details>` : ''}
      ${inspector.trace && inspector.trace.value ? `<div class="dmLabTraceResult"><strong>${esc(inspector.trace.value)}</strong>${Object.entries(inspector.trace.stages || {}).map(([name, value]) => `<span>${esc(name)}: ${Number(value.matches) || 0}</span>`).join('')}</div>` : ''}
    </div>`;
  }

  function labAutomation() {
    const recipes = lab && lab.automations || [];
    if (!recipes.length) return `<p class="dmLabEmpty">${esc(T('Troy veya browser otomasyonu tanımlı değil.', 'No Troy or browser automation is configured.'))}</p>`;
    const recipe = recipes.find(item => item.id === selectedAutomationId) || recipes[0];
    return `<div class="dmLabAutomation">
      <div class="dmLabTools">
        <label class="dmLabField"><span>${esc(T('Otomasyon', 'Automation'))}</span><select data-lab-recipe>${recipes.map(item => `<option value="${esc(item.id)}"${item.id === recipe.id ? ' selected' : ''}>${esc(item.name)}</option>`).join('')}</select></label>
        <span class="dmLabSafety">${esc(T('Yalnız dry run — son işlem çalıştırılmaz.', 'Dry run only — the final action is never executed.'))}</span>
        <button type="button" class="navActionBtn" data-lab-dry-run="${esc(recipe.id)}" ${labBusy ? 'disabled' : ''}>${esc(labBusy === 'automation' ? T('Çalışıyor…', 'Running…') : T('Dry run çalıştır', 'Run dry run'))}</button>
      </div>
      <ol class="dmLabStepList">${(recipe.steps || []).map(step => `<li><span>${step.index}</span><strong>${esc(step.action || step.description)}</strong><small>${esc(step.description || step.target || '')}</small></li>`).join('')}</ol>
      ${automationPreview ? `<pre class="dmLabPreview">${esc(JSON.stringify(automationPreview, null, 2))}</pre>` : ''}
    </div>`;
  }

  function labPanel() {
    if (!lab) return `<div class="dmNotice">${esc(T('Entegrasyon tanısı yüklenemedi; bağlantı yönetimi kullanılmaya devam edebilir.', 'Integration diagnostics could not load; connection management remains available.'))}</div>`;
    const environment = lab.environment || {};
    const body = labTab === 'inspector' ? labInspector() : labTab === 'automation' ? labAutomation() : labInventory();
    return `<div class="dmLabPanel">
      <div class="dmLabOverview">
        <span class="dmLabEnvironment ${environment.mode === 'CORPORATE_LIVE' ? 'isLive' : 'isLocal'}">${esc(environment.label || environment.mode)}</span>
        ${environment.validationRequired ? `<span class="dmLabValidation">CORPORATE VALIDATION REQUIRED</span>` : ''}
        <span>${Number(lab.summary && lab.summary.integrationCount || 0)} ${esc(T('entegrasyon', 'integrations'))}</span>
        <span>${Number(lab.summary && lab.summary.attentionCount || 0)} ${esc(T('dikkat isteyen', 'need attention'))}</span>
        <span class="dmSummarySpacer"></span>
        ${model.canManage ? `<button type="button" class="tbtn" data-lab-ai-export="json">${esc(T('AI tanısını JSON indir', 'Download AI diagnostic JSON'))}</button>
        <button type="button" class="tbtn" data-lab-ai-export="text">${esc(T('AI tanısını metin indir', 'Download AI diagnostic text'))}</button>` : ''}
      </div>
      ${labTabs()}
      <div id="dmLabPanel" class="dmLabBody" role="tabpanel" aria-labelledby="dmLabTab-${labTab}" tabindex="0">${body}</div>
      ${labMessage ? `<p class="dmfMessage ${/başarısız|failed|error/i.test(labMessage) ? 'is-bad' : 'is-info'}">${esc(labMessage)}</p>` : ''}
    </div>`;
  }

  /* Bağlantı düzenleyicisi (§7 — eski ekrandan taşınan yetenek).

     Ad, sunucu, model ve "yenilemede kullan" anahtarı. Eskiden bu tıklama
     1.619 satırlık eski modalı açıyordu; artık kaynağın kendi ayrıntısında,
     satır içinde düzenlenir. */
  async function testDatabaseSource(sourceId) {
    const source = (model.sources || []).find(entry => entry.id === sourceId);
    if (!source || !isCustomDatabase(source) || !model.canManage) return;
    try {
      const response = await fetch(`/api/database-sources/${encodeURIComponent(sourceId)}/test`, { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.error || T('Database bağlantısı başarısız.', 'Database connection failed.'));
      if (typeof showToast === 'function') {
        const ms = Number(payload.probe && payload.probe.elapsedMs) || 0;
        showToast(T(`Database bağlantısı başarılı${ms ? ` · ${ms} ms` : ''}.`, `Database connection successful${ms ? ` · ${ms} ms` : ''}.`));
      }
    } catch (error) {
      if (typeof showToast === 'function') showToast(String(error && error.message || error));
    }
  }

  function openConnectionEditor(sourceId) {
    const source = (model.sources || []).find(entry => entry.id === sourceId);
    if (!source || !model.canManage) return;

    expandedSourceId = sourceId;
    render();
    const slot = root.querySelector(`[data-connection-slot="${CSS.escape(sourceId)}"]`);
    if (!slot) return;
    window.BLDataConnection?.open?.(slot, {
      sourceId: source.id,
      name: source.name,
      server: source.connection.server,
      catalog: source.connection.catalog,
      enabled: source.enabled !== false,
      revision: source.revision,
      moduleLabels: (model.modules || [])
        .filter(module => module.feeds.some(feed => feed.sourceId === source.id))
        .map(module => module.label),
      onSaved: async warnings => {
        /* Uyarılar YUTULMAZ: "sunucu değişti, eşlemeyi gözden geçirin" ya da
           "bu türde zaten aktif bir kaynak var" kaydın en önemli sonucudur. */
        if (warnings && warnings.length && typeof showToast === 'function') showToast(warnings.join(' '));
        await load();
      },
    });
  }

  /* Sorgu modu düzenleyicisi (§7 — eski ekrandan taşınan yetenek).
     Kaydettikten sonra ekran tazelenir ve sunucunun uyarıları gösterilir:
     "artık filtre yerine bu metin geçerli" bilgisi kaydın en önemli sonucudur
     ve yutulursa kullanıcı filtresini değiştirip hiçbir şeyin değişmediğini
     görür — eski ekranın tam olarak ürettiği şaşkınlık. */
  function openQueryEditor(sourceId) {
    const source = (model.sources || []).find(entry => entry.id === sourceId);
    if (!source || !model.canManage) return;
    if (!(source.capabilities || []).includes('manual-query')) return;

    expandedSourceId = sourceId;
    render();
    const slot = root.querySelector(`[data-query-slot="${CSS.escape(sourceId)}"]`);
    if (!slot) return;
    window.BLDataQueryEditor?.open?.(slot, {
      sourceId: source.id,
      sourceName: source.name,
      server: source.connection.server,
      catalog: source.connection.catalog,
      engine: source.engine,
      revision: source.revision,
      mode: source.queryMode,
      query: source.query || '',
      moduleLabels: (model.modules || [])
        .filter(module => module.feeds.some(feed => feed.sourceId === source.id))
        .map(module => module.label),
      onSaved: async warnings => {
        if (warnings && warnings.length && typeof showToast === 'function') showToast(warnings.join(' '));
        await load();
      },
    });
  }

  /* VERİ EŞLEŞTİRME KURALLARI (§7 — v7.81 ASAS↔IAS satırının genellemesi).

     Kaynak kartının İÇİNDE değil, şeridin ALTINDA durur: bu kural tek bir
     kaynağın özelliği değil, kaynaklar ARASINDAKİ ilişkidir. Bir kartın
     altına koymak "o kaynağın ayarı" izlenimi verir ve kullanıcı diğer
     tarafı değiştirmek istediğinde yanlış kartta arar.

     GÖRÜNÜRLÜK KOŞULU KAYNAK ADIYLA YAZILMAZ. Satır, AYNI MODÜLÜ birden
     fazla kaynak beslediğinde görünür — eşleştirme sorusu tam olarak o zaman
     doğar. Eskiden koşul "asas-orders VE ias-warehouse bağlı mı" diye
     yazılıydı; üçüncü bir veritabanı bu satırı görünmez bırakırdı. */
  function matchRuleRow() {
    if (matchRuleOpen) return '';
    const shared = (model.modules || []).some(module => {
      const ids = new Set((module.feeds || []).map(feed => feed.sourceId).filter(Boolean));
      return ids.size >= 2;
    });
    if (!shared) return '';
    return `<div class="dmDetailRow dmMatchRow">
      <span class="dmLabel">${esc(T('Veri eşleştirme', 'Data matching'))}</span>
      <span class="dmValue">
        ${esc(T('Aynı modülü besleyen kaynakların satırlarını hangi alanların bağladığını belirler.',
          'Decides which fields link the rows of sources that feed the same module.'))}
        <button type="button" class="dmInlineLink" data-open-matchrule>${esc(T('kuralları aç', 'open rules'))}</button>
      </span>
    </div>`;
  }

  function openMatchRule() {
    matchRuleOpen = true;
    render();
    const slot = root.querySelector('[data-matchrule-slot]');
    if (!slot) { matchRuleOpen = false; return; }
    void window.BLDataMatchRule?.open?.(slot, {
      canManage: model.canManage,
      onClosed: () => { matchRuleOpen = false; render(); },
    });
  }

  function render() {
    if (!root) return;

    if (loading && !model) {
      root.innerHTML = `<div class="empty">${esc(T('Veri Yönetimi yükleniyor…', 'Loading Data Management…'))}</div>`;
      return;
    }
    if (loadError) {
      root.innerHTML = `<div class="dmError">
        <p>${esc(loadError)}</p>
        <button type="button" class="tbtn" data-retry>${esc(T('Yeniden dene', 'Retry'))}</button>
      </div>`;
      return;
    }
    if (!model) return;

    const summary = model.summary;
    const unsupported = model.support && model.support.supported === false;

    root.innerHTML = `
      <div class="dmHead">
        <div>
          <h2 class="dmTitle">Corporate Integration Lab</h2>
          <p class="dmSub">${esc(T('Tüm entegrasyonları tek platformda, gerçek kanıtlarla tanıla ve yönet.', 'Diagnose and manage every integration on one platform with real evidence.'))}</p>
        </div>
        <div class="dmHeadActions">
          <button type="button" class="tbtn" data-reload><svg class="ic"><use href="#i-refresh"/></svg>${esc(T('Tazele', 'Reload'))}</button>
          ${model.canManage ? `<button type="button" class="navActionBtn" data-add-source>+ ${esc(T('Database Ekle', 'Add Database'))}</button>` : ''}
        </div>
      </div>
      <div class="dmWizardSlot" data-wizard-slot></div>

      ${labPanel()}

      ${unsupported ? `<div class="dmNotice">${esc(T('Veri modeli sorguları yalnız Windows üzerinde çalışır; bu makinede bağlantı sınanamaz.', 'Data-model queries run on Windows only; connections cannot be tested on this machine.'))}</div>` : ''}
      ${(model.warnings || []).map(text => `<div class="dmNotice dmNotice--warn">${esc(text)}</div>`).join('')}

      ${sourceModePanel()}

      <div class="dmSectionLabel">${esc(T('Bağlantı ve yapılandırma', 'Connections and configuration'))}</div>
      <div class="dmSources">${model.sources.map(sourceCard).join('')}</div>
      ${expandedSourceId && model.sources.some(source => source.id === expandedSourceId)
        ? sourceDetail(model.sources.find(source => source.id === expandedSourceId)) : ''}

      ${matchRuleRow()}
      <div class="dmMatchSlot" data-matchrule-slot></div>

      <div class="dmPanel">
        <div class="dmPanelHead">
          <span class="dmPanelTitle">${esc(T('Modüller', 'Modules'))}</span>
          <div class="dmViewToggle" role="group" aria-label="${esc(T('Görünüm', 'View'))}">
            <button type="button" class="dmViewBtn${view === 'list' ? ' isActive' : ''}" data-view="list" aria-pressed="${view === 'list'}">${esc(T('Liste', 'List'))}</button>
            <button type="button" class="dmViewBtn${view === 'matrix' ? ' isActive' : ''}" data-view="matrix" aria-pressed="${view === 'matrix'}">${esc(T('Matris', 'Matrix'))}</button>
          </div>
        </div>
        ${view === 'list'
          ? `<div class="dmModules">${model.modules.map(moduleRow).join('')}</div>`
          : matrixTable()}

        ${model.localModules.length ? `<div class="dmLocalNote">
          <span class="dmLabel">${esc(T('Kaynak beslemeyen modüller', 'Modules with no source'))}</span>
          <span class="dmValue">${model.localModules.map(module =>
            `<span title="${esc((LOCAL_REASON[module.reason] || {})[en() ? 'en' : 'tr'] || '')}">${esc(module.label)}</span>`).join(' · ')}</span>
        </div>` : ''}
      </div>

      ${refreshGroupsPanel()}

      ${toolsPanel()}

      <div class="dmSummary">
        <span><strong>${summary.sourceCount}</strong> ${esc(T('kaynak', 'sources'))}</span>
        <span><strong>${summary.fedModuleCount}/${summary.totalFedModules}</strong> ${esc(T('beslenen modül', 'modules fed'))}</span>
        ${summary.problemCount ? `<span class="isWarn"><strong>${summary.problemCount}</strong> ${esc(T('sorunlu kaynak', 'sources need attention'))}</span>` : ''}
        <span class="dmSummarySpacer"></span>
        <span>${esc(T('Son yenileme', 'Last refresh'))}: <strong>${esc(shortTime(summary.lastRefreshAt))}</strong></span>
      </div>

      ${model.canManage ? '' : `<p class="dmReadOnly">${esc(T('Bu ekranı görüntüleyebilirsiniz; yapılandırmayı değiştirmek için Kaynak Veri yönetim yetkisi gerekir.', 'You can view this screen; changing the configuration requires Source Data management permission.'))}</p>`}
    `;

    /* DOM baştan kuruldu: kaynak modu ve otomatik yenileme durumunu yeniden
       uygula. Bu çağrı olmadan düğmeler doğru yerde ama HEPSİ pasif görünürdü —
       kullanıcı hangi modun seçili olduğunu göremezdi. */
    syncSourceModes();
  }

  /* ---------------------------------------------------------------- */

  /* Bağlantıyı aç/kapat. İyimser güncelleme YOK: sunucu kilitli bir hedefi
     reddedebilir ve ekranın bir an için yalan söylemesi, geri sıçrayan bir
     anahtardan farksız olurdu. İstek biter, sonra tazelenir. */
  async function toggleBinding(sourceId, moduleId, enabled) {
    const cell = `${sourceId}:${moduleId}`;
    if (busyCell) return;
    busyCell = cell;
    writeError = '';
    render();
    try {
      /* Eşzamanlılık kontrolü KAYNAK BAŞINADIR: bütün deponun revizyonu değil,
         yalnız dokunduğumuz kaynağın yapılandırma parmak izi gönderilir. Aksi
         hâlde başka bir kaynağı düzenleyen ikinci bir yönetici bizi engellerdi. */
      const source = (model.sources || []).find(entry => entry.id === sourceId);
      const response = await fetch('/api/data-management/binding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceId, moduleId, enabled,
          expectedSourceRevision: source ? source.revision : '',
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || T('Modül bağlantısı güncellenemedi.', 'Could not update the module connection.'));
      }
    } catch (error) {
      writeError = String(error && error.message || error);
    } finally {
      busyCell = '';
      await load();
      if (writeError && typeof showToast === 'function') showToast(writeError);
    }
  }

  async function saveGroups(items) {
    groupError = '';
    const response = await fetch('/api/data-management/refresh-groups', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': `"${groups.revision}"` },
      body: JSON.stringify({ items }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) throw new Error(payload.error || T('Yenileme grupları kaydedilemedi.', 'Could not save the refresh groups.'));
    groups = { ...groups, items: payload.items, revision: payload.revision };
    // Üstteki Yenile menüsü aynı grupları gösteriyor; önbelleği bayat bırakma.
    window.BLInvalidateRefreshGroups?.(payload.items);
  }

  function readDraftName() {
    const field = root.querySelector('#_dmGroupName');
    if (field) groupDraft.name = field.value;
  }

  async function runLabInspector(sourceId, traceValue = '') {
    if (!sourceId || labBusy) return;
    labBusy = 'inspect';
    labMessage = '';
    render();
    try {
      const response = await fetch('/api/data-management/integration-lab/inspect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId, traceValue, liveProbe: true, language: en() ? 'en' : 'tr' }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.error || T('Tanı tamamlanamadı.', 'Diagnostic could not complete.'));
      selectedLabSourceId = sourceId;
      lab.environment = payload.environment || lab.environment;
      lab.inspectors = (lab.inspectors || []).filter(item => item.sourceId !== sourceId).concat(payload.inspector);
      lab.selectedInspector = payload.inspector;
      labMessage = payload.probe && payload.probe.ok
        ? T('Canlı bağlantı doğrulandı.', 'Live connection verified.')
        : T(`Canlı bağlantı doğrulanamadı: ${payload.probe && payload.probe.error || 'bilinmeyen hata'}`, `Live connection could not be verified: ${payload.probe && payload.probe.error || 'unknown error'}`);
    } catch (error) {
      labMessage = String(error && error.message || error);
    } finally {
      labBusy = '';
      render();
    }
  }

  async function runTroyDryRun(recipeId) {
    if (!recipeId || labBusy) return;
    labBusy = 'automation';
    labMessage = '';
    automationPreview = null;
    render();
    try {
      // Corporate Integration Lab deliberately calls PREVIEW only. The /run
      // endpoint is not reachable from this screen.
      const response = await fetch(`/api/automations/recipes/${encodeURIComponent(recipeId)}/preview`, { method: 'POST' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.error || T('Dry run tamamlanamadı.', 'Dry run could not complete.'));
      automationPreview = payload.preview || {};
      labMessage = T('Dry run tamamlandı; son işlem uygulanmadı.', 'Dry run completed; no final action was applied.');
    } catch (error) {
      labMessage = String(error && error.message || error);
    } finally {
      labBusy = '';
      render();
    }
  }

  async function exportAiDiagnostic(format) {
    try {
      const kind = format === 'text' ? 'text' : 'json';
      const response = await fetch(`/api/data-management/integration-lab/diagnostic?format=${kind}`, { cache: 'no-store' });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || T('Tanı paketi oluşturulamadı.', 'Diagnostic package could not be created.'));
      }
      const blob = await response.blob();
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = `buyer-log-integration-diagnostic.${kind === 'text' ? 'txt' : 'json'}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(href);
      labMessage = T('Gizli bilgiler maskelenmiş AI tanı paketi indirildi.', 'Redacted AI diagnostic package downloaded.');
    } catch (error) {
      labMessage = String(error && error.message || error);
    }
    render();
  }

  function onClick(event) {
    const labTabButton = event.target.closest('[data-lab-tab]');
    if (labTabButton) { labTab = labTabButton.dataset.labTab; labMessage = ''; render(); return; }

    const inspect = event.target.closest('[data-lab-inspect]');
    if (inspect) { selectedLabSourceId = inspect.dataset.labInspect; labTab = 'inspector'; render(); return; }

    const automation = event.target.closest('[data-lab-automation]');
    if (automation) { selectedAutomationId = automation.dataset.labAutomation; labTab = 'automation'; render(); return; }

    const runInspector = event.target.closest('[data-lab-run-inspector]');
    if (runInspector) {
      const trace = root.querySelector('[data-lab-trace]');
      void runLabInspector(selectedLabSourceId, trace ? trace.value : '');
      return;
    }

    const dryRun = event.target.closest('[data-lab-dry-run]');
    if (dryRun) { void runTroyDryRun(dryRun.dataset.labDryRun); return; }

    const diagnostic = event.target.closest('[data-lab-ai-export]');
    if (diagnostic) { void exportAiDiagnostic(diagnostic.dataset.labAiExport); return; }

    const addSource = event.target.closest('[data-add-source]');
    if (addSource) {
      const slot = root.querySelector('[data-wizard-slot]');
      if (!slot) return;
      const labels = {};
      for (const module of model.modules || []) labels[module.id] = module.label;
      void window.BLDataSourceWizard?.open?.(slot, {
        moduleLabels: labels,
        onDone: warnings => {
          if (warnings && warnings.length && typeof showToast === 'function') showToast(warnings.join(' '));
          void load();
        },
      });
      return;
    }

    /* --- Yenileme grupları --- */
    const newGroup = event.target.closest('[data-new-group]');
    if (newGroup) { creatingGroup = true; groupDraft = { name: '', moduleIds: [] }; groupError = ''; render(); return; }

    const cancelGroup = event.target.closest('[data-cancel-group]');
    if (cancelGroup) { creatingGroup = false; groupError = ''; render(); return; }

    const saveGroup = event.target.closest('[data-save-group]');
    if (saveGroup) {
      readDraftName();
      if (!groupDraft.name.trim()) { groupError = T('Gruba bir ad ver.', 'Give the group a name.'); render(); return; }
      if (!groupDraft.moduleIds.length) { groupError = T('En az bir modül seç.', 'Select at least one module.'); render(); return; }
      void (async () => {
        try {
          await saveGroups([...groups.items, { name: groupDraft.name.trim(), moduleIds: groupDraft.moduleIds }]);
          creatingGroup = false;
          groupDraft = { name: '', moduleIds: [] };
        } catch (error) { groupError = String(error && error.message || error); }
        render();
      })();
      return;
    }

    const deleteGroup = event.target.closest('[data-delete-group]');
    if (deleteGroup) {
      const id = deleteGroup.dataset.deleteGroup;
      void (async () => {
        try { await saveGroups(groups.items.filter(entry => entry.id !== id)); }
        catch (error) { if (typeof showToast === 'function') showToast(String(error && error.message || error)); }
        render();
      })();
      return;
    }

    const runGroup = event.target.closest('[data-run-group]');
    if (runGroup) {
      const group = groups.items.find(entry => entry.id === runGroup.dataset.runGroup);
      if (!group) return;
      /* İKİNCİ BİR YENİLEME MOTORU YOK. Mevcut akış (iş kuyruğu, aşama paneli,
         iptal, filtre-gerekli uyarısı) olduğu gibi kullanılır; grup yalnız
         hedef listesini verir. */
      if (typeof window.loadFromServer !== 'function') {
        if (typeof showToast === 'function') showToast(T('Yenileme akışı henüz hazır değil.', 'The refresh flow is not ready yet.'));
        return;
      }
      if (window.BL_REFRESH_BUSY) { if (typeof showToast === 'function') showToast(T('Bir yenileme zaten sürüyor.', 'A refresh is already running.')); return; }
      void Promise.resolve(window.loadFromServer(true, group.moduleIds)).then(() => load());
      return;
    }

    const toggle = event.target.closest('[data-toggle]');
    if (toggle) {
      const [sourceId, moduleId] = String(toggle.dataset.toggle).split(':');
      void toggleBinding(sourceId, moduleId, toggle.dataset.next === 'on');
      return;
    }

    const retry = event.target.closest('[data-retry], [data-reload]');
    if (retry) { void load(); return; }

    const viewBtn = event.target.closest('[data-view]');
    if (viewBtn) { view = viewBtn.dataset.view === 'matrix' ? 'matrix' : 'list'; render(); return; }

    /* Silme, kart açma/kapamadan ÖNCE yakalanır. Düğme ayrıntı panelinde
       (kartın kardeşi) duruyor, ama sıra tersine dönerse silme tıklaması
       sessizce kartı katlamaya dönüşürdü. */
    const deleteSourceBtn = event.target.closest('[data-delete-source]');
    if (deleteSourceBtn) { void deleteSource(deleteSourceBtn.dataset.deleteSource); return; }

    const card = event.target.closest('[data-source]');
    if (card) {
      expandedSourceId = expandedSourceId === card.dataset.source ? '' : card.dataset.source;
      render();
      return;
    }

    /* Düzenleme henüz bu ekranda değil. Kullanıcıyı boş bir forma değil,
       BUGÜN ÇALIŞAN editöre götürüyoruz. P3'te bu çağrılar yerel editörle
       değiştirilecek; kullanıcı akışı o güne kadar kırılmaz. */
    const dbTestBtn = event.target.closest('[data-test-database]');
    if (dbTestBtn) { void testDatabaseSource(dbTestBtn.dataset.testDatabase); return; }

    const connBtn = event.target.closest('[data-open-connection]');
    if (connBtn) { openConnectionEditor(connBtn.dataset.openConnection); return; }

    /* Kaynak modu düğmeleri. Setter'lar app-main.js'te; burada yalnız hangi
       grubun tıklandığı çözülüp o gruba ait setter çağrılıyor. */
    for (const group of SOURCE_MODES) {
      const btn = event.target.closest(`#${group.id} [${group.attr}]`);
      if (!btn) continue;
      if (!model.canManage || btn.disabled) return;
      try { void group.set(btn.getAttribute(group.attr)); }
      catch (error) { if (typeof showToast === 'function') showToast(String(error && error.message || error)); }
      return;
    }

    const toolBtn = event.target.closest('[data-tool]');
    if (toolBtn) { void runTool(toolBtn.dataset.tool); return; }

    const queryBtn = event.target.closest('[data-open-query]');
    if (queryBtn) { openQueryEditor(queryBtn.dataset.openQuery); return; }

    if (event.target.closest('[data-open-matchrule]')) { openMatchRule(); return; }

    const cpCols = event.target.closest('[data-open-cpcolumns]');
    if (cpCols) { openCpColumnsEditor(cpCols.dataset.openCpcolumns); return; }

    const mapping = event.target.closest('[data-open-mapping]');
    if (mapping) { openMappingEditor(mapping.dataset.openMapping); return; }

    const legacy = event.target.closest('[data-open-legacy]');
    if (legacy) {
      window.openDataSourceAndFilters?.({ connectionId: legacy.dataset.openLegacy });
      return;
    }
    const clearLayer = event.target.closest('[data-clear-layer]');
    if (clearLayer) {
      const [moduleId, sourceId] = String(clearLayer.dataset.clearLayer).split(':');
      void clearPersonalLayer(moduleId, sourceId);
      return;
    }
    const filter = event.target.closest('[data-open-filter]');
    if (filter) {
      const [moduleId, sourceId] = String(filter.dataset.openFilter).split(':');
      openFilterEditor(moduleId, sourceId);
    }
  }

  /* KİŞİSEL KATMANI KALDIR.

     'Kişisel' rozeti iki farklı kaydı temsil edebilir: yalnız bu modül için
     tanımlanmış bir ufuk ya da TÜM modüller için tanımlanmış kişisel
     varsayılan. İkincisi başka ekranları da değiştireceği için ayrıca sorulur;
     kullanıcı sadece bir satırı düzeltmek isterken bütün ayarını kaybetmemeli. */
  /* Kişisel Horizon kaydının TARAYICIDAKİ kopyasını da unutur.

     Sunucudaki kayıt silinir ama localStorage aynası kalırsa, açılıştaki
     birleştirme onu "sunucuda eksik" sanıp geri gönderir ve kaldırılan katman
     dirilir. Sunucu artık silmeyi zaman damgasıyla kaydettiği için bir sonraki
     açılış zaten temizlerdi; burada AYNI OTURUM için hemen temizlenir. */
  function forgetLocalHorizonMirror(moduleName) {
    try {
      const storage = window.BLStorage;
      if (!storage || typeof storage.actualKey !== 'function' || !storage.native) return;
      const module = String(moduleName || 'default').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'default';
      storage.native.removeItem(storage.actualKey(`buyerlog.workspace.horizon.${module}.v1`));
    } catch (_) { /* depolama kapalı olabilir; sunucu kaydı zaten kesindir */ }
  }

  async function clearPersonalLayer(moduleId, sourceId) {
    const module = (model.modules || []).find(entry => entry.id === moduleId);
    const feed = module && module.feeds.find(entry => entry.sourceId === sourceId);
    if (!feed || !feed.layerRemovable) return;

    if (feed.layerKey === 'personalDefault') {
      const ok = typeof confirm === 'function' && confirm(T(
        'Bu ayar tek bir modülün değil, TÜM modüllerin kişisel varsayılanı. Kaldırılırsa hepsi ortak filtreye döner. Devam edilsin mi?',
        'This is your personal default for ALL modules, not just this one. Removing it returns them all to the shared filter. Continue?'));
      if (!ok) return;
    }

    try {
      const response = await fetch('/api/data-management/layer', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ moduleId, layerKey: feed.layerKey }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.error || T('Kişisel katman kaldırılamadı.', 'Could not remove the personal layer.'));
      forgetLocalHorizonMirror(feed.layerKey === 'personalDefault' ? 'default' : moduleId);
      if (typeof showToast === 'function') {
        showToast(T('Kişisel ayar kaldırıldı; ortak filtre yeniden geçerli.', 'Personal setting removed; the shared filter is in effect again.'));
      }
      await load();
    } catch (error) {
      if (typeof showToast === 'function') showToast(String(error && error.message || error));
    }
  }

  /* Eşleme düzenleyicisi. Kaydetmeden sonra ekran baştan çizildiği için
     düzenleyici YENİDEN AÇILIR — aynı işlev, taze yuva ve taze veriyle.
     Şema önbellekli olduğundan bu ikinci bir sorgu üretmez. */
  function openMappingEditor(sourceId, mappingRepair = null) {
    const source = (model.sources || []).find(entry => entry.id === sourceId);
    if (!source) return;
    const baseProblems = (source.mapping && source.mapping.problems) || [];
    const repair = mappingRepair
      && mappingRepair.kind === 'field-mapping'
      && String(mappingRepair.sourceId || '') === String(sourceId)
      && String(mappingRepair.header || '').trim()
      ? mappingRepair : null;
    /* Canlı DAX hatası şema değişikliğini kanıtlar. mappingHealth yalnız
       saklanmış eşlemeye baktığı için bu alan normalde "sorunsuz" görünebilir;
       onarım akışında hatalı alanı zorla listenin başına ekliyoruz. */
    const repairProblem = repair ? {
      header: String(repair.header),
      status: 'unmapped',
      required: true,
      identity: false,
      column: String(repair.column || ''),
      table: String(repair.table || ''),
      expected: Array.isArray(repair.expected) ? repair.expected : [String(repair.header)],
    } : null;
    const problems = repairProblem
      ? [repairProblem, ...baseProblems.filter(problem => String(problem && problem.header || '') !== repairProblem.header)]
      : baseProblems;
    if (!problems.length) {
      mappingEditorSourceId = '';
      render();
      if (typeof showToast === 'function') {
        showToast(T('Gözden geçirilecek alan kalmadı.', 'No fields left to review.'));
      }
      return;
    }
    /* Düzenleyici KAYNAĞIN KENDİ ayrıntısında açılır — ekranın tepesinde değil.
       Düzenlenen şey o kaynağa ait; uzakta bir panelde açmak, kullanıcının
       hangi kaynağı düzenlediğini takip etmesini zorlaştırırdı. */
    expandedSourceId = sourceId;
    mappingEditorSourceId = sourceId;
    render();
    const slot = root.querySelector(`[data-mapping-slot="${CSS.escape(sourceId)}"]`);
    if (!slot) { mappingEditorSourceId = ''; return; }
    void window.BLDataMappingEditor?.open?.(slot, {
      sourceId: source.id,
      sourceName: source.name,
      server: source.connection.server,
      catalog: source.connection.catalog,
      revision: source.revision,
      problems,
      onSaved: async (warnings, saved) => {
        await load();
        const repairedTarget = repair && saved && String(saved.header || '') === String(repair.header || '');
        if (repairedTarget) {
          mappingEditorSourceId = '';
          render();
          if (warnings && warnings.length && typeof showToast === 'function') showToast(warnings.join(' '));
          if (typeof showToast === 'function') {
            showToast(T('Eşleme kaydedildi; yenileme yeniden deneniyor.', 'Mapping saved; retrying the refresh.'));
          }
          if (typeof window.BLRetryRefreshAfterFieldMapping === 'function') {
            void window.BLRetryRefreshAfterFieldMapping(repair);
          }
          return;
        }
        openMappingEditor(sourceId, repair);
      },
      onClosed: () => { mappingEditorSourceId = ''; render(); },
    });
  }

  /* CP sütunları düzenleyicisi — eşleme düzenleyicisiyle aynı sözleşme:
     kaynağın kendi ayrıntısında açılır, kaydettikten sonra ekran tazelenip
     düzenleyici TAZE YUVAYA yeniden açılır (öksüz düğüme yazmamak için). */
  function openCpColumnsEditor(sourceId) {
    const source = (model.sources || []).find(entry => entry.id === sourceId);
    if (!source || !model.canManage) return;
    if (!(source.capabilities || []).includes('extra-columns')) return;

    expandedSourceId = sourceId;
    cpColumnsSourceId = sourceId;
    render();
    const slot = root.querySelector(`[data-cpcolumns-slot="${CSS.escape(sourceId)}"]`);
    if (!slot) { cpColumnsSourceId = ''; return; }
    void window.BLDataCpColumns?.open?.(slot, {
      sourceId: source.id,
      sourceName: source.name,
      server: source.connection.server,
      catalog: source.connection.catalog,
      revision: source.revision,
      columns: source.cpColumns || [],
      onSaved: async () => { await load(); openCpColumnsEditor(sourceId); },
      onClosed: () => { cpColumnsSourceId = ''; render(); },
    });
  }

  /* Filtre düzenleyici satırın ALTINDA açılır. Eskiden buradaki tıklama
     1.619 satırlık eski modalı açıyordu; artık ortak filtre bu ekranda
     düzenlenir. Kişisel Horizon hâlâ sayfa rozetinden yönetilir. */
  function openFilterEditor(moduleId, sourceId) {
    const module = (model.modules || []).find(entry => entry.id === moduleId);
    const feed = module && module.feeds.find(entry => entry.sourceId === sourceId);
    const source = (model.sources || []).find(entry => entry.id === sourceId);
    if (!module || !feed || !source) return;

    if (!model.canManage) {
      if (typeof showToast === 'function') {
        showToast(T('Ortak filtreyi değiştirmek için Kaynak Veri yönetim yetkisi gerekir.',
          'Changing the shared filter requires Source Data management permission.'));
      }
      return;
    }
    /* EZEN KATMAN ARTIK ÇIKMAZ DEĞİL.

       Eskiden burada "önce onu kaldırın" denip düzenleyici hiç açılmıyordu.
       Uyarı doğruydu — kişisel/ön ayar katmanı varken ortak filtreyi
       değiştirmek kullanıcının gördüğünü değiştirmez — ama kaldırılacak yer
       BAŞKA BİR EKRANDI ve kullanıcı orada bırakılıyordu. Artık düzenleyici
       açılır, hangi katmanın kazandığını söyler ve kaldırılabiliyorsa
       kaldırma düğmesini yanında taşır. */
    const layerNote = feed.layer !== 'source' ? {
      layer: feed.layer,
      label: (LAYER[feed.layer] || {})[en() ? 'en' : 'tr'] || feed.layer,
      text: feed.filterText || '',
      removable: Boolean(feed.layerRemovable),
      onClear: feed.layerRemovable ? () => clearPersonalLayer(moduleId, sourceId) : null,
    } : null;

    const rowIndex = model.modules.findIndex(entry => entry.id === moduleId);
    const slot = root.querySelectorAll('[data-filter-slot]')[rowIndex];
    if (!slot) return;

    void window.BLDataFilterEditor?.open?.(slot, {
      sourceId, sourceName: feed.sourceName,
      /* v7.81 — ASAS→IAS eşleme teklifi. Bu modülü besleyen BAŞKA bir
         rolde, KOŞUL İÇEREN bir kaynak varsa düzenleyici "oradan eşle"
         teklifi gösterebilir. Teklif yoksa düğme de çıkmaz — boş bir
         düğme, kullanıcıya olmayan bir yetenek vaat ederdi. */
      mapFrom: (() => {
        const mine = feed.sourceRole || '';
        const other = module.feeds.find(entry => entry
          && entry.sourceId !== sourceId
          && entry.sourceRole && entry.sourceRole !== mine
          && entry.conditionCount > 0);
        return other && mine ? { role: other.sourceRole, name: other.sourceName, toRole: mine } : null;
      })(),
      moduleId, moduleLabel: module.label,
      revision: source.revision,
      /* Ezen katman varken ekrandaki ad/tanım o katmanın; DÜZENLENEN ise ortak
         katmandır. Bu yüzden düzenleyiciye ortak olanın adı ve tanımı verilir —
         yoksa kullanıcı kişisel ufkunu ortak filtrenin üstüne yazardı. */
      filterName: layerNote ? (feed.sharedFilterName || '') : feed.filterName,
      definition: feed.definition || {},
      sharedWith: (feed.sharedModuleIds || []),
      layerNote,
      labelOf: id => {
        const found = (model.modules || []).find(entry => entry.id === id);
        return found ? found.label : id;
      },
      onSaved: warnings => {
        if (warnings && warnings.length && typeof showToast === 'function') showToast(warnings.join(' '));
        void load();
      },
    });
  }

  /* ---------------------------------------------------------------- */

  /* Onay kutuları render'ı tetiklemez: her tıkta yeniden çizmek yazılmakta olan
     ad alanının imlecini kaybettiriyordu. Taslak sessizce güncellenir. */
  function onChange(event) {
    /* Otomatik yenileme. Değer ve zamanlayıcı app-main.js'te yaşıyor;
       burada yalnız seçim iletiliyor — ikinci bir zamanlayıcı yazmak iki ayrı
       yenileme turu demek olurdu (§9). */
    if (event.target && event.target.id === 'autoRefreshSelect') {
      if (!model.canManage || typeof setAutoRefreshMinutes !== 'function') return;
      const value = setAutoRefreshMinutes(event.target.value);
      if (typeof showToast === 'function') {
        showToast(value
          ? T(`Otomatik yenileme ${value} dakikada bir olarak ayarlandı.`, `Auto refresh set to every ${value} minutes.`)
          : T('Otomatik yenileme kapatıldı.', 'Auto refresh turned off.'));
      }
      syncSourceModes();
      return;
    }
    const source = event.target.closest('[data-lab-source]');
    if (source) { selectedLabSourceId = source.value; labMessage = ''; render(); return; }
    const recipe = event.target.closest('[data-lab-recipe]');
    if (recipe) { selectedAutomationId = recipe.value; automationPreview = null; labMessage = ''; render(); return; }
    const box = event.target.closest('[data-draft-module]');
    if (!box) return;
    const moduleId = box.dataset.draftModule;
    groupDraft.moduleIds = box.checked
      ? [...new Set([...groupDraft.moduleIds, moduleId])]
      : groupDraft.moduleIds.filter(entry => entry !== moduleId);
  }

  function mount(host) {
    if (!host) return;
    if (root !== host) {
      root = host;
      root.addEventListener('click', onClick);
      root.addEventListener('change', onChange);
      root.addEventListener('input', event => {
        if (event.target && event.target.id === '_dmGroupName') groupDraft.name = event.target.value;
      });
    }
    // Sekmeye her dönüşte tazelenir: başka bir ekrandan yapılan bir bağlantı
    // değişikliği burada bayat görünmemeli.
    void load();
  }

  /* Bir modül satırına odaklan. Sayfa rozetindeki "Yönet" buraya getirir;
     kullanıcı hangi satıra bakacağını aramak zorunda kalmamalı. */
  function focusModule(moduleId) {
    const wanted = String(moduleId || '').trim();
    if (!wanted || !root) return;
    const apply = () => {
      if (!model) return;
      // Matris görünümünde modül SATIRI yoktur; odaklanma listede anlamlı.
      if (view !== 'list') { view = 'list'; render(); }
      const index = model.modules.findIndex(entry => entry.id === wanted);
      const row = index >= 0 ? root.querySelectorAll('.dmModuleRow')[index] : null;
      if (!row) return;
      row.classList.add('isFocused');
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      // Vurgu kalıcı değil: satır bulunduktan sonra ekran normale döner.
      setTimeout(() => row.classList.remove('isFocused'), 2600);
    };
    // Yükleme sürüyorsa ONA katıl; ikinci bir istek başlatma.
    if (model && !loadPromise) apply();
    else void load().then(apply);
  }

  /* Bir KAYNAK kartına odaklan. "Şu bağlantıyı düzenle" / "şu kaynağın
     eşlemesini düzelt" diyen dış çağrılar buraya gelir; kullanıcı doğru kartı
     kart şeridinde aramak zorunda kalmamalı. */
  function focusSource(sourceId, options = {}) {
    const wanted = String(sourceId || '').trim();
    if (!wanted || !root) return;
    const apply = () => {
      if (!model || !model.sources.some(entry => entry.id === wanted)) return;
      expandedSourceId = wanted;
      render();
      if (options.openMapping) { openMappingEditor(wanted, options.mappingRepair || null); return; }
      const card = root.querySelector(`[data-source="${CSS.escape(wanted)}"]`);
      if (card) card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    };
    if (model && !loadPromise) apply();
    else void load().then(apply);
  }

  window.BLDataManagement = { mount, reload: load, focusModule, focusSource };
})();
