(function(){
  'use strict';
  const STORAGE_KEY='lcw.lfl.filters.v5';
  const READY_FILTERS_KEY='lcw.lfl.readyFilters.v1';
  const CUSTOM_COMPARE_KEY='lcw.lfl.customCompare.v4';
  const ANALYSIS_SPLIT_KEY='lcw.lfl.analysisSplit.v1';
  const ANALYSIS_HEIGHTS_KEY='lcw.lfl.analysisHeights.v1';
  const LEGACY_CUSTOM_COMPARE_KEYS=['lcw.lfl.customCompare.v3','lcw.lfl.customCompare.v2','lcw.lfl.customCompare.v1'];
  const LEGACY_STORAGE_KEYS=['lcw.lfl.filters.v4','lcw.lfl.filters.v3','lcw.lfl.filters.v2','lcw.lfl.filters.v1'];
  const MAX_BREAKDOWN_LEVELS=6;
  const MONTH_NAMES=['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];
  const MONTH_NAMES_EN=['January','February','March','April','May','June','July','August','September','October','November','December'];
  // In-Store ayi satirlarda YYYYAA kodu olarak tutulur (202602 = Şubat 2026). Kirilim
  // olarak kullanildiginda ham kod yerine okunur ay adi gosterilir.
  function monthCodeLabel(value){
    const raw=String(value==null?'':value).trim();
    const m=/^(\d{4})(\d{2})$/.exec(raw)||/^(\d{4})-(\d{2})$/.exec(raw);
    if(!m)return raw;
    const idx=Number(m[2])-1;
    if(idx<0||idx>11)return raw;
    return `${(isEn()?MONTH_NAMES_EN:MONTH_NAMES)[idx]} ${m[1]}`;
  }
  const DATE_FIELD_META=Object.freeze({
    inStore:{label:'In-Store',dateKey:'inStore',periodKey:'inStoreMonth'},
    opd:{label:'OPD',dateKey:'opd',periodKey:'opdMonth'},
    retailDate:{label:'Retail Date',dateKey:'retailDate',periodKey:'retailDateMonth'},
  });
  const DATE_FIELDS=Object.keys(DATE_FIELD_META);
  const FILTER_META={
    currentMonth:{label:'Güncel In-Store',allLabel:'tüm aylar',rowKey:'inStoreMonth',month:true,seasonControl:'lflCurrentSeason'},
    compareMonth:{label:'Kıyas In-Store',allLabel:'tüm aylar',rowKey:'inStoreMonth',month:true,seasonControl:'lflCompareSeason'},
    country:{label:'Ülke',allLabel:'hepsi',rowKey:'country'},
    mag:{label:'MAG',allLabel:'hepsi',rowKey:'mag'},
    mmyg:{label:'MMYG',allLabel:'hepsi',rowKey:'mmyg'},
    brandDirectorate:{label:'Marka Müdürlükleri',allLabel:'hepsi',rowKey:'brandDirectorate'},
    classification:{label:'Klasman',allLabel:'hepsi',rowKey:'classification'},
    productDescription:{label:'Ürün Tanım',labelEn:'Product Description',allLabel:'hepsi',rowKey:'productDescription'},
    manufacturer:{label:'Üretici',allLabel:'hepsi',rowKey:'manufacturer'},
    buyingGroup:{label:'Buying Group',allLabel:'hepsi',rowKey:'buyingGroup'},
    buyer:{label:'Buyer',allLabel:'hepsi',rowKey:'buyer'},
    fabricCategory:{label:'Kumaş Kategorisi',allLabel:'hepsi',rowKey:'fabricCategory'},
    fabricSupplierCountry:{label:'Kumaşçı Ülkesi',allLabel:'hepsi',rowKey:'fabricSupplierCountry'},
    fabricSupplier:{label:'Kumaşçı',allLabel:'hepsi',rowKey:'fabricSupplier'},
    kumasTipi:{label:'Kumaş Tipi',allLabel:'hepsi',rowKey:'kumasTipi'},
    iplikNo:{label:'İplik No',allLabel:'hepsi',rowKey:'iplikNo'},
    fabricWeight:{label:'Gramaj',allLabel:'hepsi',rowKey:'fabricWeight'},
    karisim:{label:'Karışım',allLabel:'hepsi',rowKey:'karisim'},
  };
  const FILTER_DIMS=Object.keys(FILTER_META);
  const MONTH_DIMS=['currentMonth','compareMonth'];
  const SHARED_DIMS=FILTER_DIMS.filter(k=>!MONTH_DIMS.includes(k));
  // LFL kaynağındaki sayısal ölçüler dışındaki tüm anlamlı alanlar analiz kırılımı
  // olarak kullanılabilir. Sezon, iki kıyas tarafının ana ekseni olduğu için ayrıca
  // kırılım olarak sunulmaz; aksi halde iki sezon birbirinden kopuk gruplar üretir.
  const BREAKDOWN_META={
    lflKey:{tr:'MAG · MMYG · Klasman',en:'MAG · MMYG · Classification',value:row=>[row&&row.mag,row&&row.mmyg,row&&row.classification].map(norm).filter(Boolean).join(' · ')},
    orderCode:{tr:'Sipariş Kodu',en:'Order Code',rowKey:'orderCode'},
    modelName:{tr:'Model',en:'Model',rowKey:'modelName'},
    productDescription:{tr:'Ürün Tanım',en:'Product Description',rowKey:'productDescription'},
    mag:{tr:'MAG',en:'MAG',rowKey:'mag'},
    mmyg:{tr:'MMYG',en:'MMYG',rowKey:'mmyg'},
    brandDirectorate:{tr:'Marka Müdürlükleri',en:'Brand Directorates',rowKey:'brandDirectorate'},
    classification:{tr:'Klasman',en:'Classification',rowKey:'classification'},
    inStore:{tr:'In-Store Tarihi',en:'In-Store Date',rowKey:'inStore',date:true},
    inStoreMonth:{tr:'In-Store Ayı',en:'In-Store Month',rowKey:'inStoreMonth',monthCode:true},
    inStoreWeek:{tr:'In-Store Haftası',en:'In-Store Week',rowKey:'inStoreWeek',weekCode:true},
    country:{tr:'Ülke',en:'Country',rowKey:'country'},
    buyer:{tr:'Buyer',en:'Buyer',rowKey:'buyer'},
    buyingGroup:{tr:'Buying Group',en:'Buying Group',rowKey:'buyingGroup'},
    manufacturer:{tr:'Üretici',en:'Manufacturer',rowKey:'manufacturer'},
    fabricCategory:{tr:'Kumaş Kategorisi',en:'Fabric Category',rowKey:'fabricCategory'},
    kumasTipi:{tr:'Kumaş Tipi',en:'Fabric Type',rowKey:'kumasTipi'},
    fabricWeight:{tr:'Gramaj',en:'Weight (GSM)',rowKey:'fabricWeight'},
    karisim:{tr:'Karışım',en:'Composition',rowKey:'karisim'},
    license:{tr:'Lisans',en:'License',rowKey:'license'},
    licensor:{tr:'Lisansör',en:'Licensor',rowKey:'licensor'},
    dtrType:{tr:'DTR / NON-DTR',en:'DTR / NON-DTR',value:row=>dtrTypeForRow(row)},
    line:{tr:'Line',en:'Line',rowKey:'line'},
    currency:{tr:'Para Birimi',en:'Currency',value:row=>currencyForRow(row)},
    dataType:{tr:'Veri Türü',en:'Data Type',value:row=>row&&row.isTrial?'Trial':(isEn()?'Actual':'Gerçek')},
  };
  const BREAKDOWN_DIMS=Object.keys(BREAKDOWN_META);
  const ASAS_BREAKDOWN_PREFIX='asas:';
  const ASAS_ADD_OPTION='__add_from_asas__';
  const isAsasBreakdownDim=dim=>String(dim||'').startsWith(ASAS_BREAKDOWN_PREFIX)&&String(dim).length>ASAS_BREAKDOWN_PREFIX.length;
  const isValidBreakdownDim=dim=>BREAKDOWN_DIMS.includes(dim)||isAsasBreakdownDim(dim);
  const asasHeaderFromDim=dim=>isAsasBreakdownDim(dim)?String(dim).slice(ASAS_BREAKDOWN_PREFIX.length):'';
  const asasDimFromHeader=header=>ASAS_BREAKDOWN_PREFIX+String(header||'').trim();
  // Kirilim listesi filtre alanlariyla ayni kapsama acildi: eskiden yalniz BREAKDOWN_META
  // kullanilabiliyordu, Marka Mudurlukleri ve In-Store Ayi kirilim olarak secilemiyordu.
  // In-Store Ayi eklenince "Şubat ile Mart'i kiyasla" mevcut Referans satiri mekanizmasi
  // uzerinden yapilabiliyor: iki ay secilir, biri referans isaretlenir, tablodaki
  // "Ref. ..." sutunlari digerinin ona gore farkini verir.
  const CUSTOM_COMPARE_META={
    ...BREAKDOWN_META,
    brandDirectorate:{tr:'Marka Müdürlükleri',en:'Brand Directorates',rowKey:'brandDirectorate'},
    inStoreMonth:{tr:'In-Store Ayı',en:'In-Store Month',rowKey:'inStoreMonth',monthCode:true},
    lflKey:{tr:'MAG · MMYG · Klasman',en:'MAG · MMYG · Classification',rowKey:'lflKey'},
  };
  const CUSTOM_COMPARE_DIMS=Object.keys(CUSTOM_COMPARE_META);
  const CUSTOM_COMPARE_AXIS_DIMS=[...new Set([...BREAKDOWN_DIMS,'brandDirectorate','inStoreMonth'])];
  const CUSTOM_COMPARE_SORTS=['currentQty','previousQty','qtyChange','priceChange','currentOrders','name','relativeQty','relativeOrders','relativeFob'];
  const emptyTableView=(sortKey=null,dir=1)=>({sortKey,dir,filters:{}});
  const lflAnalysisCache=(globalThis.BLAnalysisCache?.create||globalThis.BLPerf?.createBoundedCache)?.(8)||new Map();
  // Bağımsız karşılaştırma senaryoları: sekmeye her dönüşte 30k satırı yeniden süzmesin.
  const lflScenarioCache=(globalThis.BLAnalysisCache?.create||globalThis.BLPerf?.createBoundedCache)?.(24)||new Map();
  let analysisDatasetRevision=0;
  const state={
    rows:[],meta:{},source:null,loadedAt:null,initialized:false,loading:false,filtersLoaded:false,
    // LFL Trial: siparişe dönmemiş koleksiyon modelleri, sunucudan gelen GERÇEK
    // satırların yanına geçici olarak eklenir. serverRows her zaman dokunulmamış
    // gerçek veridir; trial kapatılınca rapor anında ona döner.
    serverRows:[],
    trial:{enabled:false,items:new Map(),rows:[],scope:null,pendingCorrections:new Map()},
    filters:Object.fromEntries(FILTER_DIMS.map(k=>[k,new Set()])),
    periods:{current:{dateField:'inStore'},compare:{dateField:'inStore'}},
    showFabricDetails:false,
    breakdown:['mag','mmyg','classification'],
    sort:{key:'qty',dir:-1},analysis:null,
    tableViews:{group:emptyTableView('qty',-1),manufacturer:emptyTableView('currentQty',-1),customCompare:emptyTableView('currentQty',-1),currentDetail:emptyTableView(),compareDetail:emptyTableView()},
    customCompare:{loaded:false,seeded:false,dimensions:['mag'],values:{},reference:'',sort:'priceChange',dir:1,scenarios:[],editingId:'',legacySaved:null},
  };
  function trialDisablesBrandDirectorate(){
    return !!(state.trial.enabled&&state.trial.items&&state.trial.items.size);
  }
  function enforceTrialFilterRules(){
    const disabled=trialDisablesBrandDirectorate();
    if(disabled){
      state.filters.brandDirectorate.clear();
      const panel=document.getElementById('lflDimPanel_brandDirectorate'),btn=document.getElementById('lflDimBtn_brandDirectorate');
      if(panel)panel.hidden=true;
      if(btn)btn.setAttribute('aria-expanded','false');
    }
    return disabled;
  }
  const $=id=>document.getElementById(id);
  const esc=value=>String(value==null?'':value).replace(/[&<>'"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
  const num=value=>{const n=Number(value);return Number.isFinite(n)?n:null;};
  const norm=value=>String(value==null?'':value).trim();
  const parseTableSearchTerms=globalThis.BLTableSearch.parseTerms;
  const tableSearchMatches=globalThis.BLTableSearch.matches;
  const integer=value=>{const n=num(value);return n==null?'—':Math.round(n).toLocaleString('tr-TR');};
  const pct=value=>{if(value==null||value==='')return '—';const n=num(value);return n==null?'—':(n>0?'+':'')+n.toLocaleString('tr-TR',{minimumFractionDigits:1,maximumFractionDigits:1})+'%';};
  const comparablePct=value=>value==null?'':pct(value);
  const dateTR=iso=>{if(!iso)return '—';const m=String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);return m?`${m[3]}.${m[2]}.${m[1].slice(-2)}`:iso;};
  const dateTimeShort=value=>{const d=new Date(value);if(isNaN(d))return '—';const p=n=>String(n).padStart(2,'0');return `${p(d.getDate())}.${p(d.getMonth()+1)}.${String(d.getFullYear()).slice(-2)} ${p(d.getHours())}:${p(d.getMinutes())}`;};
  const isEn=()=>typeof appLang!=='undefined'&&appLang==='en';
  const countryKey=value=>norm(value).toLocaleUpperCase('tr-TR').replace(/İ/g,'I').replace(/Ş/g,'S').replace(/Ç/g,'C').replace(/Ö/g,'O').replace(/Ü/g,'U').replace(/Ğ/g,'G').replace(/\s+/g,' ');
  const searchKey=value=>countryKey(value).replace(/[^A-Z0-9]+/g,' ').trim();
  const searchCompact=value=>searchKey(value).replace(/\s+/g,'');
  const normalizeSearchTerms=query=>{const parsed=Array.isArray(query)?query:parseTableSearchTerms(query),mapCriterion=criterion=>{const item=criterion&&typeof criterion==='object'?criterion:{mode:'exact',value:criterion};return {...item,value:searchKey(item.value).toLowerCase()};};return Array.isArray(parsed[0])?parsed.map(group=>group.map(mapCriterion)):parsed.map(mapCriterion);};
  const matchesSearch=(value,query)=>{const terms=normalizeSearchTerms(query);if(!terms.length)return true;const text=searchKey(value),groups=Array.isArray(terms[0])?terms:[terms],compactText=searchCompact(text);const compactCriterionMatches=criterion=>{const term=searchCompact(criterion.value);if(!term)return false;if(criterion.mode==='contains')return compactText.includes(term);if(criterion.mode==='notContains')return !compactText.includes(term);return compactText.includes(term);};return tableSearchMatches(text,terms,{plainMode:'contains'})||groups.every(group=>group.some(compactCriterionMatches));};
  const isTurkeyCountry=value=>['TURKIYE','TURKEY','TR'].includes(countryKey(value));
  const currencyForRow=row=>isTurkeyCountry(row&&row.country)?'TRY':'USD';
  const currencySymbol=currency=>currency==='TRY'?'₺':'$';
  const COUNTRY_CURRENCY_MAP={
    TURKEY:'TRY',TURKIYE:'TRY',TR:'TRY',CHINA:'CNY',CIN:'CNY',EGYPT:'EGP',MISIR:'EGP',
    ROMANIA:'RON',ROMANYA:'RON',UKRAINE:'UAH',UKRAYNA:'UAH',GEORGIA:'GEL',GURCISTAN:'GEL',
    INDIA:'INR',HINDISTAN:'INR',BANGLADESH:'BDT',BANGLADES:'BDT',MOROCCO:'MAD',FAS:'MAD',
    MYANMAR:'MMK',INDONESIA:'IDR',ENDONEZYA:'IDR',PAKISTAN:'PKR',CAMBODIA:'KHR',KAMBODYA:'KHR',
    VIETNAM:'VND','VIET NAM':'VND','SRI LANKA':'LKR',TUNISIA:'TND',TUNUS:'TND',BULGARIA:'BGN',BULGARISTAN:'BGN'
  };
  const COUNTRY_IDENTITY_MAP={
    TURKEY:'TR',TURKIYE:'TR',TR:'TR',INDIA:'IN',HINDISTAN:'IN',IN:'IN',CHINA:'CN',CIN:'CN',CN:'CN',
    EGYPT:'EG',MISIR:'EG',EG:'EG',ROMANIA:'RO',ROMANYA:'RO',RO:'RO',UKRAINE:'UA',UKRAYNA:'UA',UA:'UA',
    GEORGIA:'GE',GURCISTAN:'GE',GE:'GE',BANGLADESH:'BD',BANGLADES:'BD',BD:'BD',MOROCCO:'MA',FAS:'MA',MA:'MA',
    MYANMAR:'MM',BURMA:'MM',MM:'MM',INDONESIA:'ID',ENDONEZYA:'ID',ID:'ID',PAKISTAN:'PK',PK:'PK',
    CAMBODIA:'KH',KAMBODYA:'KH',KH:'KH',VIETNAM:'VN','VIET NAM':'VN',VN:'VN','SRI LANKA':'LK',SRILANKA:'LK',LK:'LK',
    TUNISIA:'TN',TUNUS:'TN',TN:'TN',BULGARIA:'BG',BULGARISTAN:'BG',BG:'BG'
  };
  const countryIdentity=value=>COUNTRY_IDENTITY_MAP[countryKey(value)]||searchCompact(value);
  const dimensionIdentity=(dim,value)=>dim==='country'?countryIdentity(value):searchCompact(value);
  let dimensionLabelIndex=Object.create(null);
  function rebuildDimensionLabelIndex(rows=state.serverRows){
    const next=Object.create(null);SHARED_DIMS.forEach(dim=>{next[dim]=new Map();});
    (rows||[]).forEach(row=>{SHARED_DIMS.forEach(dim=>{const rowKey=FILTER_META[dim]?.rowKey||dim,value=norm(row&&row[rowKey]);if(!isUsableValue(value))return;const key=dimensionIdentity(dim,value);if(key&&!next[dim].has(key))next[dim].set(key,value);});});
    dimensionLabelIndex=next;
  }
  function resolveDimensionLabel(dim,value){
    const raw=norm(value);if(!raw)return '';
    const key=dimensionIdentity(dim,raw),found=dimensionLabelIndex[dim]?.get(key);
    return found||raw;
  }
  const countryCurrency=value=>COUNTRY_CURRENCY_MAP[countryKey(value)]||null;
  const normalizeDateField=value=>DATE_FIELDS.includes(value)?value:'inStore';
  const dateFieldLabel=value=>DATE_FIELD_META[normalizeDateField(value)].label;
  const monthFromDateValue=value=>{const match=norm(value).match(/^(\d{4})-(\d{2})/);return match?`${match[1]}-${match[2]}`:'';};
  const rowPeriodMonth=(row,dateField='inStore')=>{const meta=DATE_FIELD_META[normalizeDateField(dateField)];return norm(row&&row[meta.periodKey])||monthFromDateValue(row&&row[meta.dateKey]);};
  const periodSideForDim=dim=>dim==='compareMonth'?'compare':'current';
  const dateFieldForDim=dim=>normalizeDateField(state.periods[periodSideForDim(dim)]?.dateField);
  const comparisonPeriod=side=>{const current=side!=='compare',dim=current?'currentMonth':'compareMonth',seasonControl=current?'lflCurrentSeason':'lflCompareSeason';return {season:$(seasonControl)?.value||'',dateField:normalizeDateField(state.periods[current?'current':'compare']?.dateField),selectedPeriods:new Set(state.filters[dim]||[])};};
  const syncDateFieldControls=()=>{const current=$('lflCurrentDateField'),compare=$('lflCompareDateField');if(current)current.value=normalizeDateField(state.periods.current.dateField);if(compare)compare.value=normalizeDateField(state.periods.compare.dateField);};
  const orderKey=row=>norm(row&&row.orderCode)||norm(row&&row.id);
  const ROW_META_CACHE=new WeakMap();
  function rowMeta(row){
    if(!row||typeof row!=='object')return {identities:Object.create(null),season:'',month:'',quantity:null,fob:null,valid:false,currency:'USD',order:'',model:'',groups:new Map()};
    let cached=ROW_META_CACHE.get(row);if(cached)return cached;
    const identities=Object.create(null);SHARED_DIMS.forEach(dim=>{identities[dim]=dimensionIdentity(dim,row[FILTER_META[dim].rowKey]);});
    const quantity=num(row.quantity),fob=num(row.fob);
    cached={identities,season:row.season||'',periods:Object.fromEntries(DATE_FIELDS.map(field=>[field,rowPeriodMonth(row,field)])),quantity,fob,valid:quantity>0&&fob>0,currency:currencyForRow(row),order:orderKey(row),model:countryKey(row.modelName),groups:new Map()};
    ROW_META_CACHE.set(row,cached);return cached;
  }
  function rowIdentity(row,dim){return rowMeta(row).identities[dim]||'';}
  function dtrTypeForRow(row){
    // The maintained Non-DTR manufacturer list is the only source of truth in LFL.
    // Source DTR/Licensor/License fields are deliberately ignored: list member =>
    // NON-DTR, every other manufacturer => DTR.
    return typeof window.classifyDtrByManufacturer==='function'?window.classifyDtrByManufacturer(row&&row.manufacturer):'DTR';
  }
  const money=(value,currency='USD')=>{const n=num(value);return n==null?'—':`${currencySymbol(currency)} ${n.toLocaleString('tr-TR',{minimumFractionDigits:2,maximumFractionDigits:2})}`;};
  const isUsableValue=value=>{const v=norm(value);return !!v&&!/^\(boş/i.test(v);};
  function loadSaved(){
    for(const key of [STORAGE_KEY,...LEGACY_STORAGE_KEYS]){try{const value=JSON.parse(BLStorage.getItem(key)||'{}');if(value&&Object.keys(value).length)return value;}catch(e){}}
    return {};
  }
  function saveFilters(){
    const data={currentSeason:$('lflCurrentSeason')?.value||'',compareSeason:$('lflCompareSeason')?.value||'',currentDateField:normalizeDateField(state.periods.current.dateField),compareDateField:normalizeDateField(state.periods.compare.dateField),breakdown:[...state.breakdown],showFabricDetails:!!state.showFabricDetails};
    FILTER_DIMS.forEach(dim=>{data[dim]=[...state.filters[dim]];});
    try{BLStorage.setItem(STORAGE_KEY,JSON.stringify(data));}catch(e){}
  }
  function readyLoad(){try{const v=JSON.parse(BLStorage.getItem(READY_FILTERS_KEY)||'[]');return Array.isArray(v)?v:[];}catch(e){return [];}}
  function loadCustomCompare(){
    if(state.customCompare.loaded)return;state.customCompare.loaded=true;
    try{
      let raw=BLStorage.getItem(CUSTOM_COMPARE_KEY),loadedKey=raw?CUSTOM_COMPARE_KEY:'';
      if(!raw){for(const key of LEGACY_CUSTOM_COMPARE_KEYS){raw=BLStorage.getItem(key);if(raw){loadedKey=key;break;}}}
      if(!raw)return;
      const saved=JSON.parse(raw||'{}');state.customCompare.seeded=true;let migrated=false;
      // Eski kayıtlarda bu bayrak yok; senaryo dizisi kaydedilmişse tohumlanmış sayılır.
      if(saved.scenariosSeeded===true||Array.isArray(saved.scenarios))state.customCompare.scenariosSeeded=true;
      if(Array.isArray(saved.scenarios)){
        state.customCompare.scenarios=saved.scenarios.map((item,index)=>normalizeComparisonScenario(item,index)).filter(Boolean).slice(0,12);
        if(loadedKey!==CUSTOM_COMPARE_KEY||Number(saved.version||0)<4){
          state.customCompare.scenarios.forEach(scenario=>{if(scenario.inheritGlobal)freezeScenarioScope(scenario,state.filters,true);else scenario.inheritGlobal=false;});
          migrated=true;
        }
      }else{
        state.customCompare.legacySaved=saved;
        const migratedDims=Array.isArray(saved.dimensions)?saved.dimensions:(CUSTOM_COMPARE_AXIS_DIMS.includes(saved.dimension)?[saved.dimension]:['mag']);
        state.customCompare.dimensions=[...new Set(migratedDims.filter(dim=>CUSTOM_COMPARE_AXIS_DIMS.includes(dim)))].slice(0,3);if(!state.customCompare.dimensions.length)state.customCompare.dimensions=['mag'];
        state.customCompare.values={};
        if(saved.values&&typeof saved.values==='object'&&!Array.isArray(saved.values)){
          state.customCompare.dimensions.forEach(dim=>{state.customCompare.values[dim]=new Set((Array.isArray(saved.values[dim])?saved.values[dim]:[]).filter(isUsableValue).map(String));});
        }else{
          state.customCompare.dimensions.forEach((dim,index)=>{state.customCompare.values[dim]=new Set(index===0?(Array.isArray(saved.values)?saved.values:[]).filter(isUsableValue).map(String):[]);});
        }
        state.customCompare.reference=norm(saved.reference);
      }
      if(CUSTOM_COMPARE_SORTS.includes(saved.sort)||['scope','currentFob','previousFob'].includes(saved.sort))state.customCompare.sort=saved.sort;
      if(saved.dir===1||saved.dir===-1)state.customCompare.dir=saved.dir;
      if(migrated)saveCustomCompare();
    }catch(e){}
  }
  /* ===================================================================
     v6.35 — ANALİZ IZGARASI AYIRICISI
     Classification Comparison (sol) ile Manufacturer Order Volumes (sağ)
     arasındaki çizgi sürüklenerek iki panelin yatayda kapladığı alan
     ayarlanabilir. Oran 0-1 arası tek bir sayı olarak saklanır ve iki CSS
     değişkenine yazılır; piksel saklamak pencere yeniden boyutlandığında
     bozulurdu.
     =================================================================== */
  const ANALYSIS_SPLIT_MIN=0.25, ANALYSIS_SPLIT_MAX=0.8, ANALYSIS_SPLIT_DEFAULT=0.65;
  function clampAnalysisSplit(value){
    // TUZAK: Number(null), Number('') ve Number(false) SIFIR döndürür ve
    // Number.isFinite(0) doğrudur. Ham değeri doğrudan Number'a vermek, "değer
    // yok" durumunu geçerli bir 0 oranı sayıp paneli alt sınıra yapıştırırdı.
    // Bu yüzden boşluk önce açıkça elenir.
    if(value==null||value===''||typeof value==='boolean')return ANALYSIS_SPLIT_DEFAULT;
    const n=Number(value);
    if(!Number.isFinite(n))return ANALYSIS_SPLIT_DEFAULT;
    return Math.min(ANALYSIS_SPLIT_MAX,Math.max(ANALYSIS_SPLIT_MIN,n));
  }
  function loadAnalysisSplit(){
    try{ return clampAnalysisSplit(JSON.parse(BLStorage.getItem(ANALYSIS_SPLIT_KEY)||'null')); }
    catch(e){ return ANALYSIS_SPLIT_DEFAULT; }
  }
  function applyAnalysisSplit(ratio){
    const grid=document.querySelector('.lflAnalysisGrid');
    if(!grid)return;
    const value=clampAnalysisSplit(ratio);
    grid.style.setProperty('--lfl-split',`${value}fr`);
    grid.style.setProperty('--lfl-split-right',`${1-value}fr`);
  }
  function saveAnalysisSplit(ratio){
    try{ BLStorage.setItem(ANALYSIS_SPLIT_KEY,JSON.stringify(clampAnalysisSplit(ratio))); }catch(e){}
  }
  function initAnalysisSplitter(){
    const handle=document.getElementById('lflAnalysisSplit');
    const grid=document.querySelector('.lflAnalysisGrid');
    if(!handle||!grid||handle.dataset.splitBound==='1')return;
    handle.dataset.splitBound='1';
    applyAnalysisSplit(loadAnalysisSplit());
    let dragging=false;
    const ratioFromEvent=event=>{
      const rect=grid.getBoundingClientRect();
      if(!rect.width)return null;
      // Ayırıcının kendi genişliği ve boşluklar payda dışında bırakılmaz;
      // kullanıcı çizgiyi nereye bıraktıysa oran oradan okunur.
      return clampAnalysisSplit((event.clientX-rect.left)/rect.width);
    };
    const move=event=>{
      if(!dragging)return;
      const ratio=ratioFromEvent(event);
      if(ratio!=null)applyAnalysisSplit(ratio);
      event.preventDefault();
    };
    const stop=event=>{
      if(!dragging)return;
      dragging=false;
      handle.classList.remove('isDragging');
      document.body.classList.remove('lflSplitDragging');
      const ratio=ratioFromEvent(event);
      if(ratio!=null)saveAnalysisSplit(ratio);
      window.removeEventListener('pointermove',move);
      window.removeEventListener('pointerup',stop);
      window.removeEventListener('pointercancel',stop);
    };
    handle.addEventListener('pointerdown',event=>{
      if(event.button!=null&&event.button!==0)return;
      dragging=true;
      handle.classList.add('isDragging');
      document.body.classList.add('lflSplitDragging');
      window.addEventListener('pointermove',move);
      window.addEventListener('pointerup',stop);
      window.addEventListener('pointercancel',stop);
      event.preventDefault();
    });
    // Klavye ile de ayarlanabilsin; ayırıcı yalnız fareyle erişilebilir kalmasın.
    handle.addEventListener('keydown',event=>{
      const step=event.shiftKey?0.05:0.02;
      let next=null;
      if(event.key==='ArrowLeft')next=loadAnalysisSplit()-step;
      else if(event.key==='ArrowRight')next=loadAnalysisSplit()+step;
      else if(event.key==='Home')next=ANALYSIS_SPLIT_DEFAULT;
      if(next==null)return;
      event.preventDefault();
      applyAnalysisSplit(next);saveAnalysisSplit(next);
    });
    // Çift tıklama varsayılana döndürür.
    handle.addEventListener('dblclick',()=>{applyAnalysisSplit(ANALYSIS_SPLIT_DEFAULT);saveAnalysisSplit(ANALYSIS_SPLIT_DEFAULT);});
  }
  const ANALYSIS_HEIGHT_MIN=120, ANALYSIS_HEIGHT_MAX=760;
  const ANALYSIS_HEIGHT_TARGETS={
    group:{tableId:'lflGroupTable',handleId:'lflGroupHeightHandle'},
    manufacturer:{wrapId:'lflManufacturerVolume',handleId:'lflManufacturerHeightHandle'},
  };
  function analysisHeightWrap(key){
    const meta=ANALYSIS_HEIGHT_TARGETS[key];
    if(!meta)return null;
    return meta.wrapId?$(meta.wrapId):$(meta.tableId)?.closest('.lflTableWrap')||null;
  }
  function clampAnalysisHeight(value){
    if(value==null||value===''||typeof value==='boolean')return null;
    const n=Number(value);if(!Number.isFinite(n))return null;
    const viewportMax=Math.max(ANALYSIS_HEIGHT_MIN,Math.min(ANALYSIS_HEIGHT_MAX,(window.innerHeight||900)-220));
    return Math.round(Math.min(viewportMax,Math.max(ANALYSIS_HEIGHT_MIN,n)));
  }
  function loadAnalysisHeights(){
    try{const value=JSON.parse(BLStorage.getItem(ANALYSIS_HEIGHTS_KEY)||'{}');return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}
    catch(e){return {};}
  }
  function applyAnalysisHeight(key,value){
    const wrap=analysisHeightWrap(key),meta=ANALYSIS_HEIGHT_TARGETS[key],handle=meta?$(meta.handleId):null;
    if(!wrap)return;
    const height=clampAnalysisHeight(value);
    if(height==null){
      wrap.classList.remove('lflManualHeight');wrap.style.removeProperty('--lfl-manual-height');delete wrap.dataset.lflHeight;
      handle?.removeAttribute('aria-valuenow');return;
    }
    wrap.classList.add('lflManualHeight');wrap.style.setProperty('--lfl-manual-height',`${height}px`);wrap.dataset.lflHeight=String(height);
    handle?.setAttribute('aria-valuenow',String(height));
  }
  function saveAnalysisHeight(key,value){
    const saved=loadAnalysisHeights(),height=clampAnalysisHeight(value);
    if(height==null)delete saved[key];else saved[key]=height;
    try{BLStorage.setItem(ANALYSIS_HEIGHTS_KEY,JSON.stringify(saved));}catch(e){}
  }
  function initAnalysisHeightResizers(){
    const saved=loadAnalysisHeights();
    Object.entries(ANALYSIS_HEIGHT_TARGETS).forEach(([key,meta])=>{
      const wrap=analysisHeightWrap(key),handle=$(meta.handleId);if(!wrap||!handle)return;
      applyAnalysisHeight(key,saved[key]);
      if(handle.dataset.heightBound==='1')return;
      handle.dataset.heightBound='1';
      let dragging=false,startY=0,startHeight=0,lastHeight=null;
      const move=event=>{
        if(!dragging)return;
        lastHeight=clampAnalysisHeight(startHeight+(event.clientY-startY));
        applyAnalysisHeight(key,lastHeight);event.preventDefault();
      };
      const stop=()=>{
        if(!dragging)return;
        dragging=false;handle.classList.remove('isDragging');document.body.classList.remove('lflHeightDragging');
        const current=lastHeight??clampAnalysisHeight(wrap.getBoundingClientRect().height);saveAnalysisHeight(key,current);
        window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',stop);window.removeEventListener('pointercancel',stop);
      };
      handle.addEventListener('pointerdown',event=>{
        if(event.button!=null&&event.button!==0)return;
        dragging=true;startY=event.clientY;startHeight=wrap.getBoundingClientRect().height;lastHeight=clampAnalysisHeight(startHeight);
        handle.classList.add('isDragging');document.body.classList.add('lflHeightDragging');
        window.addEventListener('pointermove',move);window.addEventListener('pointerup',stop);window.addEventListener('pointercancel',stop);
        event.preventDefault();
      });
      handle.addEventListener('keydown',event=>{
        if(event.key==='Home'){
          event.preventDefault();applyAnalysisHeight(key,null);saveAnalysisHeight(key,null);return;
        }
        if(event.key!=='ArrowUp'&&event.key!=='ArrowDown')return;
        event.preventDefault();
        const step=event.shiftKey?40:16,current=wrap.getBoundingClientRect().height;
        const next=clampAnalysisHeight(current+(event.key==='ArrowDown'?step:-step));
        applyAnalysisHeight(key,next);saveAnalysisHeight(key,next);
      });
      handle.addEventListener('dblclick',()=>{applyAnalysisHeight(key,null);saveAnalysisHeight(key,null);});
    });
  }

  function saveCustomCompare(){
    const values={};state.customCompare.dimensions.forEach(dim=>{values[dim]=[...(state.customCompare.values[dim]||new Set())];});
    const scenarios=(state.customCompare.scenarios||[]).map((item,index)=>serializeComparisonScenario(item,index));
    try{BLStorage.setItem(CUSTOM_COMPARE_KEY,JSON.stringify({version:4,scenariosSeeded:state.customCompare.scenariosSeeded===true,scenarios,dimensions:[...state.customCompare.dimensions],values,reference:state.customCompare.reference,sort:state.customCompare.sort,dir:state.customCompare.dir}));}catch(e){}
  }
  function readySave(items){try{BLStorage.setItem(READY_FILTERS_KEY,JSON.stringify(items));}catch(e){}}
  function currentFilterSnapshot(){
    const data={currentSeason:$('lflCurrentSeason')?.value||'',compareSeason:$('lflCompareSeason')?.value||'',currentDateField:normalizeDateField(state.periods.current.dateField),compareDateField:normalizeDateField(state.periods.compare.dateField),breakdown:[...state.breakdown],showFabricDetails:!!state.showFabricDetails};
    FILTER_DIMS.forEach(dim=>{data[dim]=[...state.filters[dim]];});return data;
  }
  function closeReadyPanel(){const panel=$('lflReadyFiltersPanel'),btn=$('lflReadyFiltersBtn');if(panel)panel.hidden=true;if(btn)btn.setAttribute('aria-expanded','false');}
  function applyReadyFilter(item){
    if(!item)return;const seasons=[...($('lflCurrentSeason')?.options||[])].map(o=>o.value);
    if(seasons.includes(item.currentSeason))$('lflCurrentSeason').value=item.currentSeason;
    if(seasons.includes(item.compareSeason))$('lflCompareSeason').value=item.compareSeason;
    state.periods.current.dateField=normalizeDateField(item.currentDateField);
    state.periods.compare.dateField=normalizeDateField(item.compareDateField);
    syncDateFieldControls();
    const savedBreakdown=Array.isArray(item.breakdown)?item.breakdown:(item.groupBy==='lflKey'?['mag','mmyg','classification']:[item.groupBy]);
    const valid=[...new Set(savedBreakdown.filter(isValidBreakdownDim))].slice(0,MAX_BREAKDOWN_LEVELS);if(valid.length)state.breakdown=valid;
    if(typeof item.showFabricDetails==='boolean')state.showFabricDetails=item.showFabricDetails;
    FILTER_DIMS.forEach(dim=>{state.filters[dim]=new Set((Array.isArray(item[dim])?item[dim]:[]).filter(isUsableValue).map(String));});
    pruneFilters();closePanels();closeBreakdownPanel();closeReadyPanel();saveFilters();render();
    if(window.showToast)showToast(isEn()?'Ready filter applied.':'Hazır filtre uygulandı.');
  }
  function renderReadyPanel(){
    const panel=$('lflReadyFiltersPanel');if(!panel)return;const items=readyLoad();
    panel.innerHTML=`<div class="lflReadyHead"><strong>${isEn()?'Ready Filters':'Hazır Filtreler'}</strong><button type="button" class="lflReadySave" data-ready-save><svg class="ic"><use href="#i-star"/></svg>${isEn()?'Save Current':'Mevcut Filtreyi Kaydet'}</button></div><div class="lflReadyNameEditor" data-ready-editor hidden><input class="lflReadyNameInput" data-ready-name type="text" maxlength="80" autocomplete="off" aria-label="${isEn()?'Ready filter name':'Hazır filtre adı'}" placeholder="${isEn()?'Filter name':'Filtre adı'}"><button type="button" class="lflReadyNameAction" data-ready-confirm>${isEn()?'Save':'Kaydet'}</button><button type="button" class="lflReadyNameAction" data-ready-cancel>${isEn()?'Cancel':'İptal'}</button></div><div class="lflReadyList">${items.length?items.map((item,i)=>`<div class="lflReadyItem"><button type="button" class="lflReadyApply" data-ready-apply="${i}" title="${esc(item.name)}"><span>${esc(item.name)}</span><small>${esc([item.currentSeason,item.compareSeason].filter(Boolean).join(' → '))}</small></button><button type="button" class="lflReadyDelete" data-ready-delete="${i}" title="${isEn()?'Delete':'Sil'}"><svg class="ic"><use href="#i-trash"/></svg></button></div>`).join(''):`<div class="lflReadyEmpty">${isEn()?'No saved filters yet.':'Henüz kayıtlı filtre yok.'}</div>`}</div>`;
    const editor=panel.querySelector('[data-ready-editor]'),nameInput=panel.querySelector('[data-ready-name]');
    const hideNameEditor=()=>{if(!editor)return;editor.hidden=true;if(nameInput)nameInput.value='';};
    const saveNamedFilter=()=>{
      const name=String(nameInput?.value||'').trim();
      if(!name){nameInput?.focus();if(window.showToast)showToast(isEn()?'Enter a filter name.':'Filtre adı girin.');return;}
      const all=readyLoad(),snapshot=currentFilterSnapshot(),existing=all.findIndex(x=>String(x.name).toLocaleLowerCase('tr-TR')===name.toLocaleLowerCase('tr-TR'));
      const item={name,...snapshot,updatedAt:new Date().toISOString()};if(existing>=0)all[existing]=item;else all.push(item);readySave(all);renderReadyPanel();
      if(window.showToast)showToast(isEn()?'Ready filter saved.':'Hazır filtre kaydedildi.');
    };
    panel.querySelector('[data-ready-save]')?.addEventListener('click',()=>{if(!editor||!nameInput)return;editor.hidden=false;nameInput.value='';nameInput.focus();});
    panel.querySelector('[data-ready-confirm]')?.addEventListener('click',saveNamedFilter);
    panel.querySelector('[data-ready-cancel]')?.addEventListener('click',hideNameEditor);
    nameInput?.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();saveNamedFilter();}else if(event.key==='Escape'){event.preventDefault();hideNameEditor();}});

    panel.querySelectorAll('[data-ready-apply]').forEach(btn=>btn.addEventListener('click',()=>applyReadyFilter(items[Number(btn.dataset.readyApply)])));
    panel.querySelectorAll('[data-ready-delete]').forEach(btn=>btn.addEventListener('click',()=>{const i=Number(btn.dataset.readyDelete),all=readyLoad();all.splice(i,1);readySave(all);renderReadyPanel();}));
  }
  function toggleReadyPanel(){const panel=$('lflReadyFiltersPanel'),btn=$('lflReadyFiltersBtn');if(!panel||!btn)return;const open=panel.hidden;closePanels();closeBreakdownPanel();closeCustomComparePanels();panel.hidden=!open;btn.setAttribute('aria-expanded',open?'true':'false');if(open)renderReadyPanel();}
  function seasonParts(value){return BLBusinessRules.seasonPrefixParts(value);}
  function seasonSort(a,b){return BLBusinessRules.compareSeasonPrefixThenNumber(a,b);}
  function previousSeason(current,seasons){return BLBusinessRules.previousSeasonByPrefix(current,seasons);}
  function unique(values){return [...new Set((values||[]).filter(isUsableValue))].sort((a,b)=>String(a).localeCompare(String(b),'tr',{numeric:true}));}
  function monthLabel(value){const m=norm(value).match(/^(\d{4})-(\d{2})$/);return m?`${MONTH_NAMES[Number(m[2])-1]||m[2]} ${m[1]}`:value;}
  function shiftMonth(value,amount){const m=norm(value).match(/^(\d{4})-(\d{2})$/);return m?`${Number(m[1])+amount}-${m[2]}`:value;}
  function filterMetaLabel(dim){
    if(MONTH_DIMS.includes(dim)){const prefix=dim==='currentMonth'?(isEn()?'Current':'Güncel'):(isEn()?'Comparison':'Kıyas');return `${prefix} ${dateFieldLabel(dateFieldForDim(dim))}`;}
    const meta=FILTER_META[dim]||{};return isEn()?(meta.labelEn||meta.label||dim):(meta.label||dim);
  }
  function displayFilterValue(dim,value){return FILTER_META[dim]?.month?monthLabel(value):value;}
  function fillControls(){
    const saved=loadSaved(),dims=state.meta.dimensions||{};
    // Sezon listesi sunucu meta'sı İLE mevcut satırların birleşimidir. Yalnız meta
    // kullanıldığında Trial modellerinin sezonu listede yer almıyor, kullanıcı o sezonu
    // seçemiyor ve trial satırları hiçbir zaman rapora giremiyordu.
    const seasons=unique([...(dims.seasons||[]),...state.rows.map(r=>r.season)]).sort(seasonSort);
    const current=$('lflCurrentSeason'),compare=$('lflCompareSeason'),priorCurrent=current.value||saved.currentSeason,defaultCurrent=seasons[seasons.length-1]||'';
    current.innerHTML=seasons.map(v=>`<option value="${esc(v)}">${esc(v)}</option>`).join('');
    current.value=seasons.includes(priorCurrent)?priorCurrent:defaultCurrent;
    const priorCompare=compare.value||saved.compareSeason;
    compare.innerHTML=seasons.map(v=>`<option value="${esc(v)}">${esc(v)}</option>`).join('');
    compare.value=seasons.includes(priorCompare)?priorCompare:previousSeason(current.value,seasons);
    const savedBreakdown=Array.isArray(saved.breakdown)?saved.breakdown:(saved.groupBy==='lflKey'?['mag','mmyg','classification']:(saved.groupBy?[saved.groupBy]:[]));
    const validBreakdown=[...new Set(savedBreakdown.filter(isValidBreakdownDim))].slice(0,MAX_BREAKDOWN_LEVELS);if(validBreakdown.length)state.breakdown=validBreakdown;
    if(!state.filtersLoaded){
      state.periods.current.dateField=normalizeDateField(saved.currentDateField);
      state.periods.compare.dateField=normalizeDateField(saved.compareDateField);
      state.showFabricDetails=saved.showFabricDetails===true;
      const legacyMap={classification:'classification',manufacturer:'manufacturer',buyingGroup:'buyingGroup',buyer:'buyer',mag:'mag',mmyg:'mmyg',country:'country'};
      SHARED_DIMS.forEach(dim=>{
        let vals=Array.isArray(saved[dim])?saved[dim]:[];
        if(!vals.length&&legacyMap[dim]&&Array.isArray(saved[legacyMap[dim]]))vals=saved[legacyMap[dim]];
        state.filters[dim]=new Set(vals.filter(isUsableValue).map(String));
      });
      let currentVals=Array.isArray(saved.currentMonth)?saved.currentMonth:(Array.isArray(saved.inStoreMonth)?saved.inStoreMonth:[]);
      if(!currentVals.length&&saved.dateFrom&&saved.dateTo){
        const from=String(saved.dateFrom).slice(0,7),to=String(saved.dateTo).slice(0,7);
        currentVals=unique(state.rows.filter(r=>r.season===current.value).map(r=>r.inStoreMonth)).filter(m=>m>=from&&m<=to);
      }
      state.filters.currentMonth=new Set(currentVals.filter(isUsableValue).map(String));
      let compareVals=Array.isArray(saved.compareMonth)?saved.compareMonth:[];
      if(!compareVals.length&&currentVals.length)compareVals=currentVals.map(m=>saved.shiftYear===false?m:shiftMonth(m,-1));
      state.filters.compareMonth=new Set(compareVals.filter(isUsableValue).map(String));
      state.filtersLoaded=true;
    }
    syncDateFieldControls();
    pruneFilters();
    loadCustomCompare();
    updateAllFilterButtons();
  }
  function rowsForSeason(controlId){const season=$(controlId)?.value||'';return state.rows.filter(r=>!season||r.season===season);}
  function matchesSet(value,set){return !set||!set.size||set.has(value);}
  function filterRows(rows,opts={}){
    const normalized={};
    SHARED_DIMS.forEach(dim=>{const set=opts[dim];if(set&&set.size)normalized[dim]=new Set([...set].map(value=>dimensionIdentity(dim,value)).filter(Boolean));});
    const season=opts.season||'',periods=opts.periods||opts.months,dateField=normalizeDateField(opts.dateField);
    return rows.filter(r=>{
      const meta=rowMeta(r),periodMonth=meta.periods[dateField]||'';
      if(season&&meta.season!==season)return false;
      if(!periodMonth)return false;
      if(periods&&periods.size&&!periods.has(periodMonth))return false;
      // Trial satırları gerçek LFL satırlarıyla tamamen aynı filtre zincirinden geçer.
      // Böylece yalnız aktif sezon, ay ve portföy filtreleriyle eşleşen Trial
      // modelleri analiz, kıyaslama, kırılım ve Excel çıktısına dahil edilir.
      for(const dim of SHARED_DIMS){
        // Marka Müdürlüğü bilgisi Koleksiyon aşamasında henüz kesinleşmemiş olabilir.
        // Trial açıkken bu boyut analiz kapsamını daraltmaz; gerçek ve Trial satırları
        // diğer aktif LFL filtrelerinden normal biçimde geçmeye devam eder.
        if(dim==='brandDirectorate'&&trialDisablesBrandDirectorate())continue;
        const set=normalized[dim];if(!set||!set.size)continue;
        if(!set.has(meta.identities[dim]))return false;
      }
      return true;
    });
  }
  function sharedFilterOpts(excludeDim=''){
    const opts={};SHARED_DIMS.forEach(key=>{opts[key]=key===excludeDim?new Set():state.filters[key];});return opts;
  }
  function mergeFacetRows(primary,extra){
    const rows=[...(primary||[])],seen=new Set(rows);
    (extra||[]).forEach(row=>{if(row&&!seen.has(row)){seen.add(row);rows.push(row);}});
    return rows;
  }
  function activeTrialRowsForFacet(dim){
    if(!state.trial.enabled||!state.trial.rows?.length||dim==='compareMonth')return [];
    // Trial sentetik olarak yalnız güncel döneme eklenir. Filtre seçenekleri
    // hesaplanırken aktif diğer filtreler Trial satırını dışarıda bıraksa bile
    // Trial'dan gelen ay ve portföy değerleri seçilebilir kalmalıdır. Böylece
    // örneğin gerçek veride yalnız Şubat/Mart varken Trial Nisan modeli de
    // Güncel In-Store listesinde görünür ve kullanıcı onu analize dahil edebilir.
    const currentSeason=$('lflCurrentSeason')?.value||'',dateField=dateFieldForDim(dim);
    return state.trial.rows.filter(row=>(!currentSeason||row.season===currentSeason)&&!!rowPeriodMonth(row,dateField));
  }
  function rowsForFacet(dim){
    let rows;
    if(MONTH_DIMS.includes(dim)){
      const meta=FILTER_META[dim],season=$(meta.seasonControl)?.value||'',dateField=dateFieldForDim(dim);
      rows=filterRows(state.rows,{season,dateField,periods:new Set(),...sharedFilterOpts()});
    }else{
      const shared=sharedFilterOpts(dim),currentRows=filterRows(state.rows,{season:$('lflCurrentSeason')?.value||'',dateField:normalizeDateField(state.periods.current.dateField),periods:state.filters.currentMonth,...shared}),compareRows=filterRows(state.rows,{season:$('lflCompareSeason')?.value||'',dateField:normalizeDateField(state.periods.compare.dateField),periods:state.filters.compareMonth,...shared});
      rows=[...currentRows,...compareRows];
    }
    return mergeFacetRows(rows,activeTrialRowsForFacet(dim));
  }
  function facetValues(dim){
    const available=unique(rowsForFacet(dim).map(r=>MONTH_DIMS.includes(dim)?rowPeriodMonth(r,dateFieldForDim(dim)):r[FILTER_META[dim].rowKey]).filter(isUsableValue)),selected=[...state.filters[dim]].filter(isUsableValue);
    return unique([...selected,...available]);
  }
  function pruneFilters(){
    // Filtre seçimini görünen etikete değil kanonik kimliğe göre koru.
    // Böylece Bangladesh / Bangladeş gibi aynı ülkenin farklı kaynak etiketleri
    // Trial satırı eklendiğinde veya veri yenilendiğinde birbirini düşürmez.
    SHARED_DIMS.forEach(dim=>{const all=new Set(state.rows.map(r=>dimensionIdentity(dim,r[FILTER_META[dim].rowKey])).filter(Boolean));state.filters[dim]=new Set([...state.filters[dim]].filter(v=>all.has(dimensionIdentity(dim,v))));});
    MONTH_DIMS.forEach(dim=>{const side=periodSideForDim(dim),season=$(side==='current'?'lflCurrentSeason':'lflCompareSeason')?.value||'',dateField=dateFieldForDim(dim),available=new Set(state.rows.filter(r=>!season||r.season===season).map(r=>rowPeriodMonth(r,dateField)).filter(isUsableValue));state.filters[dim]=new Set([...state.filters[dim]].filter(v=>/^\d{4}-\d{2}$/.test(v)&&available.has(v)));});
  }
  function filterButtonText(dim){
    const meta=FILTER_META[dim],set=state.filters[dim];
    // Boş seçim bu filtrede "Hepsi" anlamına gelir. Bu durumda ek bir durum
    // metni veya rozet göstermeyerek butonu yalnız filtre adıyla bırak.
    const label=filterMetaLabel(dim);
    if(!set.size)return label;
    if(set.size===1)return `${label}: ${displayFilterValue(dim,[...set][0])}`;
    return `${label}: ${set.size} ${isEn()?'selected':'seçili'}`;
  }
  function updateFilterButton(dim){
    const btn=$(`lflDimBtn_${dim}`);if(!btn)return;
    const trialDisabled=dim==='brandDirectorate'&&trialDisablesBrandDirectorate();
    if(trialDisabled)state.filters.brandDirectorate.clear();
    const set=state.filters[dim],count=btn.querySelector('.lflDimCount'),text=btn.querySelector('.lflDimText');
    if(text)text.textContent=filterButtonText(dim);
    btn.classList.toggle('hasFilter',!trialDisabled&&set.size>0);
    btn.classList.toggle('isTrialDisabled',trialDisabled);
    btn.disabled=trialDisabled;
    btn.setAttribute('aria-disabled',trialDisabled?'true':'false');
    btn.title=trialDisabled
      ?(isEn()?'Brand Directorate filtering is disabled while LFL Trial is active.':'LFL Trial aktifken Marka Müdürlükleri filtresi uygulanmaz.')
      :'';
    if(count){count.hidden=trialDisabled||!set.size;count.textContent=trialDisabled?'':(set.size||'');}
  }
  function weekCodeLabel(value){
    const raw=norm(value),match=/^(\d{4})-(\d{2})$/.exec(raw);if(!match)return raw;
    return isEn()?`${match[1]} · Week ${Number(match[2])}`:`${match[1]} · ${Number(match[2])}. Hafta`;
  }
  function breakdownValue(row,dim){
    if(isAsasBreakdownDim(dim)){const header=asasHeaderFromDim(dim),bag=row&&row._asas;const value=bag&&Object.prototype.hasOwnProperty.call(bag,header)?bag[header]:(row&&row[header]);return isUsableValue(value)?String(value):(isEn()?'(Blank)':'(Boş)');}
    const meta=BREAKDOWN_META[dim]||{rowKey:dim};let value=typeof meta.value==='function'?meta.value(row):row&&row[meta.rowKey||dim];
    if(meta.monthCode)value=monthCodeLabel(value);else if(meta.weekCode)value=weekCodeLabel(value);else if(meta.date)value=dateTR(value);else value=norm(value);
    return isUsableValue(value)?String(value):(isEn()?'(Blank)':'(Boş)');
  }
  function breakdownDimLabel(dim){if(isAsasBreakdownDim(dim))return asasHeaderFromDim(dim);const meta=BREAKDOWN_META[dim]||{tr:dim,en:dim};return isEn()?meta.en:meta.tr;}
  function breakdownLabel(dimensions=state.breakdown){return (dimensions||[]).map(breakdownDimLabel).join(' · ')||(isEn()?'Select breakdown':'Kırılım seç');}
  function updateBreakdownButton(){const text=$('lflBreakdownText'),btn=$('lflBreakdownBtn');if(text)text.textContent=breakdownLabel();if(btn)btn.classList.toggle('hasSelection',state.breakdown.length>0);}
  function updateAllFilterButtons(){FILTER_DIMS.forEach(updateFilterButton);updateBreakdownButton();}
  function closeBreakdownPanel(){const panel=$('lflBreakdownPanel'),btn=$('lflBreakdownBtn');if(panel)panel.hidden=true;if(btn)btn.setAttribute('aria-expanded','false');}
  function loadedAsasHeaders(){
    const set=new Set();(state.serverRows||[]).forEach(row=>{if(row&&row._asas&&typeof row._asas==='object')Object.keys(row._asas).forEach(key=>{if(String(key||'').trim())set.add(String(key).trim());});});
    return [...set].sort((a,b)=>a.localeCompare(b,'tr-TR',{numeric:true,sensitivity:'base'}));
  }
  function connectionFeedsLfl(item){
    if(!item||item.role!=='asas')return false;
    const scopes=Array.isArray(item.scopes)?item.scopes:[];
    return !scopes.length||scopes.some(scope=>scope&&scope.enabled!==false&&Array.isArray(scope.targets)&&scope.targets.includes('lfl'));
  }
  async function openAsasBreakdownPicker(slotIndex){
    document.getElementById('_lflAsasBreakdownPicker')?.remove();
    const modal=document.createElement('div');modal.id='_lflAsasBreakdownPicker';modal.className='warnOverlay';
    modal.innerHTML=`<div class="modalCard" role="dialog" aria-modal="true" style="width:min(94vw,760px);max-height:86vh;display:flex;flex-direction:column;padding:0"><div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:16px 18px;border-bottom:1px solid var(--line)"><div><div class="modalTitle">${isEn()?'Add From ASAS':'ASAS’tan Ekle'}</div><p style="margin:4px 0 0;color:var(--muted);font-size:11px">${isEn()?'Choose an ASAS database column to use as an LFL analysis breakdown. If it is not in the current query, Buyer Log adds it to the LFL model mapping and refreshes LFL once.':'LFL analiz kırılımında kullanmak istediğiniz ASAS veritabanı başlığını seçin. Alan mevcut sorguda yoksa Buyer Log LFL model eşlemesine ekler ve LFL’yi bir kez yeniler.'}</p></div><button type="button" class="pricingRuleIconBtn" data-asas-close><svg class="ic"><use href="#i-x"/></svg></button></div><div style="padding:12px 18px;display:flex;gap:8px"><input type="search" data-asas-search placeholder="${isEn()?'Search table or column…':'Tablo veya sütun ara…'}" style="flex:1"><span data-asas-status style="align-self:center;color:var(--muted);font-size:11px">${isEn()?'Loading ASAS schema…':'ASAS şeması yükleniyor…'}</span></div><div data-asas-list style="overflow:auto;padding:0 18px 18px;display:grid;gap:6px;min-height:180px"></div></div>`;
    document.body.appendChild(modal);const list=modal.querySelector('[data-asas-list]'),status=modal.querySelector('[data-asas-status]'),search=modal.querySelector('[data-asas-search]');
    const close=()=>modal.remove();modal.querySelectorAll('[data-asas-close]').forEach(btn=>btn.addEventListener('click',close));modal.addEventListener('click',e=>{if(e.target===modal)close();});modal.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();close();}});
    let connection=null,items=[],revision=0,entries=[],schemaWritable=false;
    const loadedHeaders=new Set(loadedAsasHeaders());
    try{
      const res=await fetch('/api/model-connections'),data=await res.json().catch(()=>({}));if(!res.ok)throw new Error(data.error||res.statusText);items=Array.isArray(data.items)?data.items:[];revision=Number(data.revision)||0;connection=items.find(connectionFeedsLfl)||items.find(item=>item&&item.role==='asas')||null;
      if(connection){
        const schemaRes=await fetch('/api/model-connections/schema',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({server:connection.server,catalog:connection.catalog})});const schema=await schemaRes.json().catch(()=>({}));
        if(schemaRes.ok){entries=(Array.isArray(schema.columns)?schema.columns:[]).filter(x=>x&&x.name).map(x=>({table:String(x.table||''),name:String(x.name||''),kind:'column'}));schemaWritable=true;}else throw new Error(schema.error||schemaRes.statusText);
      }
    }catch(err){schemaWritable=false;entries=[...loadedHeaders].map(name=>({table:'',name,kind:'column',loadedOnly:true}));status.textContent=isEn()?'Schema permission unavailable — showing fields already loaded from ASAS.':'Şema yetkisi kullanılamıyor — ASAS’tan zaten yüklenmiş alanlar gösteriliyor.';}
    if(!entries.length){entries=[...loadedHeaders].map(name=>({table:'',name,kind:'column',loadedOnly:true}));}
    const unique=new Map();entries.forEach(entry=>{const k=`${entry.table}\u0001${entry.name}`;if(!unique.has(k))unique.set(k,entry);});entries=[...unique.values()].sort((a,b)=>(a.table||'').localeCompare(b.table||'','tr-TR')||a.name.localeCompare(b.name,'tr-TR',{numeric:true}));
    const renderList=()=>{const q=String(search.value||'').trim().toLocaleUpperCase('tr-TR'),shown=entries.filter(entry=>!q||`${entry.table} ${entry.name}`.toLocaleUpperCase('tr-TR').includes(q));list.innerHTML=shown.length?shown.map((entry,index)=>`<button type="button" class="lflAsasFieldChoice" data-asas-entry="${entries.indexOf(entry)}"><strong>${esc(entry.name)}</strong><span>${esc(entry.table|| (isEn()?'Loaded ASAS field':'Yüklü ASAS alanı'))}</span>${loadedHeaders.has(entry.name)?`<em>${isEn()?'Loaded':'Yüklü'}</em>`:''}</button>`).join(''):`<div class="lflDimNoResult">${isEn()?'No matching ASAS column.':'Eşleşen ASAS sütunu bulunamadı.'}</div>`;list.querySelectorAll('[data-asas-entry]').forEach(btn=>btn.addEventListener('click',()=>choose(entries[Number(btn.dataset.asasEntry)])));};
    async function choose(entry){
      if(!entry)return;const header=String(entry.name||'').trim();if(!header)return;status.textContent=isEn()?'Adding field…':'Alan ekleniyor…';
      try{
        if(!loadedHeaders.has(header)&&schemaWritable&&connection){
          const connIndex=items.findIndex(item=>item&&item.id===connection.id);if(connIndex<0)throw new Error(isEn()?'ASAS connection not found.':'ASAS bağlantısı bulunamadı.');
          const copy=JSON.parse(JSON.stringify(items[connIndex]));copy.mapping=copy.mapping&&typeof copy.mapping==='object'?copy.mapping:{};copy.customFields=Array.isArray(copy.customFields)?copy.customFields:[];
          let outputHeader=header;const existing=copy.mapping[outputHeader];if(existing&&String(existing.name||existing)!==header)outputHeader=`${entry.table||'ASAS'} · ${header}`;
          copy.mapping[outputHeader]={table:entry.table,name:header,kind:'column'};if(!copy.customFields.some(f=>f&&f.header===outputHeader))copy.customFields.push({header:outputHeader,custom:true});items[connIndex]=copy;
          const saveRes=await fetch('/api/model-connections',{method:'PUT',headers:{'Content-Type':'application/json','If-Match':String(revision)},body:JSON.stringify({items})});const saved=await saveRes.json().catch(()=>({}));if(!saveRes.ok)throw new Error(saved.error||saveRes.statusText);
          state.breakdown[slotIndex]=asasDimFromHeader(outputHeader);state.breakdown=[...new Set(state.breakdown.filter(isValidBreakdownDim))].slice(0,MAX_BREAKDOWN_LEVELS);saveFilters();close();await load(true);return;
        }
        state.breakdown[slotIndex]=asasDimFromHeader(header);state.breakdown=[...new Set(state.breakdown.filter(isValidBreakdownDim))].slice(0,MAX_BREAKDOWN_LEVELS);state.tableViews.group.filters={};saveFilters();close();render();renderBreakdownPanel();
      }catch(err){status.textContent=(isEn()?'Could not add field: ':'Alan eklenemedi: ')+(err.message||String(err));}
    }
    search.addEventListener('input',renderList);if(schemaWritable)status.textContent=isEn()?`${entries.length} ASAS columns`:`${entries.length} ASAS sütunu`;renderList();setTimeout(()=>search.focus(),0);
  }
  function renderBreakdownPanel(){
    const panel=$('lflBreakdownPanel');if(!panel)return;
    const knownDynamic=[...new Set(state.breakdown.filter(isAsasBreakdownDim))];
    const allDims=[...BREAKDOWN_DIMS,...knownDynamic];
    const moveBreakdown=(from,to)=>{
      if(from===to||from<0||to<0||from>=state.breakdown.length||to>=state.breakdown.length)return;
      const next=[...state.breakdown],item=next.splice(from,1)[0];next.splice(to,0,item);state.breakdown=next;
      state.tableViews.group.filters={};saveFilters();render();renderBreakdownPanel();
    };
    const slots=Array.from({length:MAX_BREAKDOWN_LEVELS},(_,index)=>{
      const current=state.breakdown[index]||'',used=new Set(state.breakdown.filter((_,i)=>i!==index)),options=allDims.filter(dim=>dim===current||!used.has(dim));
      const controls=current?`<span class="lflBreakdownOrder"><button type="button" data-breakdown-up="${index}" ${index===0?'disabled':''} title="${isEn()?'Move up':'Yukarı taşı'}" aria-label="${isEn()?'Move breakdown up':'Kırılımı yukarı taşı'}">↑</button><button type="button" data-breakdown-down="${index}" ${index>=state.breakdown.length-1?'disabled':''} title="${isEn()?'Move down':'Aşağı taşı'}" aria-label="${isEn()?'Move breakdown down':'Kırılımı aşağı taşı'}">↓</button><span class="lflBreakdownGrip" aria-hidden="true">☰</span></span>`:'';
      return `<label class="lflBreakdownSlot" draggable="${current?'true':'false'}" data-breakdown-drag="${index}"><span>${isEn()?`Level ${index+1}`:`${index+1}. kırılım`}${controls}</span><select data-breakdown-slot="${index}"><option value="">${index===0?(isEn()?'Select…':'Seç…'):(isEn()?'No additional level':'Ek kırılım yok')}</option>${options.map(dim=>`<option value="${esc(dim)}"${dim===current?' selected':''}>${esc(breakdownDimLabel(dim))}</option>`).join('')}<option value="${ASAS_ADD_OPTION}">＋ ${isEn()?'Add From ASAS…':'ASAS’tan Ekle…'}</option></select></label>`;
    }).join('');
    panel.innerHTML=`<div class="lflBreakdownPanelHead"><div><strong>${isEn()?'Analysis Breakdown':'Analiz Kırılımı'}</strong><span>${isEn()?'Choose up to six nested levels and reorder them.':'En fazla altı alt kırılım seç ve sıralamasını düzenle.'}</span></div><button type="button" class="lflPanelClear" data-breakdown-reset>${isEn()?'Default':'Varsayılan'}</button></div><div class="lflBreakdownSlots">${slots}</div>`;
    panel.querySelectorAll('[data-breakdown-slot]').forEach(select=>select.addEventListener('change',async()=>{const index=Number(select.dataset.breakdownSlot);if(select.value===ASAS_ADD_OPTION){select.value=state.breakdown[index]||'';await openAsasBreakdownPicker(index);return;}const values=[...panel.querySelectorAll('[data-breakdown-slot]')].map(el=>el.value).filter(isValidBreakdownDim);state.breakdown=[...new Set(values)].slice(0,MAX_BREAKDOWN_LEVELS);if(!state.breakdown.length)state.breakdown=['mag'];state.tableViews.group.filters={};saveFilters();render();renderBreakdownPanel();}));
    panel.querySelectorAll('[data-breakdown-up]').forEach(btn=>btn.addEventListener('click',event=>{event.preventDefault();moveBreakdown(Number(btn.dataset.breakdownUp),Number(btn.dataset.breakdownUp)-1);}));
    panel.querySelectorAll('[data-breakdown-down]').forEach(btn=>btn.addEventListener('click',event=>{event.preventDefault();moveBreakdown(Number(btn.dataset.breakdownDown),Number(btn.dataset.breakdownDown)+1);}));
    let dragFrom=-1;
    panel.querySelectorAll('[data-breakdown-drag]').forEach(slot=>{
      slot.addEventListener('dragstart',event=>{dragFrom=Number(slot.dataset.breakdownDrag);if(!state.breakdown[dragFrom]){event.preventDefault();return;}event.dataTransfer.effectAllowed='move';slot.classList.add('isDragging');});
      slot.addEventListener('dragover',event=>{if(dragFrom<0)return;event.preventDefault();event.dataTransfer.dropEffect='move';slot.classList.add('isDragOver');});
      slot.addEventListener('dragleave',()=>slot.classList.remove('isDragOver'));
      slot.addEventListener('drop',event=>{event.preventDefault();slot.classList.remove('isDragOver');const to=Number(slot.dataset.breakdownDrag);if(to>=0&&to<state.breakdown.length)moveBreakdown(dragFrom,to);dragFrom=-1;});
      slot.addEventListener('dragend',()=>{dragFrom=-1;panel.querySelectorAll('.isDragging,.isDragOver').forEach(el=>el.classList.remove('isDragging','isDragOver'));});
    });
    panel.querySelector('[data-breakdown-reset]')?.addEventListener('click',()=>{state.breakdown=['mag','mmyg','classification'];state.tableViews.group.filters={};saveFilters();render();renderBreakdownPanel();});
  }
  function toggleBreakdownPanel(){const panel=$('lflBreakdownPanel'),btn=$('lflBreakdownBtn');if(!panel||!btn)return;const open=panel.hidden;closePanels();closeReadyPanel();closeCustomComparePanels();panel.hidden=!open;btn.setAttribute('aria-expanded',open?'true':'false');if(open)renderBreakdownPanel();}
  function closePanels(exceptDim=''){
    FILTER_DIMS.forEach(dim=>{if(dim===exceptDim)return;const panel=$(`lflDimPanel_${dim}`),btn=$(`lflDimBtn_${dim}`);if(panel)panel.hidden=true;if(btn)btn.setAttribute('aria-expanded','false');});
  }
  function renderFacetPanel(dim){
    const panel=$(`lflDimPanel_${dim}`);if(!panel)return;const values=facetValues(dim),selected=state.filters[dim],rows=rowsForFacet(dim),key=FILTER_META[dim].rowKey,counts=new Map();
    rows.forEach(r=>{const value=MONTH_DIMS.includes(dim)?rowPeriodMonth(r,dateFieldForDim(dim)):r[key];if(isUsableValue(value))counts.set(value,(counts.get(value)||0)+1);});
    panel.innerHTML=`<div class="lflDimPanelHead"><div><strong>${esc(filterMetaLabel(dim))}</strong><span>${selected.size?selected.size+' '+(isEn()?'selected':'seçim'):(isEn()?'All':'Tümü')}</span></div><button type="button" class="lflPanelClear"${selected.size?'':' disabled'}>${isEn()?'Clear':'Temizle'}</button></div><div class="lflDimSearchWrap"><input type="search" class="lflDimSearch" placeholder="${isEn()?'Search…':'Ara…'}" autocomplete="off"></div><div class="lflDimList"><label class="lflDimOption lflDimAll${selected.size?'':' isSelected'}"><input type="checkbox" class="lflDimAllCheck"${selected.size?'':' checked'}><span>${isEn()?'All':'Hepsi'}</span><em>${integer(rows.length)}</em></label>${values.map(value=>`<label class="lflDimOption${selected.has(value)?' isSelected':''}" data-search="${esc(displayFilterValue(dim,value))}"><input type="checkbox" class="lflDimCheck" value="${esc(value)}"${selected.has(value)?' checked':''}><span>${esc(displayFilterValue(dim,value))}</span><em>${integer(counts.get(value)||0)}</em></label>`).join('')||`<div class="lflDimNoResult">${isEn()?'No selectable values.':'Seçilebilir değer bulunamadı.'}</div>`}</div>`;
    const rerender=()=>{updateFilterButton(dim);saveFilters();render();renderFacetPanel(dim);};
    panel.querySelector('.lflPanelClear')?.addEventListener('click',()=>{state.filters[dim].clear();rerender();});
    panel.querySelector('.lflDimAllCheck')?.addEventListener('change',()=>{state.filters[dim].clear();rerender();});
    panel.querySelectorAll('.lflDimCheck').forEach(chk=>chk.addEventListener('change',()=>{if(chk.checked)state.filters[dim].add(chk.value);else state.filters[dim].delete(chk.value);rerender();}));
    panel.querySelector('.lflDimSearch')?.addEventListener('input',e=>{const terms=normalizeSearchTerms(e.target.value);let visible=0;panel.querySelectorAll('.lflDimOption[data-search]').forEach(row=>{const match=matchesSearch(row.dataset.search,terms);row.hidden=!match;if(match)visible++;});let empty=panel.querySelector('.lflDimSearchEmpty');if(!empty){empty=document.createElement('div');empty.className='lflDimNoResult lflDimSearchEmpty';empty.textContent=isEn()?'No option matches this search.':'Aramayla eşleşen seçenek yok.';panel.querySelector('.lflDimList')?.appendChild(empty);}empty.hidden=visible>0;});
  }
  function openFacet(dim){
    const panel=$(`lflDimPanel_${dim}`),btn=$(`lflDimBtn_${dim}`);if(!panel||!btn)return;
    if(dim==='brandDirectorate'&&trialDisablesBrandDirectorate()){panel.hidden=true;btn.setAttribute('aria-expanded','false');return;}
    const willOpen=panel.hidden;closePanels(willOpen?dim:'');closeBreakdownPanel();closeCustomComparePanels();
    panel.hidden=!willOpen;btn.setAttribute('aria-expanded',willOpen?'true':'false');if(willOpen){renderFacetPanel(dim);setTimeout(()=>panel.querySelector('.lflDimSearch')?.focus(),0);}
  }
  function currencyBucket(rows,currency){
    let qty=0,weighted=0;const orders=new Set();
    rows.forEach(r=>{if(currencyForRow(r)!==currency)return;const q=num(r.quantity),p=num(r.fob);if(!(q>0)||!(p>0))return;qty+=q;weighted+=q*p;orders.add(r.orderCode||r.id);});
    return {currency,avg:qty>0?weighted/qty:null,qty,weighted,orders:orders.size};
  }
  function summary(rows){
    const byCurrency={},orders=new Set(),models=new Set(),orderTypes=new Map();let validRows=0,totalQty=0;
    for(const row of rows||[]){
      const meta=rowMeta(row);if(!meta.valid)continue;validRows++;totalQty+=meta.quantity;
      let bucket=byCurrency[meta.currency];if(!bucket)bucket=byCurrency[meta.currency]={currency:meta.currency,avg:null,qty:0,weighted:0,orders:0,_orders:new Set()};
      bucket.qty+=meta.quantity;bucket.weighted+=meta.quantity*meta.fob;if(meta.order)bucket._orders.add(meta.order);
      if(meta.order){orders.add(meta.order);const type=dtrTypeForRow(row),previous=orderTypes.get(meta.order);orderTypes.set(meta.order,previous==='NON-DTR'||type==='NON-DTR'?'NON-DTR':'DTR');}
      if(meta.model)models.add(meta.model);
    }
    Object.values(byCurrency).forEach(bucket=>{bucket.avg=bucket.qty>0?bucket.weighted/bucket.qty:null;bucket.orders=bucket._orders.size;delete bucket._orders;});
    const currencies=Object.keys(byCurrency);let dtr=0,nonDtr=0;orderTypes.forEach(type=>{if(type==='NON-DTR')nonDtr++;else dtr++;});
    return {avg:currencies.length===1?byCurrency[currencies[0]].avg:null,qty:totalQty,orders:orders.size,models:models.size,rows:validRows,byCurrency,currencies,dtrOrders:{dtr,nonDtr,unknown:0},hasDtrBreakdown:orders.size>0};
  }
  function moneySummary(sum){
    if(!sum||!sum.currencies||!sum.currencies.length)return '—';
    return ['TRY','USD'].filter(c=>sum.byCurrency[c]).map(c=>money(sum.byCurrency[c].avg,c)).join(' · ');
  }
  function metricBetween(current,reference,type='change'){
    if(!current||!reference)return null;let weighted=0,totalQty=0;
    for(const currency of ['TRY','USD']){
      const c=current.byCurrency[currency],r=reference.byCurrency[currency];if(!c||!r||!(c.avg>0)||!(r.avg>0)||!(c.qty>0))continue;
      const value=type==='improvement'?(r.avg-c.avg)/r.avg*100:(c.avg-r.avg)/r.avg*100;weighted+=value*c.qty;totalQty+=c.qty;
    }
    return totalQty?weighted/totalQty:null;
  }
  function comparablePeriodRows(currentRows,referenceRows,groupBy=state.breakdown){
    const dims=Array.isArray(groupBy)?groupBy.filter(Boolean):[],pairKey=row=>{
      const meta=rowMeta(row);if(!meta.valid)return '';
      const group=dims.length?groupValue(row,dims):'__all__';
      return group?`${group}\u0001${meta.currency}`:'';
    };
    const currentKeys=new Set((currentRows||[]).map(pairKey).filter(Boolean)),referenceKeys=new Set((referenceRows||[]).map(pairKey).filter(Boolean));
    const sharedKeys=new Set([...currentKeys].filter(key=>referenceKeys.has(key)));
    return {
      currentRows:(currentRows||[]).filter(row=>sharedKeys.has(pairKey(row))),
      referenceRows:(referenceRows||[]).filter(row=>sharedKeys.has(pairKey(row))),
      sharedKeys,
    };
  }
  function comparableMetricBetweenRows(currentRows,referenceRows,groupBy=state.breakdown,type='change'){
    const comparable=comparablePeriodRows(currentRows,referenceRows,groupBy);
    return metricBetween(summary(comparable.currentRows),summary(comparable.referenceRows),type);
  }
  function comparisonScenarioId(){return `cmp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`;}
  function normalizeScenarioMonth(value){const raw=norm(value);const compact=/^(\d{4})(\d{2})$/.exec(raw);return compact?`${compact[1]}-${compact[2]}`:raw;}
  function scenarioMonthLabel(value){return monthLabel(normalizeScenarioMonth(value));}
  function scenarioDateField(value,fallback='inStore'){const raw=norm(value);return DATE_FIELDS.includes(raw)?raw:normalizeDateField(fallback);}
  function normalizeComparisonScenario(item={},index=0){
    const filters={};SHARED_DIMS.forEach(dim=>{const values=item.filters&&Array.isArray(item.filters[dim])?item.filters[dim]:[];filters[dim]=[...new Set(values.filter(isUsableValue).map(String))];});
    const currentDateField=DATE_FIELDS.includes(norm(item.currentDateField))?norm(item.currentDateField):'',compareDateField=DATE_FIELDS.includes(norm(item.compareDateField))?norm(item.compareDateField):'';
    return {id:norm(item.id)||comparisonScenarioId(),name:norm(item.name)||(isEn()?`Comparison ${index+1}`:`Karşılaştırma ${index+1}`),currentSeason:norm(item.currentSeason),compareSeason:norm(item.compareSeason),currentDateField,compareDateField,currentMonths:[...new Set((Array.isArray(item.currentMonths)?item.currentMonths:[]).map(normalizeScenarioMonth).filter(v=>/^\d{4}-\d{2}$/.test(v)))].sort(),compareMonths:[...new Set((Array.isArray(item.compareMonths)?item.compareMonths:[]).map(normalizeScenarioMonth).filter(v=>/^\d{4}-\d{2}$/.test(v)))].sort(),filters,inheritGlobal:item.inheritGlobal===true};
  }
  function globalScenarioFilterValues(globalFilters,dim){
    const source=globalFilters&&globalFilters[dim],values=Array.isArray(source)?source:(source&&typeof source[Symbol.iterator]==='function'?[...source]:[]);return [...new Set(values.filter(isUsableValue).map(String))];
  }
  function freezeScenarioScope(scenario,globalFilters=state.filters,onlyEmpty=true){
    if(!scenario||typeof scenario!=='object')return scenario;if(!scenario.filters||typeof scenario.filters!=='object')scenario.filters={};
    SHARED_DIMS.forEach(dim=>{const own=Array.isArray(scenario.filters[dim])?scenario.filters[dim].filter(isUsableValue).map(String):[];if(!onlyEmpty||!own.length)scenario.filters[dim]=globalScenarioFilterValues(globalFilters,dim);else scenario.filters[dim]=[...new Set(own)];});
    scenario.inheritGlobal=false;return scenario;
  }
  function serializeComparisonScenario(item,index=0){const scenario=normalizeComparisonScenario(item,index);return {...scenario,filters:Object.fromEntries(SHARED_DIMS.map(dim=>[dim,[...(scenario.filters[dim]||[])]]))};}
  function defaultComparisonScenario(index=0,a=null){
    const currentSeason=a?.currentSeason||$('lflCurrentSeason')?.value||'',compareSeason=a?.compareSeason||$('lflCompareSeason')?.value||'',filters=Object.fromEntries(SHARED_DIMS.map(dim=>[dim,globalScenarioFilterValues(state.filters,dim)]));
    return normalizeComparisonScenario({id:comparisonScenarioId(),name:isEn()?`Comparison ${index+1}`:`Karşılaştırma ${index+1}`,currentSeason,compareSeason,currentDateField:a?.currentDateField||state.periods.current.dateField,compareDateField:a?.compareDateField||state.periods.compare.dateField,currentMonths:a?[...a.currentMonths]:[...(state.filters.currentMonth||[])],compareMonths:a?[...a.compareMonths]:[...(state.filters.compareMonth||[])],filters,inheritGlobal:false},index);
  }
  function reconcileComparisonScenario(item,a){
    const scenario=normalizeComparisonScenario(item),seasons=unique((state.meta.dimensions&&state.meta.dimensions.seasons)||state.rows.map(row=>row.season)).sort(seasonSort);
    if(!seasons.includes(scenario.currentSeason))scenario.currentSeason=a?.currentSeason||seasons[seasons.length-1]||'';
    if(!seasons.includes(scenario.compareSeason))scenario.compareSeason=a?.compareSeason||previousSeason(scenario.currentSeason,seasons)||seasons[0]||'';
    const currentDateField=scenarioDateField(scenario.currentDateField,a?.currentDateField||state.periods.current.dateField),compareDateField=scenarioDateField(scenario.compareDateField,a?.compareDateField||state.periods.compare.dateField);
    scenario.currentDateField=currentDateField;scenario.compareDateField=compareDateField;
    const currentAvailable=new Set(state.rows.filter(row=>row.season===scenario.currentSeason).map(row=>normalizeScenarioMonth(rowPeriodMonth(row,currentDateField))).filter(Boolean)),compareAvailable=new Set(state.rows.filter(row=>row.season===scenario.compareSeason).map(row=>normalizeScenarioMonth(rowPeriodMonth(row,compareDateField))).filter(Boolean));
    scenario.currentMonths=scenario.currentMonths.filter(value=>currentAvailable.has(value));scenario.compareMonths=scenario.compareMonths.filter(value=>compareAvailable.has(value));return scenario;
  }
  /* v6.35 — Boş liste artık MEŞRU bir durum.
     Eskiden bu fonksiyon "dizi boşsa iki senaryo tohumla" mantığıyla çalışıyordu;
     bu yüzden son kaydı silmek imkânsızdı: silinse anında iki yenisi doğardı ve
     silme düğmesi de bu yüzden bilerek devre dışı bırakılmıştı. Artık tohumlama
     YALNIZ hiç tohumlanmamış kurulumda yapılır (scenariosSeeded), böylece
     kullanıcı listeyi tamamen boşaltabilir ve boş kalır. */
  function ensureComparisonScenarios(a){
    if(state.customCompare.scenariosSeeded && !state.customCompare.scenarios.length) return state.customCompare.scenarios;
    if(state.customCompare.scenarios.length){const before=JSON.stringify(state.customCompare.scenarios.map(serializeComparisonScenario));state.customCompare.scenarios=state.customCompare.scenarios.map(item=>reconcileComparisonScenario(item,a));if(JSON.stringify(state.customCompare.scenarios.map(serializeComparisonScenario))!==before)saveCustomCompare();return state.customCompare.scenarios;}
    const first=defaultComparisonScenario(0,a),legacy=state.customCompare.legacySaved;
    if(legacy){
      const dims=Array.isArray(legacy.dimensions)?legacy.dimensions:[];
      dims.forEach(dim=>{if(!SHARED_DIMS.includes(dim))return;const values=legacy.values&&typeof legacy.values==='object'&&!Array.isArray(legacy.values)?legacy.values[dim]:[];first.filters[dim]=[...new Set((Array.isArray(values)?values:[]).filter(isUsableValue).map(String))];});
      first.name=isEn()?'Migrated Comparison':'Aktarılan Karşılaştırma';freezeScenarioScope(first,state.filters,true);
    }
    const second=defaultComparisonScenario(1,a);state.customCompare.scenarios=[first,second];state.customCompare.legacySaved=null;state.customCompare.scenariosSeeded=true;saveCustomCompare();return state.customCompare.scenarios;
  }
  function scenarioFilterSet(scenario,dim,globalFilters=state.filters){
    const own=new Set((scenario?.filters?.[dim]||[]).filter(isUsableValue).map(String));if(own.size)return own;
    if(scenario?.inheritGlobal!==false)return new Set(globalScenarioFilterValues(globalFilters,dim));
    return new Set();
  }
  function scenarioFilterOptions(scenario,excludeDim='',globalFilters=state.filters){const opts={};SHARED_DIMS.forEach(dim=>{opts[dim]=dim===excludeDim?new Set():scenarioFilterSet(scenario,dim,globalFilters);});return opts;}
  function scenarioComparisonResult(rows,scenario,globalFilters=state.filters){
    const normalized=normalizeComparisonScenario(scenario),currentDateField=scenarioDateField(normalized.currentDateField,state.periods.current.dateField),compareDateField=scenarioDateField(normalized.compareDateField,state.periods.compare.dateField),currentMonths=new Set(normalized.currentMonths),compareMonths=new Set(normalized.compareMonths),dims=scenarioFilterOptions(normalized,'',globalFilters);
    normalized.currentDateField=currentDateField;normalized.compareDateField=compareDateField;
    const currentRows=filterRows(rows||[],{season:normalized.currentSeason,dateField:currentDateField,periods:currentMonths,...dims}),previousRows=filterRows(rows||[],{season:normalized.compareSeason,dateField:compareDateField,periods:compareMonths,...dims});
    const current=summary(currentRows),previous=summary(previousRows),currentQty=quantityTotal(currentRows),previousQty=quantityTotal(previousRows),comparable=comparablePeriodRows(currentRows,previousRows,state.breakdown),comparableCurrent=summary(comparable.currentRows),comparablePrevious=summary(comparable.referenceRows);
    return {...normalized,value:normalized.name,currentRows,previousRows,comparableCurrentRows:comparable.currentRows,comparablePreviousRows:comparable.referenceRows,current,previous,currentQty,previousQty,currentOrders:uniqueOrderCount(currentRows),previousOrders:uniqueOrderCount(previousRows),qtyChange:previousQty>0?(currentQty-previousQty)/previousQty*100:null,priceChange:metricBetween(comparableCurrent,comparablePrevious,'change'),improvement:metricBetween(comparableCurrent,comparablePrevious,'improvement')};
  }
  function scenarioPeriodLabel(season,months,dateField='inStore'){const selected=(months||[]).map(scenarioMonthLabel),field=scenarioDateField(dateField,'inStore'),fieldPart=field==='inStore'?'':dateFieldLabel(field);return [season,fieldPart,selected.length?selected.join(', '):(isEn()?'All months':'Tüm aylar')].filter(Boolean).join(' · ');}
  function scenarioScopeParts(scenario){const parts=[];SHARED_DIMS.forEach(dim=>{const values=scenario.filters?.[dim]||[];if(values.length)parts.push(`${customCompareLabel(dim)}: ${values.length<=2?values.join(', '):`${values.slice(0,2).join(', ')} +${values.length-2}`}`);});if(parts.length&&scenario.inheritGlobal!==false)parts.unshift(isEn()?'Main filters +':'Ana filtreler +');if(!parts.length)parts.push(scenario.inheritGlobal!==false?(isEn()?'Active main filters':'Aktif ana filtreler'):(isEn()?'All portfolio':'Tüm portföy'));return parts;}
  function scenarioScopeLabel(scenario){return scenarioScopeParts(scenario).join(' · ');}
  function scenarioTrialRows(scenario){
    if(!state.trial.enabled||!state.trial.rows?.length)return [];
    return state.trial.rows.filter(row=>!scenario.currentSeason||row.season===scenario.currentSeason);
  }
  function scenarioAvailableMonths(scenario,side){
    const season=side==='current'?scenario.currentSeason:scenario.compareSeason,dateField=scenarioDateField(side==='current'?scenario.currentDateField:scenario.compareDateField,state.periods[side==='current'?'current':'compare'].dateField),opts=scenarioFilterOptions(scenario);
    let rows=filterRows(state.rows,{season,dateField,periods:new Set(),...opts});
    if(side==='current')rows=mergeFacetRows(rows,scenarioTrialRows(scenario));
    return unique(rows.map(row=>normalizeScenarioMonth(rowPeriodMonth(row,dateField)))).filter(value=>/^\d{4}-\d{2}$/.test(value)).sort();
  }
  function scenarioAvailableValues(scenario,dim){
    const opts=scenarioFilterOptions(scenario,dim),currentDateField=scenarioDateField(scenario.currentDateField,state.periods.current.dateField),compareDateField=scenarioDateField(scenario.compareDateField,state.periods.compare.dateField);
    let currentRows=filterRows(state.rows,{season:scenario.currentSeason,dateField:currentDateField,periods:new Set(scenario.currentMonths||[]),...opts});
    currentRows=mergeFacetRows(currentRows,scenarioTrialRows(scenario));
    const previousRows=filterRows(state.rows,{season:scenario.compareSeason,dateField:compareDateField,periods:new Set(scenario.compareMonths||[]),...opts});
    return customCompareOptionsFromRows(currentRows,previousRows,dim);
  }
  function groupValue(row,dimensions){
    const dims=Array.isArray(dimensions)?dimensions:[dimensions],meta=rowMeta(row),cacheKey=`${isEn()?'en':'tr'}|${dims.join('|')}`;
    if(meta.groups.has(cacheKey))return meta.groups.get(cacheKey);
    const value=dims.map(dim=>breakdownValue(row,dim)).join(' · ');meta.groups.set(cacheKey,value);return value;
  }
  function lflAnalysisCacheKey(currentPeriod,comparePeriod,dims){
    const serialize=period=>({season:period.season,dateField:period.dateField,selectedPeriods:[...period.selectedPeriods].sort()});
    const key={datasetVersion:`${analysisDatasetRevision}|${state.analysisRevision||0}|${state.loadedAt||''}|${state.serverRows.length}|${state.rows.length}`,currentPeriod:serialize(currentPeriod),comparePeriod:serialize(comparePeriod),dims:Object.fromEntries(Object.entries(dims).map(([name,values])=>[name,[...(values||[])].sort()])),breakdown:[...state.breakdown]};
    return globalThis.BLAnalysisCache?.key?globalThis.BLAnalysisCache.key(key):JSON.stringify(key);
  }
  function compute(){
    const currentPeriod=comparisonPeriod('current'),comparePeriod=comparisonPeriod('compare'),currentSeason=currentPeriod.season,compareSeason=comparePeriod.season,currentMonths=currentPeriod.selectedPeriods,compareMonths=comparePeriod.selectedPeriods;
    const dims={};SHARED_DIMS.forEach(dim=>{dims[dim]=state.filters[dim];});
    const cacheKey=lflAnalysisCacheKey(currentPeriod,comparePeriod,dims),cached=lflAnalysisCache.get(cacheKey);if(cached)return cached;
    const realRows=Array.isArray(state.serverRows)?state.serverRows:[];
    const baselineCurrentRows=filterRows(realRows,{season:currentSeason,dateField:currentPeriod.dateField,periods:currentMonths,...dims});
    const compareRows=filterRows(realRows,{season:compareSeason,dateField:comparePeriod.dateField,periods:compareMonths,...dims});
    const currentRows=filterRows(state.rows,{season:currentSeason,dateField:currentPeriod.dateField,periods:currentMonths,...dims});
    const trialCurrentRows=currentRows.filter(row=>row&&row.isTrial),baselineCurrent=summary(baselineCurrentRows);
    const current=summary(currentRows),previous=summary(compareRows),groupBy=[...state.breakdown],groupMap=new Map();
    const collectGroups=(rows,side)=>{for(const row of rows){const key=groupValue(row,groupBy);if(!key)continue;let item=groupMap.get(key);if(!item){item={currentRows:[],previousRows:[]};groupMap.set(key,item);}item[side].push(row);}};
    collectGroups(currentRows,'currentRows');collectGroups(compareRows,'previousRows');
    const groups=unique([...groupMap.keys()]).map(key=>{const item=groupMap.get(key),c=summary(item.currentRows),p=summary(item.previousRows);return {key,current:c,previous:p,currentRows:item.currentRows,previousRows:item.previousRows,currentAvg:c.avg,previousAvg:p.avg,priceChange:metricBetween(c,p,'change'),improvement:metricBetween(c,p,'improvement'),qty:c.qty,orders:c.orders,rows:c.rows};}).filter(g=>g.current.currencies.length||g.previous.currencies.length);
    const comparable=comparablePeriodRows(currentRows,compareRows,groupBy),baselineComparable=comparablePeriodRows(baselineCurrentRows,compareRows,groupBy),comparableCurrent=summary(comparable.currentRows),comparablePrevious=summary(comparable.referenceRows),baselineComparableCurrent=summary(baselineComparable.currentRows),baselineComparablePrevious=summary(baselineComparable.referenceRows);
    const result={currentPeriod,comparePeriod,currentSeason,compareSeason,currentDateField:currentPeriod.dateField,compareDateField:comparePeriod.dateField,currentMonths,compareMonths,dims,currentRows,compareRows,baselineCurrentRows,trialCurrentRows,baselineCurrent,current,previous,comparableCurrentRows:comparable.currentRows,comparableCompareRows:comparable.referenceRows,baselinePriceChange:metricBetween(baselineComparableCurrent,baselineComparablePrevious,'change'),priceChange:metricBetween(comparableCurrent,comparablePrevious,'change'),improvement:metricBetween(comparableCurrent,comparablePrevious,'improvement'),groupBy,groups};
    lflAnalysisCache.set(cacheKey,result);return result;
  }
  function kpi(label,value,sub,cls=''){return `<div class="lflKpi lflCard"><div class="lflKpiLabel">${esc(label)}</div><div class="lflKpiValue ${cls}">${value}</div><div class="lflKpiSub">${esc(sub)}</div></div>`;}
  function metricClass(value,goodWhenPositive=true){if(value==null||Math.abs(value)<.05)return 'isNeutral';return (value>0)===goodWhenPositive?'isGood':'isBad';}
  function priceDeltaClass(value){if(value==null||Math.abs(value)<.05)return 'isNeutral';return value<0?'isGood':'isBad';}
  function tablePriceClass(value){if(value==null||Math.abs(value)<.05)return 'muted';return value<0?'good':'bad';}
  function monthSelectionLabel(months){return months.size?[...months].sort().map(monthLabel).join(', '):(isEn()?'All months':'Tüm aylar');}
  function comparisonColumnHeader(period,metric){
    const base=`${period?.season||''} ${metric||''}`.trim(),selected=[...(period?.selectedPeriods||[])].map(monthLabel);
    return selected.length?[base,...selected].join('\n'):base;
  }
  function dtrScopeText(sum){if(!sum||!sum.hasDtrBreakdown)return '';return [`DTR ${integer(sum.dtrOrders.dtr)} sipariş`,`NON-DTR ${integer(sum.dtrOrders.nonDtr)} sipariş`].join(' · ');}
  function scopeSub(sum){return [`${integer(sum.models)} model`,`${integer(sum.qty)} adet`,dtrScopeText(sum)].filter(Boolean).join(' · ');}
  function renderKpis(a){
    $('lflKpis').innerHTML=[
      kpi(`${a.currentSeason} Ağırlıklı FOB`,moneySummary(a.current),monthSelectionLabel(a.currentMonths)),
      kpi(`${a.compareSeason} Ağırlıklı FOB`,moneySummary(a.previous),monthSelectionLabel(a.compareMonths)),
      kpi(isEn()?'FOB Change':'FOB Değişimi',comparablePct(a.priceChange),a.priceChange==null?(isEn()?'No comparable data':'Kıyaslanacak veri yok'):a.priceChange<0?(isEn()?'Lower price than the comparison season':'Kıyas sezonuna göre fiyat iyileşmesi'):(isEn()?'Higher price than the comparison season':'Kıyas sezonuna göre fiyat artışı'),priceDeltaClass(a.priceChange)),
      kpi(`${a.currentSeason} Analiz Kapsamı`,`${integer(a.current.orders)} sipariş`,scopeSub(a.current)),
      kpi(`${a.compareSeason} Analiz Kapsamı`,`${integer(a.previous.orders)} sipariş`,scopeSub(a.previous)),
    ].join('');
  }
  function selectedFxMonths(a){
    const chosen=[...a.currentMonths,...a.compareMonths].filter(v=>/^\d{4}-\d{2}$/.test(v));
    return [...new Set(chosen)].sort();
  }
  function fxRateReport(a){
    if(!window.BLFX||!BLFX.store||!Object.keys(BLFX.store.months||{}).length)return [];
    const months=selectedFxMonths(a);if(!months.length)return [];
    const countries=[...new Set((state.filters.country.size?[...state.filters.country]:[...a.currentRows,...a.compareRows].map(r=>r.country)).filter(isUsableValue))].sort((x,y)=>String(x).localeCompare(String(y),'tr'));
    const reports=[];
    countries.forEach(country=>{
      const currency=countryCurrency(country);if(!currency||currency==='USD')return;
      const points=months.map(requested=>{const snap=BLFX.snapshotForMonth(requested,currency),rate=BLFX.convert(1,'USD',currency,snap);return rate==null?null:{requested,resolved:snap.month,exact:snap.exact,rate};}).filter(Boolean);
      if(!points.length)return;
      const first=points[0],last=points[points.length-1],change=points.length>1&&first.rate?((last.rate-first.rate)/first.rate*100):null;
      const series=points.map(p=>`${monthLabel(p.requested)}: 1 USD = ${p.rate.toLocaleString('tr-TR',{minimumFractionDigits:p.rate>=20?2:4,maximumFractionDigits:p.rate>=20?2:4})} ${currency}${p.exact?'':` (${monthLabel(p.resolved)})`}`).join(' · ');
      const changeText=change==null?'':` · ${isEn()?'Change':'Değişim'}: ${change>=0?'+':''}${change.toLocaleString('tr-TR',{maximumFractionDigits:2})}%`;
      reports.push({country,currency,points,change,text:`${country} · ${series}${changeText}`});
    });
    return reports;
  }
  function renderInsights(a){
    const items=[];
    if(!a.current.currencies.length)items.push(['!','Seçili koşullarda güncel dönem için geçerli FOB ve miktar satırı bulunamadı.']);
    else if(a.priceChange!=null)items.push([a.priceChange<0?'↓':'↑',`${a.currentSeason} güncel dönem ağırlıklı fiyatı ${a.compareSeason} kıyas dönemine göre ${pct(a.priceChange)} ${a.priceChange<0?'değişti; negatif değer fiyat iyileşmesini gösterir.':'değişti; pozitif değer fiyat artışını gösterir.'}`]);
    if(a.current.currencies.length>1)items.push(['₺/$','Türkiye ve diğer ülkeler aynı fiyat ortalamasında karıştırılmadı; TRY ve USD sonuçları ayrı gösteriliyor. Yüzde kıyasları para birimi içinde hesaplanıp miktarla ağırlıklandırılıyor.']);
    items.push(['◫',`Güncel ${dateFieldLabel(a.currentDateField)} kapsamı: ${monthSelectionLabel(a.currentMonths)}. Kıyas ${dateFieldLabel(a.compareDateField)} kapsamı: ${monthSelectionLabel(a.compareMonths)}. FOB değişimi yalnız her iki dönemde de geçerli FOB bulunan aynı kırılım ve para birimi çiftleri üzerinden hesaplanır.`]);
    items.push(['DTR',isEn()?'DTR classification uses only the Non-DTR manufacturer list: listed manufacturers are NON-DTR and every other order is DTR.':'DTR sınıflandırması yalnız Non-DTR üretici listesine göre yapılır: listedeki üreticiler NON-DTR, diğer tüm siparişler DTR kabul edilir.']);
    const fxReports=fxRateReport(a);fxReports.forEach(report=>items.push(['$',(isEn()?'USD rate by country and month: ':'Ülke ve ay bazlı Dolar kuru: ')+report.text]));
    const comparableQty=Math.min(a.current.qty,a.previous.qty),coverage=a.current.qty>0?comparableQty/a.current.qty*100:null;if(coverage!=null)items.push(['#',`Kıyas dönemi hacmi, güncel dönem hacminin yaklaşık %${coverage.toLocaleString('tr-TR',{maximumFractionDigits:0})} seviyesinde.`]);
    const valid=a.groups.filter(g=>g.priceChange!=null);if(valid.length){const best=[...valid].sort((x,y)=>x.priceChange-y.priceChange)[0],worst=[...valid].sort((x,y)=>y.priceChange-x.priceChange)[0];items.push(['★',`En yüksek fiyat iyileşmesi: ${best.key} (${pct(best.priceChange)}). En yüksek fiyat artışı: ${worst.key} (${pct(worst.priceChange)}).`]);}
    $('lflInsightList').innerHTML=items.map(([icon,text])=>`<div class="lflInsight"><div class="lflInsightIcon">${esc(icon)}</div><div>${esc(text)}</div></div>`).join('');
  }
  function renderSource(){
    const meta=state.meta||{},sheets=meta.sheets||[],warnings=meta.warnings||[];
    $('lflSourceInfo').innerHTML=`<div class="lflSourceRows"><div class="lflSourceRow"><span>Dosya</span><strong>${esc(state.source||'Bulunamadı')}</strong></div><div class="lflSourceRow"><span>Okunan sayfa</span><strong>${esc(sheets.map(s=>s.name).join(', ')||'—')}</strong></div><div class="lflSourceRow"><span>Geçerli satır</span><strong>${integer(meta.rowCount||0)}</strong></div><div class="lflSourceRow"><span>Boş boyut nedeniyle çıkarılan</span><strong>${integer(meta.skippedMissingDimensions||0)}</strong></div><div class="lflSourceRow"><span>Çıkarılan mükerrer</span><strong>${integer(meta.duplicateRowsRemoved||0)}</strong></div><div class="lflSourceRow"><span>Son okuma</span><strong>${state.loadedAt?dateTimeShort(state.loadedAt):'—'}</strong></div></div>${warnings.map(w=>`<div class="lflWarning">${esc(w)}</div>`).join('')}`;
    const badge=$('lflSourceBadge');badge.textContent=state.source?`${state.source} · ${integer(meta.rowCount||0)} satır`:'LFL Excel bulunamadı';badge.classList.toggle('isError',!state.source||!(meta.rowCount>0));
  }
  const groupLabels={lflKey:'MAG · MMYG · Klasman',mag:'MAG',mmyg:'MMYG',classification:'Klasman',manufacturer:'Üretici',country:'Ülke',buyingGroup:'Buying Group',buyer:'Buyer'};
  function compareTableValues(a,b,type='text'){
    if(type==='number'){const av=num(a),bv=num(b);if(av==null&&bv==null)return 0;if(av==null)return 1;if(bv==null)return -1;return av-bv;}
    if(type==='date')return String(a||'').localeCompare(String(b||''));
    return String(a??'').localeCompare(String(b??''),'tr-TR',{numeric:true,sensitivity:'base'});
  }
  const LEGACY_MANUFACTURER_VOLUME_CLASS='lflManufacturerVolumeValues'; // compatibility marker for prior UI tests
  const LFL_CP_TABLE_KEYS={group:'lflGroup',manufacturer:'lflManufacturer',customCompare:'lflCustomCompare',currentDetail:'lflCurrentDetail',compareDetail:'lflCompareDetail'};
  const dateObject=value=>{const m=String(value||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);return m?new Date(Number(m[1]),Number(m[2])-1,Number(m[3])):null;};
  function cpColumnType(col){
    if(col.cpType)return col.cpType;
    if(col.type==='date')return 'date';
    if(col.type==='number')return col.integer?'int':'num';
    return 'ro';
  }
  function frameworkColumns(columns){return columns.map(col=>({k:col.key,label:typeof col.label==='function'?col.label():col.label,type:cpColumnType(col),weight:col.weight||10}));}
  function frameworkRows(sourceRows,columns){return (sourceRows||[]).map((source,index)=>{const row={_id:index+1,_source:source};columns.forEach(col=>{let value=col.value?col.value(source):source[col.key];if(col.type==='date')value=dateObject(value);row[col.key]=value;});return row;});}
  function sortFrameworkRows(rows,viewName,columns){
    const view=state.tableViews[viewName]||emptyTableView();if(!view.sortKey)return rows.slice();
    const col=columns.find(item=>item.key===view.sortKey);if(!col)return rows.slice();
    return rows.slice().sort((a,b)=>compareTableValues(a[view.sortKey],b[view.sortKey],col.type==='number'?'number':col.type)*view.dir||compareTableValues(a[columns[0].key],b[columns[0].key],'text'));
  }
  function frameworkCellHtml(columns,col,row){
    const def=columns.find(item=>item.key===col.k)||{},source=row._source||row;
    const raw=def.value?def.value(source):source[def.key];
    let display=def.display?def.display(source):(def.type==='date'?dateTR(raw):(row[col.k]==null||row[col.k]===''?'—':row[col.k]));
    let classes=[];if(def.cls)classes.push(def.cls);if(typeof def.cellClass==='function'){const extra=def.cellClass(source);if(extra)classes.push(extra);}if(def.type==='number'||def.integer)classes.push('num');
    const title=typeof def.title==='function'?def.title(source):def.title;
    const linked=window.BLDetailLinks?.cellHtml?.({column:def.key,label:columnLabel(def),value:raw,displayValue:display,row:source,plmId:source.plmId});
    return `<td${classes.length?` class="${esc(classes.join(' '))}"`:''}${title?` title="${esc(title)}"`:''}>${def.html?def.html(source):(linked==null?esc(display):linked)}</td>`;
  }
  let openLflColumnPanel=null;
  const LFL_TABLE_EXPORTS=new Map();
  let lflPortfolioModalState=null;
  let lflDetailModalState=null;
  function closeLflColumnPanel(){if(openLflColumnPanel){openLflColumnPanel.classList.remove('show','viewportFloating');openLflColumnPanel.style.cssText='';openLflColumnPanel=null;}}
  function safeFilePart(value){return norm(value).replace(/[\\/:*?"<>|]+/g,' ').replace(/\s+/g,' ').trim().slice(0,80)||'LFL';}
  function columnLabel(col){return typeof col.label==='function'?col.label():col.label;}
  /* LFL PLM ID'yi ekranda göstermek zorunda değildir. Kaynak PLM ID
     taşıyorsa gizli metadata olarak korunur; taşımıyorsa model + renk +
     sipariş kodu ortak çözümleyiciye bırakılır. */
  function lflModelIdentity(row){
    const styleName=norm(row&&row.modelName);
    const plmId=window.BLDetailImages?.resolvePlmId?.(row&&row.plmId,styleName)||norm(row&&row.plmId);
    return {plmId,colourCode:norm(row&&row.colourCode),colour:norm(row&&row.colour),styleName,orderCode:norm(row&&row.orderCode)};
  }
  function lflModelImageCellHtml(row,imageIndex,title){
    const id=lflModelIdentity(row);
    const url=window.BLDetailImages?.urlFrom?.(imageIndex,{plmId:id.plmId,colourCode:id.colourCode,colour:id.colour,modelName:id.styleName})||'';
    if(!window.BLDetailImages?.thumbHtml)return '';
    // Görseli olmayan satır da kimliğini bırakır; yoksa "Eksikleri Tamamla"
    // tam da o satırları hiç istemez.
    return window.BLDetailImages.thumbHtml(url,{modelId:id.plmId||id.styleName,colourCode:id.colourCode,plmId:id.plmId,modelName:id.styleName,colour:id.colour},{title,allowEmpty:true});
  }
  function lflRegisterModelAssetScope(panel,rows,label,repaint,imageIndex){
    if(!panel||!window.BLDetailImages?.registerScope)return;
    try{
      window.BLDetailImages.registerScope(panel,{
        contextType:'lfl-detail',label,
        identities:(rows||[]).map((row,index)=>{
          const id=lflModelIdentity(row);
          return {...id,rowId:String(row&&row.id!=null?row.id:index),
            // Görsel sütunu açıkken ekranın gerçeği bildirilir.
            hasImage:imageIndex?Boolean(window.BLDetailImages?.urlFrom?.(imageIndex,{plmId:id.plmId,colourCode:id.colourCode,colour:id.colour,modelName:id.styleName})):null};
        }),
        repaint,
      });
    }catch(err){console.warn('LFL model varlık kapsamı kaydedilemedi:',err);}
  }
  function columnRawValue(col,row){return col.value?col.value(row):row?.[col.key];}
  function columnExcelValue(col,row){
    const raw=columnRawValue(col,row);
    if(col.exportDisplay&&typeof col.display==='function')return col.display(row);
    if(col.type==='date')return dateObject(raw)||raw||'';
    if(col.type==='number'){const n=num(raw);return n==null?'':n;}
    return raw==null?'':String(raw);
  }
  function tableVisibleColumnKeys(tableId,columns){
    const table=$(tableId),keys=[...(table?.querySelectorAll('thead tr.colRow th[data-k]')||[])].map(th=>th.dataset.k).filter(Boolean);
    return keys.length?keys:columns.map(col=>col.key);
  }
  async function writeLflWorkbook({title,fileName,columns,rows,sheetName='Data'}){
    if(!window.XLSX){if(window.showToast)showToast(isEn()?'Excel library could not be loaded.':'Excel kütüphanesi yüklenemedi.');return false;}
    const imageColumnIndex=columns.findIndex(col=>col.key==='__modelImage');
    if(imageColumnIndex>=0&&window.BLDetailImages?.prepareForExcel){
      if(window.BLPerf)await window.BLPerf.ensureLibrary('exceljs');
      if(typeof ExcelJS==='undefined')throw new Error(isEn()?'Excel image engine could not be loaded.':'Excel görsel motoru yüklenemedi.');
      const wb=new ExcelJS.Workbook(),ws=wb.addWorksheet(safeFilePart(sheetName).slice(0,31)),index=window.BLDetailImages.buildIndex();
      ws.columns=columns.map(col=>({header:columnLabel(col),width:col.key==='__modelImage'?14:Math.max(11,Math.min(34,Number(col.exportWidth)||Number(col.weight)||14))}));
      const thin={style:'thin',color:{argb:'FFD0D5DD'}},border={top:thin,bottom:thin,left:thin,right:thin};
      ws.getRow(1).eachCell(cell=>{cell.font={bold:true,size:10,color:{argb:'FF475467'}};cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFF2F4F7'}};cell.alignment={horizontal:'center',vertical:'middle',wrapText:true};cell.border=border;});
      const imageJobs=[];(rows||[]).forEach((source,ri)=>{const row=ws.getRow(ri+2);row.height=58;columns.forEach((col,ci)=>{const cell=row.getCell(ci+1);cell.border=border;if(col.key==='__modelImage'){const url=window.BLDetailImages.urlFrom(index,{plmId:source.plmId,colourCode:source.colourCode,colour:source.colour||'',modelName:source.modelName});if(url)imageJobs.push({url,rowNum:ri+2,columnIndex:ci+1});return;}const value=columnExcelValue(col,source);cell.value=value;cell.alignment={vertical:'middle',wrapText:true};if(col.type==='date'&&value instanceof Date)cell.numFmt='dd.mm.yy';if(col.key==='colourCode'||col.key==='colorCode'||col.key==='ccode'){cell.value=String(value==null?'':value);cell.numFmt='@';}const bridge=window.BLDetailLinks?.urlFor?.(col.key,columnRawValue(col,source),source,source?.plmId||'');if(bridge)cell.value={text:String(value==null?'':value),hyperlink:bridge,tooltip:col.key==='modelName'?'CoreNectum PLM':'Troy Order'};});});
      for(let start=0;start<imageJobs.length;start+=12){const jobs=imageJobs.slice(start,start+12),images=await Promise.all(jobs.map(job=>window.BLDetailImages.prepareForExcel(job.url)));images.forEach((image,indexInBatch)=>{if(image)window.BLDetailImages.addToExcel(ws,wb,image,jobs[indexInBatch].rowNum,jobs[indexInBatch].columnIndex);});}
      ws.autoFilter={from:{row:1,column:1},to:{row:Math.max(1,(rows||[]).length+1),column:Math.max(1,columns.length)}};ws.views=[{state:'frozen',ySplit:1}];
      const buffer=await wb.xlsx.writeBuffer();window.BLDetailImages.downloadBuffer(buffer,`${safeFilePart(fileName||title)}.xlsx`,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');return true;
    }
    const head=columns.map(columnLabel),data=[head,...(rows||[]).map(row=>columns.map(col=>columnExcelValue(col,row)))];
    const ws=XLSX.utils.aoa_to_sheet(data,{cellDates:true});
    ws['!autofilter']={ref:XLSX.utils.encode_range({r:0,c:0},{r:Math.max(0,data.length-1),c:Math.max(0,head.length-1)})};
    ws['!freeze']={xSplit:0,ySplit:1,topLeftCell:'A2',activePane:'bottomLeft',state:'frozen'};
    ws['!cols']=columns.map(col=>({wch:Math.max(11,Math.min(34,Number(col.exportWidth)||Number(col.weight)||14))}));
    const range=ws['!ref']?XLSX.utils.decode_range(ws['!ref']):null;
    if(range){for(let r=1;r<=range.e.r;r++)columns.forEach((col,c)=>{
      const cell=ws[XLSX.utils.encode_cell({r,c})];
      if(col.type==='date'&&cell&&cell.t==='d')cell.z='dd.mm.yy';
      if(cell&&(col.key==='colourCode'||col.key==='colorCode'||col.key==='ccode')){cell.t='s';cell.v=String(cell.v??'');cell.z='@';}
      const source=(rows||[])[r-1],raw=source?columnRawValue(col,source):'';
      const bridge=window.BLDetailLinks?.urlFor?.(col.key,raw,source||{},source?.plmId||'');
      if(bridge&&cell)cell.l={Target:bridge,Tooltip:col.key==='modelName'?'CoreNectum PLM':'Troy Order'};
    });}
    const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,safeFilePart(sheetName).slice(0,31));
    XLSX.writeFile(wb,`${safeFilePart(fileName||title)}.xlsx`);
    return true;
  }
  async function exportLflTable(tableId){
    const descriptor=LFL_TABLE_EXPORTS.get(tableId);if(!descriptor)return;
    const keys=tableVisibleColumnKeys(tableId,descriptor.columns),columns=keys.map(key=>descriptor.columns.find(col=>col.key===key)).filter(Boolean);
    const title=(typeof descriptor.title==='function'?descriptor.title():descriptor.title)||$(tableId)?.closest('.lflCard')?.querySelector('.lflSectionHead h3')?.textContent||'LFL Table';
    if(await writeLflWorkbook({title,fileName:`LFL_${title}`,columns,rows:descriptor.rows,sheetName:title})&&window.showToast)showToast(isEn()?`${descriptor.rows.length.toLocaleString('en-GB')} rows exported.`:`${descriptor.rows.length.toLocaleString('tr-TR')} satır dışa aktarıldı.`);
  }
  function portfolioModalColumns(){return [
    {key:'period',label:isEn()?'Portfolio':'Portföy',value:r=>r._lflPeriod||'',type:'text',weight:12},
    ...detailColumns().map(col=>({...col,exportWidth:col.key==='modelName'||col.key==='manufacturer'?24:col.key==='orderCode'?16:14})),
  ];}
  function ensureLflDetailModal(){
    let modal=$('lflDetailAccessModal');if(modal)return modal;
    modal=document.createElement('div');modal.id='lflDetailAccessModal';modal.className='lflPortfolioModal lflDetailAccessModal';modal.hidden=true;
    const imgToggle=window.BLDetailImages?window.BLDetailImages.toggleHtml('lflDetailAccessImages')+(window.BLDetailImages.modelImagesButtonHtml?window.BLDetailImages.modelImagesButtonHtml('lflDetailAccessModelImages'):''):'';
    modal.innerHTML=`<div class="lflPortfolioModalBackdrop" data-lfl-detail-close></div><section class="lflPortfolioModalPanel lflDetailAccessPanel lflCard" role="dialog" aria-modal="true" aria-labelledby="lflDetailAccessTitle"><header class="lflPortfolioModalHead lflSectionHead"><div><h3 id="lflDetailAccessTitle"></h3><p id="lflDetailAccessSummary"></p></div><div class="lflPortfolioModalActions">${imgToggle}<button type="button" class="lflPortfolioModalClose" data-lfl-detail-close aria-label="${esc(isEn()?'Close':'Kapat')}">×</button></div></header><div class="tablewrap lflPortfolioModalTableWrap"><table id="lflDetailAccessTable"><colgroup></colgroup><thead></thead><tbody></tbody></table></div></section>`;
    document.body.appendChild(modal);window.BLDetailImages?.bind('lflDetailAccessImages',()=>renderLflDetailModal());window.BLDetailImages?.bindModelImagesButton?.('lflDetailAccessModelImages');modal.querySelectorAll('[data-lfl-detail-close]').forEach(el=>el.addEventListener('click',closeLflDetailModal));return modal;
  }
  function closeLflDetailModal(){
    const modal=$('lflDetailAccessModal');if(modal)modal.hidden=true;lflDetailModalState=null;closeLflColumnPanel();window.BLTableFramework?.closeFilter?.();document.body.classList.remove('lflPortfolioModalOpen');
  }
  function renderLflDetailModal(){
    if(!lflDetailModalState)return;const modal=ensureLflDetailModal(),a=state.analysis||compute(),current=lflDetailModalState.side==='current';
    const rows=current?a.currentRows:a.compareRows,season=current?a.currentSeason:a.compareSeason,months=current?a.currentMonths:a.compareMonths,viewName=current?'currentDetail':'compareDetail';
    const title=current?(isEn()?'Selected Portfolio Detail':'Seçili Portföy Detayı'):(isEn()?'Compared Portfolio Detail':'Kıyaslanan Portföy Detayı'),baseColumns=detailColumns();
    const showImages=Boolean(window.BLDetailImages&&window.BLDetailImages.isOn()),imageIndex=showImages?window.BLDetailImages.buildIndex():null;
    const imageTitle=isEn()?'Hover for large preview':'Büyük önizleme için üzerine gelin';
    const imageColumn={key:'__modelImage',label:isEn()?'Image':'Görsel',type:'text',weight:6,cls:'detailImgCell',value:()=>'',html:row=>lflModelImageCellHtml(row,imageIndex,imageTitle)};
    const columns=showImages?[imageColumn,...baseColumns]:baseColumns;
    modal.querySelector('#lflDetailAccessTitle').textContent=title;modal.querySelector('.lflPortfolioModalClose').setAttribute('aria-label',isEn()?'Close':'Kapat');
    const result=renderCpTable({tableId:'lflDetailAccessTable',viewName,columns,sourceRows:rows,title:()=>title,emptyText:current?(isEn()?'No current portfolio row matches the filters.':'Filtrelerle eşleşen güncel portföy satırı bulunamadı.'):(isEn()?'No comparison portfolio row matches the filters.':'Filtrelerle eşleşen kıyas portföyü satırı bulunamadı.'),footer:(filtered,visible)=>totalFooterByKey(visible,{quantity:integer(quantityTotal(filtered))}),rerenderOverride:renderLflDetailModal});
    const filtered=result.filtered||[],period=[season,monthSelectionLabel(months)].filter(Boolean).join(' · ');modal.querySelector('#lflDetailAccessSummary').textContent=`${period} · ${integer(filtered.length)} ${isEn()?'rows':'satır'} / ${integer(rows.length)} · ${integer(quantityTotal(filtered))} ${isEn()?'units':'adet'}`;
    /* Kapsam EKRANDAKİ kümedir: tablo içi filtre uygulanmışsa "Tümünü Yenile"
       tüm portföyü değil o an görünen satırları işler. */
    lflRegisterModelAssetScope(modal.querySelector('.lflDetailAccessPanel'),filtered.map(row=>row&&row._source||row),title,renderLflDetailModal,imageIndex);
  }
  function openLflDetailModal(side){
    const normalized=side==='compare'?'compare':'current';
    if(window.BLDetailDrawer?.open){
      const a=state.analysis||compute(),current=normalized==='current';
      const rows=current?a.currentRows:a.compareRows,season=current?a.currentSeason:a.compareSeason,months=current?a.currentMonths:a.compareMonths;
      const title=current?(isEn()?'Selected Portfolio Detail':'Seçili Portföy Detayı'):(isEn()?'Compared Portfolio Detail':'Kıyaslanan Portföy Detayı');
      const columns=detailColumns().map(col=>({key:col.key,label:columnLabel(col),value:row=>col.display?col.display(row):columnRawValue(col,row),exportWidth:col.exportWidth||col.weight}));
      window.BLDetailDrawer.open({storageKey:'lfl.'+normalized+'.detail',source:'lfl',title,subtitle:[season,monthSelectionLabel(months)].filter(Boolean).join(' · '),rows,columns,images:true,fileName:'LFL_'+title});
      return;
    }
    const modal=ensureLflDetailModal();closeLflPortfolioModal();
    if(lflDetailModalState?.side!==normalized){closeLflColumnPanel();window.BLTableFramework?.closeFilter?.();modal.querySelector('.lflCpTableTools')?.remove();}lflDetailModalState={side:normalized};renderLflDetailModal();modal.hidden=false;document.body.classList.add('lflPortfolioModalOpen');requestAnimationFrame(()=>modal.querySelector('.lflPortfolioModalClose')?.focus());
  }
  function updatePortfolioAccessButtons(a){
    const current=$('lflCurrentPortfolioBtn'),compare=$('lflComparePortfolioBtn');if(current){current.disabled=!(a&&a.currentRows&&a.currentRows.length);current.title=isEn()?'Open the selected portfolio detail table':'Seçili portföy detay tablosunu aç';}if(compare){compare.disabled=!(a&&a.compareRows&&a.compareRows.length);compare.title=isEn()?'Open the compared portfolio detail table':'Kıyaslanan portföy detay tablosunu aç';}
  }
  function ensureLflPortfolioModal(){
    let modal=$('lflPortfolioModal');if(modal)return modal;
    modal=document.createElement('div');modal.id='lflPortfolioModal';modal.className='lflPortfolioModal';modal.hidden=true;
    // "Görseller" düğmesi Excel'e Aktar'ın SOLUNDA; ortak katman app-main.js'te.
    const imgToggle=window.BLDetailImages?window.BLDetailImages.toggleHtml('lflPortfolioModalImages')+(window.BLDetailImages.modelImagesButtonHtml?window.BLDetailImages.modelImagesButtonHtml('lflPortfolioModalModelImages'):''):'';
    modal.innerHTML=`<div class="lflPortfolioModalBackdrop" data-lfl-portfolio-close></div><section class="lflPortfolioModalPanel" role="dialog" aria-modal="true" aria-labelledby="lflPortfolioModalTitle"><header class="lflPortfolioModalHead"><div><h3 id="lflPortfolioModalTitle"></h3><p id="lflPortfolioModalSummary"></p></div><div class="lflPortfolioModalActions">${imgToggle}<button type="button" class="lflButton" id="lflPortfolioModalExport"><svg class="ic"><use href="#i-file-export"/></svg><span>${esc(isEn()?'Export to Excel':'Excel’e Aktar')}</span></button><button type="button" class="lflPortfolioModalClose" data-lfl-portfolio-close aria-label="${esc(isEn()?'Close':'Kapat')}">×</button></div></header><div class="tablewrap lflPortfolioModalTableWrap"><table class="lflTable" id="lflPortfolioModalTable"><thead></thead><tbody></tbody></table></div></section>`;
    document.body.appendChild(modal);
    window.BLDetailImages?.bind('lflPortfolioModalImages',()=>renderLflPortfolioModal());window.BLDetailImages?.bindModelImagesButton?.('lflPortfolioModalModelImages');
    modal.querySelectorAll('[data-lfl-portfolio-close]').forEach(el=>el.addEventListener('click',closeLflPortfolioModal));
    modal.querySelector('#lflPortfolioModalExport')?.addEventListener('click',async()=>{
      if(!lflPortfolioModalState)return;
      const base=portfolioModalColumns(),image={key:'__modelImage',label:isEn()?'Image':'Görsel',type:'text',weight:6,value:()=>''};
      await writeLflWorkbook({title:lflPortfolioModalState.title,fileName:`LFL_Portfolio_${lflPortfolioModalState.title}`,columns:window.BLDetailImages?.isOn()?[image,...base]:base,rows:lflPortfolioModalState.rows,sheetName:isEn()?'Portfolio Detail':'Portföy Detayı'});
    });
    return modal;
  }
  function closeLflPortfolioModal(){const modal=$('lflPortfolioModal');if(modal)modal.hidden=true;lflPortfolioModalState=null;document.body.classList.remove('lflPortfolioModalOpen');}
  function renderLflPortfolioModal(){
    if(!lflPortfolioModalState)return;const modal=ensureLflPortfolioModal(),columns=portfolioModalColumns(),rows=lflPortfolioModalState.rows||[];
    modal.querySelector('#lflPortfolioModalExport span').textContent=isEn()?'Export to Excel':'Excel’e Aktar';modal.querySelector('.lflPortfolioModalClose').setAttribute('aria-label',isEn()?'Close':'Kapat');modal.querySelector('#lflPortfolioModalTitle').textContent=lflPortfolioModalState.title||'';modal.querySelector('#lflPortfolioModalSummary').textContent=lflPortfolioModalState.summary||'';
    const table=modal.querySelector('#lflPortfolioModalTable'),thead=table.querySelector('thead'),tbody=table.querySelector('tbody');
    // Model görseli sütunu isteğe bağlı ve en solda; LFL satırları PLM ID taşımadığı
    // için eşleşme model adı + renk kodu üzerinden yapılır (bkz. BLDetailImages).
    const showImages=Boolean(window.BLDetailImages&&window.BLDetailImages.isOn());
    const imageIndex=showImages?window.BLDetailImages.buildIndex():null;
    const imgHead=showImages?`<th class="detailImgCell">${esc(isEn()?'Image':'Görsel')}</th>`:'';
    const imgCell=row=>{
      if(!showImages)return '';
      const title=isEn()?'Hover for large preview':'Büyük önizleme için üzerine gelin';
      return `<td class="detailImgCell">${lflModelImageCellHtml(row,imageIndex,title)}</td>`;
    };
    lflRegisterModelAssetScope(modal.querySelector('.lflPortfolioModalPanel'),rows,lflPortfolioModalState.title||'LFL',renderLflPortfolioModal,imageIndex);
    thead.innerHTML=`<tr class="colRow">${imgHead}${columns.map(col=>`<th>${esc(columnLabel(col))}</th>`).join('')}</tr>`;
    tbody.innerHTML=rows.length?rows.map(row=>`<tr>${imgCell(row)}${columns.map(col=>{const raw=columnRawValue(col,row),display=col.display?col.display(row):(col.type==='date'?dateTR(raw):(raw==null||raw===''?'—':raw));const linked=window.BLDetailLinks?.cellHtml?.({column:col.key,label:columnLabel(col),value:raw,displayValue:display,row,plmId:row.plmId});return `<td class="${col.type==='number'?'num':''}">${linked==null?esc(display):linked}</td>`;}).join('')}</tr>`).join(''):`<tr><td class="empty" colspan="${columns.length+(showImages?1:0)}">${esc(isEn()?'No portfolio detail was found.':'Portföy detayı bulunamadı.')}</td></tr>`;
  }
  function openLflPortfolioModal({title,currentRows=[],previousRows=[],currentSeason,compareSeason}){
    const rows=[...(currentRows||[]).map(row=>({...row,_lflPeriod:currentSeason})),...(previousRows||[]).map(row=>({...row,_lflPeriod:compareSeason}))],summary=`${currentSeason}: ${integer(currentRows.length)} ${isEn()?'rows':'satır'} · ${integer(quantityTotal(currentRows))} ${isEn()?'units':'adet'}   |   ${compareSeason}: ${integer(previousRows.length)} ${isEn()?'rows':'satır'} · ${integer(quantityTotal(previousRows))} ${isEn()?'units':'adet'}`;
    if(window.BLDetailDrawer?.open){
      const columns=portfolioModalColumns().map(col=>({key:col.key,label:columnLabel(col),value:row=>col.display?col.display(row):columnRawValue(col,row),exportWidth:col.exportWidth||col.weight}));
      window.BLDetailDrawer.open({storageKey:'lfl.portfolio.detail',source:'lfl',title,subtitle:summary,rows,columns,images:true,fileName:'LFL_Portfolio_'+title});
      return;
    }
    closeLflDetailModal();const modal=ensureLflPortfolioModal();lflPortfolioModalState={title,rows,summary};renderLflPortfolioModal();modal.hidden=false;document.body.classList.add('lflPortfolioModalOpen');requestAnimationFrame(()=>modal.querySelector('.lflPortfolioModalClose')?.focus());
  }
  function ensureCpTableTools(tableId,tableKey,rerender){
    const table=$(tableId),card=table?.closest('.lflCard');if(!card)return;
    const head=card.querySelector('.lflSectionHead');if(!head)return;
    let tools=head.querySelector(`.lflCpTableTools[data-table="${tableId}"]`);
    if(!tools){
      tools=document.createElement('div');tools.className='lflCpTableTools colPanelWrap';tools.dataset.table=tableId;
      tools.innerHTML=`<button type="button" class="lflCpTableTool" data-lfl-export title="${esc(isEn()?'Export this table to Excel':'Bu tabloyu Excel’e aktar')}"><svg class="ic"><use href="#i-file-export"/></svg><span>${esc(isEn()?'Export Excel':'Excel’e Aktar')}</span></button><button type="button" class="lflCpTableTool" data-lfl-columns title="${esc(isEn()?'Choose columns':'Sütun seç')}">☷ <span>${esc(isEn()?'Columns':'Sütunlar')}</span></button><button type="button" class="lflCpTableTool" data-lfl-freeze title="${esc(isEn()?'Freeze columns':'Sütunları dondur')}">❄ <span>${esc(isEn()?'Freeze':'Dondur')}</span></button><button type="button" class="lflCpTableTool" data-lfl-clear title="${esc(isEn()?'Clear column filters':'Sütun filtrelerini temizle')}">⌫ <span>${esc(isEn()?'Clear filters':'Filtreleri temizle')}</span></button><div class="colPanel lflGenericColPanel"></div>`;
      head.appendChild(tools);
      tools.querySelector('[data-lfl-export]').addEventListener('click',event=>{event.preventDefault();event.stopPropagation();exportLflTable(tableId);});
      tools.querySelector('[data-lfl-columns]').addEventListener('click',event=>{event.preventDefault();event.stopPropagation();const panel=tools.querySelector('.lflGenericColPanel');if(openLflColumnPanel===panel){closeLflColumnPanel();return;}closeLflColumnPanel();window.BLTableFramework.renderColumnPanel(tableKey,panel,rerender);panel.classList.add('show');openLflColumnPanel=panel;requestAnimationFrame(()=>window.repositionVisiblePanels?.());});
      tools.querySelector('[data-lfl-freeze]').addEventListener('click',event=>{event.preventDefault();event.stopPropagation();closeLflColumnPanel();window.BLTableFramework.startFreeze(tableId,tableKey,event.currentTarget);});
      tools.querySelector('[data-lfl-clear]').addEventListener('click',event=>{event.preventDefault();event.stopPropagation();window.BLTableFramework.clearFilters(tableKey);rerender();if(window.showToast)showToast(isEn()?'Column filters cleared.':'Sütun filtreleri temizlendi.');});
    }
    const labels={export:isEn()?'Export Excel':'Excel’e Aktar',columns:isEn()?'Columns':'Sütunlar',freeze:isEn()?'Freeze':'Dondur',clear:isEn()?'Clear filters':'Filtreleri temizle'};
    tools.querySelector('[data-lfl-export] span').textContent=labels.export;tools.querySelector('[data-lfl-columns] span').textContent=labels.columns;tools.querySelector('[data-lfl-freeze] span').textContent=labels.freeze;tools.querySelector('[data-lfl-clear] span').textContent=labels.clear;
    const freezeBtn=tools.querySelector('[data-lfl-freeze]'),freezeOn=Boolean(window.BLTableFramework?.isFrozen?.(tableKey));
    freezeBtn?.classList.toggle('freezeOn',freezeOn);freezeBtn?.setAttribute('aria-pressed',freezeOn?'true':'false');
  }
  function lflResizeColumnType(col){
    const type=String(col?.type||'text').toLowerCase();
    if(type==='date')return 'date';
    if(type==='number')return 'num';
    if(type==='code')return 'code';
    return 'text';
  }
  function attachLflColumnResize(tableId,viewName,columns){
    const table=$(tableId),resize=window.BLTableColumnResize;
    if(!table||!resize?.apply)return;
    const byKey=new Map((columns||[]).map(col=>[String(col.key),col]));
    const visible=[...table.querySelectorAll('thead tr.colRow th[data-k]')].map(th=>{
      const col=byKey.get(String(th.dataset.k||''));if(!col)return null;
      return {key:String(col.key),label:columnLabel(col),type:lflResizeColumnType(col),minPx:60};
    }).filter(Boolean);
    if(!visible.length)return;
    resize.apply(table,{scope:`lfl.${viewName}`,columns:visible});
  }

  document.addEventListener('pointerdown',event=>{if(openLflColumnPanel&&!openLflColumnPanel.contains(event.target)&&!event.target.closest('.lflCpTableTools [data-lfl-columns]'))closeLflColumnPanel();},true);

  function bindLflDrillDown(tableId,allRows,drillKey,onDrill){
    const table=$(tableId),tbody=table?.querySelector('tbody');if(!tbody)return;
    tbody._lflDrillRows=new Map(allRows.map(row=>[String(row._id),row._source||row]));tbody._lflDrillHandler=typeof onDrill==='function'?onDrill:null;
    tbody.querySelectorAll('[data-lfl-drill]').forEach(cell=>{cell.removeAttribute('data-lfl-drill');cell.classList.remove('lflPortfolioDrillCell');cell.removeAttribute('title');});
    if(drillKey&&tbody._lflDrillHandler){const keys=[...table.querySelectorAll('thead tr.colRow th[data-k]')].map(th=>th.dataset.k),index=keys.indexOf(drillKey);if(index>=0)tbody.querySelectorAll('tr[data-id]').forEach(tr=>{const cell=tr.children[index];if(cell){cell.dataset.lflDrill='1';cell.classList.add('lflPortfolioDrillCell');const hint=isEn()?'Double-click to view portfolio details':'Portföy detayını görmek için çift tıkla';const text=cell.textContent.trim();cell.title=text?`${text}\n${hint}`:hint;}});}
    if(!tbody._lflDrillBound){tbody._lflDrillBound=true;tbody.addEventListener('dblclick',event=>{const cell=event.target.closest('td[data-lfl-drill="1"]'),tr=cell?.closest('tr[data-id]');if(!cell||!tr||typeof tbody._lflDrillHandler!=='function')return;const source=tbody._lflDrillRows?.get(String(tr.dataset.id));if(source)tbody._lflDrillHandler(source);});}
  }
  function renderCpTable({tableId,viewName,columns,sourceRows,emptyText,maxRows=0,rowClass,footer,count,drillKey,onDrill,title,rerenderOverride}){
    const api=window.BLTableFramework;if(!api)return {filtered:sourceRows||[],visible:sourceRows||[]};
    const tableKey=LFL_CP_TABLE_KEYS[viewName],all=frameworkRows(sourceRows,columns);
    const renderedColumns=frameworkColumns(columns);
    const drillColumnIndex=drillKey?renderedColumns.findIndex(column=>column.key===drillKey):-1;
    api.register(tableKey,renderedColumns,()=>all);
    const rerender=()=>{window.BLTableFramework.closeFilter();closeLflColumnPanel();if(typeof rerenderOverride==='function')rerenderOverride();else render();};
    ensureCpTableTools(tableId,tableKey,rerender);
    const filtered=api.filteredRows(tableKey,all),sorted=sortFrameworkRows(filtered,viewName,columns),visible=maxRows?sorted.slice(0,maxRows):sorted;
    const view=state.tableViews[viewName]||emptyTableView();state.tableViews[viewName]=view;
    api.render({tableId,tableKey,rows:visible,allRows:all,sortState:{key:view.sortKey,dir:view.dir},columns:renderedColumns,rerender,
      onSort:key=>{if(view.sortKey===key)view.dir*=-1;else{view.sortKey=key;view.dir=(columns.find(c=>c.key===key)?.type==='text'||key==='key'||key==='orderCode'||key==='modelName')?1:-1;}rerender();},
      cellHtmlFn:(col,row)=>frameworkCellHtml(columns,col,row),rowClassFn:row=>typeof rowClass==='function'?rowClass(row._source||row):'',emptyText,
      rowPostBuildFn:drillColumnIndex>=0?(tr,row)=>{const cell=tr.children[drillColumnIndex];if(!cell)return;cell.dataset.lflDrill='1';cell.classList.add('lflPortfolioDrillCell');const hint=isEn()?'Double-click to view portfolio details':'Portföy detayını görmek için çift tıkla';const text=cell.textContent.trim();cell.title=text?`${text}\\n${hint}`:hint;}:null,
      footerHtmlFn:(_displayRows,visibleCols)=>typeof footer==='function'?footer(sorted.map(row=>row._source||row),visibleCols):'',
      virtualize:true,
    });
    attachLflColumnResize(tableId,viewName,columns);
    LFL_TABLE_EXPORTS.set(tableId,{title,columns,rows:sorted.map(row=>row._source||row)});bindLflDrillDown(tableId,all,drillKey,onDrill);
    if(typeof count==='function')count(sorted.length,(sourceRows||[]).length,maxRows&&sorted.length>maxRows);
    return {filtered:sorted.map(row=>row._source||row),visible:visible.map(row=>row._source||row)};
  }
  function totalFooterByKey(visibleCols,values={}){
    return `<tr>${(visibleCols||[]).map((col,index)=>{const item=index===0?(isEn()?'Total':'Toplam'):(values[col.k]??''),value=item&&typeof item==='object'?item.value:item,extra=item&&typeof item==='object'?item.className:'',cls=[index===0?'quantityTotalLabel':(value!==''?'quantityTotalValue num':''),extra].filter(Boolean).join(' ');return `<td${cls?` class="${esc(cls)}"`:''}>${value}</td>`;}).join('')}</tr>`;
  }

  function renderGroupTable(a){
    const groupLabel=breakdownLabel(a.groupBy),columns=[
      {key:'key',label:groupLabel,value:g=>g.key,type:'text',weight:17},
      {key:'currentAvg',label:()=>comparisonColumnHeader(a.currentPeriod,'FOB'),value:g=>g.current.avg??g.current.byCurrency.USD?.avg??g.current.byCurrency.TRY?.avg,display:g=>moneySummary(g.current),exportDisplay:true,type:'number',cls:'num',weight:11},
      {key:'previousAvg',label:()=>comparisonColumnHeader(a.comparePeriod,'FOB'),value:g=>g.previous.avg??g.previous.byCurrency.USD?.avg??g.previous.byCurrency.TRY?.avg,display:g=>moneySummary(g.previous),exportDisplay:true,type:'number',cls:'num',weight:11},
      {key:'priceChange',label:()=>isEn()?'FOB Change':'FOB Değişimi',value:g=>g.priceChange,display:g=>comparablePct(g.priceChange),type:'number',cls:'num',cellClass:g=>tablePriceClass(g.priceChange),weight:10},
      {key:'qty',label:()=>isEn()?'Units':'Adet',value:g=>g.qty,display:g=>integer(g.qty),type:'number',integer:true,cls:'num',weight:9},
      {key:'orders',label:()=>isEn()?'Orders':'Sipariş',value:g=>g.orders,display:g=>integer(g.orders),type:'number',integer:true,cls:'num',weight:8},
    ];
    $('lflGroupTitle').textContent=`${groupLabel} ${isEn()?'Comparison':'Bazlı Kıyas'}`;
    renderCpTable({tableId:'lflGroupTable',viewName:'group',columns,sourceRows:a.groups,title:()=>$('lflGroupTitle')?.textContent||groupLabel,drillKey:'key',onDrill:g=>openLflPortfolioModal({title:`${groupLabel}: ${g.key}`,currentRows:g.currentRows,previousRows:g.previousRows,currentSeason:a.currentSeason,compareSeason:a.compareSeason}),emptyText:isEn()?'No group analysis matches the filters.':'Filtrelerle eşleşen grup analizi bulunamadı.',footer:(rows,visible)=>{
      const totalQty=rows.reduce((sum,g)=>sum+(num(g.qty)||0),0),totalOrders=rows.reduce((sum,g)=>sum+(num(g.orders)||0),0);
      return totalFooterByKey(visible,{qty:integer(totalQty),orders:integer(totalOrders)});
    }});
  }
  function manufacturerVolumes(currentRows,compareRows){
    const map=new Map();
    const collect=(rows,side)=>rows.forEach(row=>{
      const manufacturer=norm(row&&row.manufacturer);if(!manufacturer)return;
      if(!map.has(manufacturer))map.set(manufacturer,{manufacturer,currentQty:0,previousQty:0,currentOrders:new Set(),previousOrders:new Set(),currentRows:[],previousRows:[]});
      const item=map.get(manufacturer),quantity=num(row&&row.quantity);if(quantity>0)item[side+'Qty']+=quantity;
      const key=orderKey(row);if(key)item[side+'Orders'].add(key);item[side+'Rows'].push(row);
    });
    collect(currentRows||[],'current');collect(compareRows||[],'previous');
    const currentTotal=[...map.values()].reduce((sum,item)=>sum+item.currentQty,0),previousTotal=[...map.values()].reduce((sum,item)=>sum+item.previousQty,0);
    return [...map.values()].map(item=>{const current=summary(item.currentRows),previous=summary(item.previousRows);return {
      manufacturer:item.manufacturer,currentQty:item.currentQty,previousQty:item.previousQty,
      currentOrders:item.currentOrders.size,previousOrders:item.previousOrders.size,
      currentShare:currentTotal>0?item.currentQty/currentTotal*100:0,previousShare:previousTotal>0?item.previousQty/previousTotal*100:0,
      change:item.previousQty>0?(item.currentQty-item.previousQty)/item.previousQty*100:null,
      fobChange:metricBetween(current,previous,'change'),current,previous,currentRows:item.currentRows,previousRows:item.previousRows,
    };}).filter(item=>item.currentQty>0||item.previousQty>0).sort((a,b)=>b.currentQty-a.currentQty||b.previousQty-a.previousQty||a.manufacturer.localeCompare(b.manufacturer,'tr-TR'));
  }
  function renderManufacturerVolumes(a){
    const rows=manufacturerVolumes(a.currentRows,a.compareRows);
    $('lflManufacturerVolumeTitle').textContent=isEn()?'Manufacturer Order Volumes':'Üretici Sipariş Hacimleri';
    $('lflManufacturerVolumeSubtitle').textContent=isEn()?'Order quantities, period weighted FOB values and FOB change by manufacturer. Negative FOB change is an improvement.':'Üretici bazında sipariş miktarı, seçili dönemlerin ağırlıklı FOB değerleri ve FOB değişimi. Negatif FOB değişimi iyileşmedir.';
    const columns=[
      {key:'manufacturer',label:isEn()?'Manufacturer':'Üretici',value:r=>r.manufacturer,type:'text',weight:18},
      {key:'currentQty',label:comparisonColumnHeader(a.currentPeriod,isEn()?'Units':'Adet'),value:r=>r.currentQty,display:row=>integer(row.currentQty),type:'number',integer:true,cls:'num',weight:10},
      {key:'previousQty',label:comparisonColumnHeader(a.comparePeriod,isEn()?'Units':'Adet'),value:r=>r.previousQty,display:row=>integer(row.previousQty),type:'number',integer:true,cls:'num',weight:10},
      {key:'currentOrders',label:comparisonColumnHeader(a.currentPeriod,isEn()?'Orders':'Sipariş'),value:r=>r.currentOrders,display:r=>integer(r.currentOrders),type:'number',integer:true,cls:'num',weight:9},
      {key:'previousOrders',label:comparisonColumnHeader(a.comparePeriod,isEn()?'Orders':'Sipariş'),value:r=>r.previousOrders,display:r=>integer(r.previousOrders),type:'number',integer:true,cls:'num',weight:9},
      {key:'currentFob',label:comparisonColumnHeader(a.currentPeriod,'FOB'),value:r=>r.current.avg??r.current.byCurrency.USD?.avg??r.current.byCurrency.TRY?.avg,display:r=>moneySummary(r.current),exportDisplay:true,type:'number',cls:'num',weight:11},
      {key:'previousFob',label:comparisonColumnHeader(a.comparePeriod,'FOB'),value:r=>r.previous.avg??r.previous.byCurrency.USD?.avg??r.previous.byCurrency.TRY?.avg,display:r=>moneySummary(r.previous),exportDisplay:true,type:'number',cls:'num',weight:11},
      {key:'fobChange',label:isEn()?'FOB Change':'FOB Değişimi',value:r=>r.fobChange,display:r=>comparablePct(r.fobChange),type:'number',cls:'num',cellClass:r=>tablePriceClass(r.fobChange),weight:10},
    ];
    renderCpTable({tableId:'lflManufacturerVolumeTable',viewName:'manufacturer',columns,sourceRows:rows,title:()=>$('lflManufacturerVolumeTitle')?.textContent||(isEn()?'Manufacturer Order Volumes':'Üretici Sipariş Hacimleri'),drillKey:'manufacturer',onDrill:r=>openLflPortfolioModal({title:`${isEn()?'Manufacturer':'Üretici'}: ${r.manufacturer}`,currentRows:r.currentRows,previousRows:r.previousRows,currentSeason:a.currentSeason,compareSeason:a.compareSeason}),emptyText:isEn()?'No manufacturer volume data was found for the selected filters.':'Seçili filtrelerde üretici hacmi verisi bulunamadı.',footer:(filtered,visible)=>{
      const currentQty=filtered.reduce((sum,r)=>sum+(num(r.currentQty)||0),0),previousQty=filtered.reduce((sum,r)=>sum+(num(r.previousQty)||0),0);
      const currentOrders=filtered.reduce((sum,r)=>sum+(num(r.currentOrders)||0),0),previousOrders=filtered.reduce((sum,r)=>sum+(num(r.previousOrders)||0),0);
      return totalFooterByKey(visible,{currentQty:integer(currentQty),previousQty:integer(previousQty),currentOrders:integer(currentOrders),previousOrders:integer(previousOrders)});
    }});
  }
  function customCompareLabel(dim){const meta=CUSTOM_COMPARE_META[dim]||CUSTOM_COMPARE_META.mag;return isEn()?meta.en:meta.tr;}
  /* ===================== LFL TRIAL STUDIO =====================
     Trial rows remain synthetic CURRENT-period orders and never alter CP or the LFL source.
     Corrections explicitly approved in the basket are also written back to the matching
     Collection model, so the simulation and Collection page stay aligned. */
  const TRIAL_REQUIRED=['mag','mmyg','classification','country','buyingGroup','buyer','inStoreMonth','quantity','fob'];
  const TRIAL_LABELS={mag:'MAG',mmyg:'MMYG',brandDirectorate:'Marka Müdürlüğü',classification:'Klasman',productDescription:'Ürün Tanım',manufacturer:'Üretici',country:'Ülke',buyingGroup:'Buying Group',buyer:'Buyer',fabricCategory:'Kumaş Kategorisi',fabricSupplierCountry:'Kumaşçı Ülkesi',fabricSupplier:'Kumaşçı',kumasTipi:'Kumaş Tipi',iplikNo:'İplik No',fabricWeight:'Gramaj',karisim:'Karışım',inStoreMonth:'In-Store Ayı',quantity:'Adet',fob:'LFL FOB'};
  const TRIAL_LABELS_EN={mag:'MAG',mmyg:'MMYG',brandDirectorate:'Brand Directorate',classification:'Classification',productDescription:'Product Description',manufacturer:'Manufacturer',country:'Country',buyingGroup:'Buying Group',buyer:'Buyer',fabricCategory:'Fabric Category',fabricSupplierCountry:'Fabric Supplier Country',fabricSupplier:'Fabric Supplier',kumasTipi:'Fabric Type',iplikNo:'Yarn Count',fabricWeight:'Weight (GSM)',karisim:'Composition',inStoreMonth:'In-Store Month',quantity:'Quantity',fob:'LFL FOB'};
  const TRIAL_SOURCE_LABELS={fob:{tr:'Koleksiyon FOB',en:'Collection FOB'},confirmed:{tr:'Onaylı fiyat',en:'Approved price'},best:{tr:'Best price',en:'Best price'},target:{tr:'Hedef fiyat',en:'Target price'},manual:{tr:'Elle girildi',en:'Manual'}};
  const TRIAL_TEXT_FIELDS=['mag','mmyg','brandDirectorate','classification','country','buyingGroup','buyer'];
  const TRIAL_CATALOG_FIELDS=[...TRIAL_TEXT_FIELDS];
  const TRIAL_MODEL_DIM_ALIASES=Object.freeze({
    mag:['mag'],mmyg:['mmyg'],brandDirectorate:['brandDirectorate','markaMudurlugu','markaMudurluk'],
    classification:['classification','urunTipi','klasman'],
    productDescription:['productDescription','productMainDefinition','urunAnaTanim','urunAnaTanım','urunTanim','urunTanım','productDesc'],
    manufacturer:['manufacturer','uretici','nihaiUretici','finalManufacturer'],
    country:['country','ulke','ülke'],buyingGroup:['buyingGroup','buyerGroup'],buyer:['buyer'],
    fabricCategory:['fabricCategory','kumasKategorisi','kumasKategori'],
    fabricSupplierCountry:['fabricSupplierCountry','kumasciUlkesi','kumasciUlke','fabricCountry'],
    fabricSupplier:['fabricSupplier','kumasci','fabricManufacturer'],
    kumasTipi:['kumasTipi','fabricType'],iplikNo:['iplikNo','yarnCount'],
    fabricWeight:['fabricWeight','gramaj','gsm'],karisim:['karisim','composition'],
  });
  function trialLabel(k){return (isEn()?TRIAL_LABELS_EN:TRIAL_LABELS)[k]||k;}
  function trialSourceLabel(s){const m=TRIAL_SOURCE_LABELS[s];return m?(isEn()?m.en:m.tr):'';}
  function trialToast(msg){if(window.showToast)showToast(msg);}
  function trialClone(item){return JSON.parse(JSON.stringify(item));}
  const TRIAL_SCOPE_CACHE=new WeakMap();
  function trialScopeIdentities(scope){
    if(!scope||typeof scope!=='object')return Object.create(null);let cached=TRIAL_SCOPE_CACHE.get(scope);if(cached)return cached;
    cached=Object.create(null);SHARED_DIMS.forEach(dim=>{cached[dim]=new Set((scope.filters?.[dim]||[]).map(value=>dimensionIdentity(dim,value)).filter(Boolean));});TRIAL_SCOPE_CACHE.set(scope,cached);return cached;
  }
  function trialScope(){
    const season=$('lflCurrentSeason')?.value||'';
    const months=[...(state.filters.currentMonth||new Set())].filter(Boolean).sort();
    // Marka Müdürlüğü Trial kapsamına hiçbir zaman taşınmaz. Koleksiyon aşamasında
    // bu bilgi kesinleşmemiş olabileceği için Simulation Basket ve LFL analizi
    // yalnız diğer aktif boyutları kullanır.
    return {season,months,filters:Object.fromEntries(SHARED_DIMS.map(dim=>[dim,dim==='brandDirectorate'?[]:[...(state.filters[dim]||new Set())]]))};
  }
  function normalizeTrialMonth(value){const raw=norm(value);const match=/^(\d{4})-?(\d{2})$/.exec(raw);return match?`${match[1]}-${match[2]}`:'';}
  function trialAllowedMonths(scope=trialScope()){
    if(scope.months.length)return [...scope.months];
    const real=Array.isArray(state.serverRows)?state.serverRows:[];
    const values=unique(real.filter(row=>!scope.season||row.season===scope.season).map(row=>row.inStoreMonth)).filter(value=>/^\d{4}-\d{2}$/.test(value)).sort();
    const collection=window.BLCollection?.rows?window.BLCollection.rows().map(row=>normalizeTrialMonth(window.BLCollection.monthCodeFor?.(row))).filter(value=>/^\d{4}-\d{2}$/.test(value)):[];
    return unique([...values,...collection]).sort();
  }
  function trialModelId(model){return String(model&&model.id!=null?model.id:'');}
  function positiveNumber(value){const n=num(value);return n!=null&&n>0?n:null;}
  function trialModelDimensionValue(model,dim,bridge,previous){
    const rowKey=FILTER_META[dim]?.rowKey||dim,previousValue=previous&&previous[rowKey];
    if(isUsableValue(previousValue))return previousValue;
    const bridgeFn=bridge&&bridge[`${dim}For`];
    if(typeof bridgeFn==='function'){
      const bridged=bridgeFn.call(bridge,model);
      if(isUsableValue(bridged))return bridged;
    }
    const aliases=TRIAL_MODEL_DIM_ALIASES[dim]||[rowKey];
    for(const key of aliases){const value=model&&model[key];if(isUsableValue(value))return value;}
    return '';
  }
  function trialDraftFromModel(model,scope=trialScope(),previous=null){
    const bridge=window.BLCollection;
    const priced=(bridge?.fobFor?.(model))||{fob:null,source:''};
    const ownMonth=normalizeTrialMonth(bridge?.monthCodeFor?.(model));
    // Koleksiyondaki geçerli ay, aktif LFL ay filtresinin dışında olsa bile
    // değiştirilmez. Filtre dışı kalma yalnız bilgilendirme olarak gösterilir.
    const month=(previous&&previous.inStoreMonth)||ownMonth||scope.months[0]||'';
    const previousQuantity=positiveNumber(previous&&previous.quantity),modelQuantity=positiveNumber(bridge?.quantityFor?.(model))??positiveNumber(model&&model.quantity);
    const derivedFob=positiveNumber(priced.fob),dimensions={};
    // Trial satırı, LFL'de filtrelenebilen bütün portföy boyutlarını Koleksiyon
    // modelinden taşır. Aksi halde örn. Product Description filtresi seçiliyken
    // model "Ready" görünse bile sentetik satır boş kimlik yüzünden rapordan düşer.
    SHARED_DIMS.forEach(dim=>{
      const rowKey=FILTER_META[dim]?.rowKey||dim,value=trialModelDimensionValue(model,dim,bridge,previous);
      dimensions[rowKey]=resolveDimensionLabel(dim,value);
    });
    // Üretici Koleksiyon aşamasında henüz belli olmayabilir veya LFL kaynağında
    // daha önce görülmemiş yeni bir üretici olabilir. Bu alan doğrulama hatası
    // üretmez; boşsa yalnız Trial satırında sanal "Trial" üreticisi kullanılır.
    if(!isUsableValue(dimensions.manufacturer))dimensions.manufacturer='Trial';
    return {
      id:trialModelId(model),modelName:norm(model&&model.modelKod)||norm(model&&model.plmId),plmId:norm(model&&model.plmId),
      season:scope.season,inStoreMonth:month,quantity:previousQuantity??modelQuantity,
      // Fiyat kullanıcı düzeltmesi / eski Trial snapshot'ı değil, canlı Collection FOB'dur.
      fob:derivedFob,priceSource:priced.source||'fob',
      ...dimensions,
      license:norm(previous&&previous.license)||norm(model&&model.lisans),licensor:norm(previous&&previous.licensor)||norm(model&&model.licensor),
      collectionSeason:norm(model&&model.season),collectionMonth:ownMonth,image:norm(model&&model.img),
      priceBase:positiveNumber(priced.base),royalty:positiveNumber(priced.royalty)??0,hologram:positiveNumber(priced.hologram)??0,
    };
  }
  function trialValidationDetails(draft,scope=trialScope()){
    const issues=[];
    const add=(field,message,type='invalid')=>{if(!issues.some(item=>item.field===field&&item.message===message))issues.push({field,message,type});};
    if(!scope.season)add('_season',isEn()?'Select the current LFL season':'Güncel LFL sezonunu seç','missing');
    TRIAL_REQUIRED.forEach(key=>{
      const value=draft&&draft[key];
      if(key==='quantity'||key==='fob'){if(!(num(value)>0))add(key,isEn()?`${trialLabel(key)} is missing or invalid`:`${trialLabel(key)} eksik veya geçersiz`,'missing');}
      else if(!isUsableValue(value))add(key,isEn()?`${trialLabel(key)} is missing`:`${trialLabel(key)} eksik`,'missing');
    });
    TRIAL_CATALOG_FIELDS.forEach(field=>{
      // Manufacturer is intentionally open-ended. New/blank manufacturers are
      // represented as "Trial" in the simulation and never trigger a correction.
      if(field==='manufacturer')return;
      const value=draft&&draft[field];if(!isUsableValue(value))return;
      const catalog=trialCatalog(field),key=trialCandidateKey(field,value);
      if(catalog.length&&!trialCatalogKeySet(field).has(key)){
        add(field,isEn()?`${trialLabel(field)} was not found in the LFL database`:`${trialLabel(field)} LFL veri tabanında bulunamadı`,'invalid');
      }
    });
    if(draft?.inStoreMonth&&!/^\d{4}-\d{2}$/.test(draft.inStoreMonth))add('inStoreMonth',isEn()?'In-Store month format is invalid':'In-Store ayı biçimi geçersiz','invalid');
    return issues;
  }
  function trialScopeNotices(draft,scope=trialScope()){
    const notices=[];
    const add=(field,message)=>{if(!notices.some(item=>item.field===field&&item.message===message))notices.push({field,message,type:'scope'});};
    if(scope.months.length&&/^\d{4}-\d{2}$/.test(norm(draft?.inStoreMonth))&&!scope.months.includes(norm(draft.inStoreMonth))){
      add('inStoreMonth',isEn()?'In-Store month is outside the active LFL period':'In-Store ayı aktif LFL döneminin dışında');
    }
    const selectedByDim=trialScopeIdentities(scope);
    SHARED_DIMS.forEach(dim=>{
      if(dim==='brandDirectorate')return;
      const selectedKeys=selectedByDim[dim];if(!selectedKeys||!selectedKeys.size)return;
      const rowKey=FILTER_META[dim].rowKey,value=draft&&draft[rowKey];
      if(!isUsableValue(value)){add(rowKey,`${trialLabel(dim)} ${isEn()?'is not available for the active filter':'aktif filtre için mevcut değil'}`);return;}
      if(!selectedKeys.has(dimensionIdentity(dim,value)))add(rowKey,`${trialLabel(dim)} ${isEn()?'is outside the active filter':'aktif filtrenin dışında'}`);
    });
    return notices;
  }
  function trialValidation(draft,scope=trialScope()){return trialValidationDetails(draft,scope).map(item=>item.message);}
  function trialRowFrom(draft,scope=trialScope()){
    const errors=trialValidation(draft,scope);if(errors.length)return {missing:errors};
    const month=norm(draft.inStoreMonth),dimensions={};
    SHARED_DIMS.forEach(dim=>{const rowKey=FILTER_META[dim]?.rowKey||dim;dimensions[rowKey]=resolveDimensionLabel(dim,draft&&draft[rowKey]);});
    if(!isUsableValue(dimensions.manufacturer))dimensions.manufacturer='Trial';
    return {row:{
      id:`trial:${draft.id}`,sheet:'TRIAL',sourceRow:0,orderCode:`TRIAL-${draft.id}`,
      modelName:norm(draft.modelName)||norm(draft.plmId),...dimensions,
      season:scope.season,inStore:month?`${month}-01`:'',inStoreMonth:month,inStoreWeek:'',
      fob:num(draft.fob),quantity:num(draft.quantity),license:norm(draft.license),licensor:norm(draft.licensor),
      dtrType:norm(draft.licensor).toLocaleUpperCase('tr-TR')==='DTR'?'DTR':(norm(draft.licensor)?'NON-DTR':''),line:'',
      currency:isTurkeyCountry(dimensions.country||draft.country)?'TRY':'USD',isTrial:true,trialSource:draft.priceSource||'manual',trialModelId:draft.id,
      collectionSeason:norm(draft.collectionSeason),collectionMonth:norm(draft.collectionMonth),
    }};
  }
  function trialCandidates(scope=trialScope()){
    const bridge=window.BLCollection;if(!bridge)return {available:[],ordered:[]};
    const orderedKeys=bridge.orderedKeys?.()||new Set(),available=[],ordered=[];
    (bridge.rows?.()||[]).forEach(model=>{
      const previous=state.trial.items.get(trialModelId(model));
      const candidate={model,draft:trialDraftFromModel(model,scope,previous),ordered:orderedKeys.has(bridge.keyOf?.(model)),dropped:/iptal|cancel|drop/i.test(norm(model&&model.durum))};
      (candidate.ordered?ordered:available).push(candidate);
    });
    return {available,ordered};
  }
  function applyTrialRows(){
    state.analysisRevision=(state.analysisRevision||0)+1;
    const base=Array.isArray(state.serverRows)?state.serverRows:[];
    if(!state.trial.enabled||!state.trial.items.size){state.trial.rows=[];state.rows=base;return;}
    const scope=state.trial.scope||trialScope(),rows=[],bridge=window.BLCollection;
    const collectionById=new Map((bridge?.rows?.()||[]).map(model=>[trialModelId(model),model]).filter(([id])=>id));
    const refreshed=new Map();
    state.trial.items.forEach((item,id)=>{
      const key=String(id),model=collectionById.get(key);
      // Collection satırı yoksa eski fiyatı taşımak yerine FOB'u geçersiz kıl.
      const draft=model?trialDraftFromModel(model,scope,item):{...trialClone(item),fob:null,priceSource:'fob',priceBase:null};
      refreshed.set(key,draft);
      const built=trialRowFrom(draft,scope);if(built.row)rows.push(built.row);
    });
    state.trial.items=refreshed;
    // Eski sürümlerde Trial içinde FOB düzeltmesi yapılabiliyordu. Bu eski pending
    // alanlarını da temizle ki Collection FOB kuralı hiçbir yoldan bypass edilmesin.
    state.trial.pendingCorrections.forEach((fields,id)=>{if(fields&&typeof fields.delete==='function')fields.delete('fob');if(!fields||!fields.size)state.trial.pendingCorrections.delete(id);});
    state.trial.rows=rows;state.rows=rows.length?[...base,...rows]:base;
  }
  function trialConfiguredCount(){return state.trial.items.size;}
  function trialActiveCount(){return state.trial.enabled?(state.trial.rows||[]).length:0;}
  function trialClear(){state.trial.items.clear();state.trial.pendingCorrections.clear();state.trial.rows=[];state.trial.enabled=false;state.trial.scope=null;trialRefresh();}
  function trialToggle(){
    if(!trialConfiguredCount()){openTrialPanel();return;}
    state.trial.enabled=!state.trial.enabled;
    trialRefresh();
    trialToast(state.trial.enabled
      ?(isEn()?'Trial simulation turned on.':'Trial simülasyonu açıldı.')
      :(isEn()?'Trial simulation paused.':'Trial simülasyonu kapatıldı.'));
  }
  function trialImpactFor(analysis){
    if(!analysis||!trialActiveCount())return null;
    const baseline=analysis.baselineCurrent||summary([]),simulated=analysis.current,previous=analysis.previous;
    const baselineLfl=metricBetween(baseline,previous,'change'),simulatedLfl=metricBetween(simulated,previous,'change');
    return {baseline,simulated,previous,baselineLfl,simulatedLfl,lflPointImpact:baselineLfl==null||simulatedLfl==null?null:simulatedLfl-baselineLfl,
      fobImpact:metricBetween(simulated,baseline,'change'),trialQty:quantityTotal(analysis.trialCurrentRows||[]),trialModels:(analysis.trialCurrentRows||[]).length};
  }
  function renderTrialImpact(analysis){
    const host=$('lflTrialImpact');if(!host)return;const impact=trialImpactFor(analysis);host.hidden=!impact;if(!impact){host.innerHTML='';return;}
    host.innerHTML=`<div class="lflTrialImpactHead"><div><strong>${esc(isEn()?'Trial impact':'Trial etkisi')}</strong><span>${esc(isEn()?`${integer(impact.trialModels)} simulated models · ${integer(impact.trialQty)} units`:`${integer(impact.trialModels)} sanal model · ${integer(impact.trialQty)} adet`)}</span></div><button type="button" class="lflTrialImpactEdit" data-trial-impact-edit>${esc(isEn()?'Edit trial':'Trial düzenle')}</button></div>
      <div class="lflTrialImpactMetrics">
        <div><span>${esc(isEn()?'Real weighted FOB':'Gerçek ağırlıklı FOB')}</span><strong>${esc(moneySummary(impact.baseline))}</strong></div>
        <div><span>${esc(isEn()?'Real LFL':'Gerçek LFL')}</span><strong>${esc(pct(impact.baselineLfl))}</strong></div>
        <div class="isSimulated"><span>${esc(isEn()?'Trial weighted FOB':'Trial ağırlıklı FOB')}</span><strong>${esc(moneySummary(impact.simulated))}</strong></div>
        <div class="isSimulated"><span>${esc(isEn()?'Trial LFL':'Trial LFL')}</span><strong>${esc(pct(impact.simulatedLfl))}</strong></div>
        <div class="${esc(metricClass(impact.lflPointImpact,false))}"><span>${esc(isEn()?'Net LFL impact':'Net LFL etkisi')}</span><strong>${esc(impact.lflPointImpact==null?'—':`${impact.lflPointImpact>0?'+':''}${impact.lflPointImpact.toLocaleString('tr-TR',{minimumFractionDigits:1,maximumFractionDigits:1})} puan`)}</strong></div>
      </div>`;
    host.querySelector('[data-trial-impact-edit]')?.addEventListener('click',()=>openTrialPanel());
  }
  function trialUpdateButton(){
    const configured=trialConfiguredCount(),active=trialActiveCount(),enabled=state.trial.enabled&&configured>0;
    const btn=$('lflTrialBtn');
    if(btn){
      btn.classList.toggle('isOn',enabled);
      btn.classList.toggle('isPaused',configured>0&&!enabled);
      const label=$('lflTrialBtnText')||btn.querySelector('span');
      if(label)label.textContent=configured?(enabled?`Trial · ${integer(active)}`:(isEn()?`Trial · Off · ${integer(configured)}`:`Trial · Kapalı · ${integer(configured)}`)):'Trial LFL';
    }
    const banner=$('lflTrialBanner');
    if(banner){
      banner.hidden=!configured;banner.classList.toggle('isPaused',!enabled);
      const txt=$('lflTrialBannerText');
      if(txt)txt.textContent=enabled
        ?(isEn()?`${integer(active)} Collection model(s) are simulated as current-period orders. The LFL source remains unchanged.`:`${integer(active)} Koleksiyon modeli güncel dönem siparişi olarak simüle ediliyor. LFL kaynağı değişmeden kalır.`)
        :(isEn()?`Trial is off. ${integer(configured)} model(s) remain ready and can be turned on again.`:`Trial kapalı. ${integer(configured)} model hazır tutuluyor ve yeniden açılabilir.`);
      const toggle=$('lflTrialBannerOff');
      if(toggle){
        toggle.textContent=enabled?(isEn()?'Turn trial off':"Trial'ı kapat"):(isEn()?'Turn trial on':"Trial'ı aç");
        toggle.setAttribute('aria-pressed',enabled?'true':'false');
        toggle.classList.toggle('isOn',enabled);
      }
    }
  }
  function trialRefresh(){
    applyTrialRows();
    enforceTrialFilterRules();
    // Trial açılıp kapandığında filtre evreni de aynı anda değişir. Trial'a özgü
    // seçimler açıkken korunur; Trial kapatıldığında artık var olmayan seçimler
    // temizlenir ve açık filtre paneli yeni seçeneklerle anında yenilenir.
    pruneFilters();trialUpdateButton();render();
    FILTER_DIMS.forEach(dim=>{const panel=$(`lflDimPanel_${dim}`);if(panel&&!panel.hidden)renderFacetPanel(dim);});
  }
  function mountTrialButton(){
    const btn=document.getElementById('lflTrialBtn');if(btn&&!btn.dataset.trialBound){btn.dataset.trialBound='1';btn.addEventListener('click',openTrialPanel);}
    const off=$('lflTrialBannerOff');if(off&&!off.dataset.trialBound){off.dataset.trialBound='1';off.addEventListener('click',trialToggle);}
    trialUpdateButton();
  }
  const TRIAL_CATALOG_CACHE={rows:null,length:-1,lists:new Map(),keys:new Map()};
  function trialCatalogRows(){
    const rows=Array.isArray(state.serverRows)?state.serverRows:[];
    if(TRIAL_CATALOG_CACHE.rows!==rows||TRIAL_CATALOG_CACHE.length!==rows.length){
      TRIAL_CATALOG_CACHE.rows=rows;TRIAL_CATALOG_CACHE.length=rows.length;TRIAL_CATALOG_CACHE.lists.clear();TRIAL_CATALOG_CACHE.keys.clear();
    }
    return rows;
  }
  function trialCatalog(field){
    trialCatalogRows();
    if(TRIAL_CATALOG_CACHE.lists.has(field))return TRIAL_CATALOG_CACHE.lists.get(field);
    const rowKey=field==='classification'?'classification':field;
    // Doğrulama kataloğu yalnız gerçek LFL veritabanından kurulur. Liste ve
    // kimlik kümeleri veri yüklemesi başına bir kez hazırlanır; her model ve
    // her alan için bütün LFL kaynağı yeniden taranmaz.
    let values=TRIAL_CATALOG_CACHE.rows.map(row=>norm(row&&row[rowKey]));
    if(SHARED_DIMS.includes(field))values=values.map(value=>resolveDimensionLabel(field,value));
    const seen=new Set(),out=[];
    values.filter(isUsableValue).forEach(value=>{const key=trialCandidateKey(field,value);if(key&&!seen.has(key)){seen.add(key);out.push(value);}});
    out.sort((a,b)=>a.localeCompare(b,'tr-TR',{numeric:true,sensitivity:'base'}));
    TRIAL_CATALOG_CACHE.lists.set(field,out);TRIAL_CATALOG_CACHE.keys.set(field,seen);return out;
  }
  function trialCatalogKeySet(field){trialCatalog(field);return TRIAL_CATALOG_CACHE.keys.get(field)||new Set();}
  const TRIAL_CONTEXT_WEIGHTS={mag:12,mmyg:14,brandDirectorate:8,classification:11,manufacturer:5,country:7,buyingGroup:11,buyer:10};
  const TRIAL_SUGGEST_INDEX_FIELDS=['modelName',...Object.keys(TRIAL_CONTEXT_WEIGHTS),'license','licensor','season'];
  const TRIAL_SUGGEST_INDEX_CACHE={rows:null,length:-1,fields:new Map()};
  function trialCandidateKey(field,value){return SHARED_DIMS.includes(field)?dimensionIdentity(field,value):searchCompact(value);}
  function trialIndexKey(field,value){return field==='season'||field==='modelName'||field==='license'||field==='licensor'?searchCompact(value):trialCandidateKey(field,value);}
  function trialSuggestionIndex(){
    const rows=trialCatalogRows();
    if(TRIAL_SUGGEST_INDEX_CACHE.rows===rows&&TRIAL_SUGGEST_INDEX_CACHE.length===rows.length)return TRIAL_SUGGEST_INDEX_CACHE;
    const fields=new Map(TRIAL_SUGGEST_INDEX_FIELDS.map(field=>[field,new Map()]));
    rows.forEach(row=>TRIAL_SUGGEST_INDEX_FIELDS.forEach(field=>{const rowKey=FILTER_META[field]?.rowKey||field,key=trialIndexKey(field,row&&row[rowKey]);if(!key)return;const map=fields.get(field);if(!map.has(key))map.set(key,[]);map.get(key).push(row);}));
    TRIAL_SUGGEST_INDEX_CACHE.rows=rows;TRIAL_SUGGEST_INDEX_CACHE.length=rows.length;TRIAL_SUGGEST_INDEX_CACHE.fields=fields;return TRIAL_SUGGEST_INDEX_CACHE;
  }
  function trialSeasonRows(scope){
    const index=trialSuggestionIndex(),seasonKey=trialIndexKey('season',scope?.season),seasonRows=seasonKey?index.fields.get('season')?.get(seasonKey):null;
    return seasonRows&&seasonRows.length?seasonRows:index.rows;
  }
  function trialSuggestionRows(draft,excludeField,scope){
    const index=trialSuggestionIndex(),pools=[];
    TRIAL_SUGGEST_INDEX_FIELDS.forEach(field=>{if(field===excludeField||field==='season')return;const value=draft&&draft[field],key=trialIndexKey(field,value),rows=key?index.fields.get(field)?.get(key):null;if(rows&&rows.length)pools.push({field,rows});});
    pools.sort((a,b)=>{if(a.field==='modelName')return -1;if(b.field==='modelName')return 1;return a.rows.length-b.rows.length;});
    const seasonKey=trialIndexKey('season',scope?.season),pool=(pools[0]?.rows||trialSeasonRows(scope));
    if(!seasonKey)return pool;
    const filtered=pool.filter(row=>trialIndexKey('season',row&&row.season)===seasonKey);return filtered.length?filtered:trialSeasonRows(scope);
  }
  function trialEditDistance(a,b){
    a=searchCompact(a);b=searchCompact(b);if(a===b)return 0;if(!a.length)return b.length;if(!b.length)return a.length;
    let prev=Array.from({length:b.length+1},(_,i)=>i),cur=new Array(b.length+1);
    for(let i=1;i<=a.length;i++){cur[0]=i;for(let j=1;j<=b.length;j++)cur[j]=Math.min(cur[j-1]+1,prev[j]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));[prev,cur]=[cur,prev];}
    return prev[b.length];
  }
  function trialSimilarity(a,b){const aa=searchCompact(a),bb=searchCompact(b);if(!aa||!bb)return 0;return 1-trialEditDistance(aa,bb)/Math.max(aa.length,bb.length,1);}
  function trialContextScore(row,draft,excludeField=''){
    let score=0;if(norm(row&&row.season)===norm(draft&&draft.season))score+=5;
    if(searchCompact(row&&row.modelName)&&searchCompact(row&&row.modelName)===searchCompact(draft&&draft.modelName))score+=40;
    Object.entries(TRIAL_CONTEXT_WEIGHTS).forEach(([field,weight])=>{if(field===excludeField)return;const rowKey=FILTER_META[field]?.rowKey||field,a=dimensionIdentity(field,row&&row[rowKey]),b=dimensionIdentity(field,draft&&draft[rowKey]);if(a&&b&&a===b)score+=weight;});
    if(searchCompact(row&&row.license)&&searchCompact(row&&row.license)===searchCompact(draft&&draft.license))score+=4;
    if(searchCompact(row&&row.licensor)&&searchCompact(row&&row.licensor)===searchCompact(draft&&draft.licensor))score+=3;
    return score;
  }
  function trialAllowedValues(field,scope,months){
    if(field==='inStoreMonth')return unique((months||[]).filter(Boolean));
    // Düzeltme seçenekleri aktif filtreye göre daraltılmaz. Yalnız veritabanında
    // gerçekten bulunan değerler sunulur; böylece doğru Koleksiyon bilgisi sırf
    // filtre dışı diye başka bir değere çevrilmez.
    return trialCatalog(field);
  }
  function trialMonthOrdinal(value){const m=/^(\d{4})-?(\d{2})$/.exec(norm(value));return m?Number(m[1])*12+Number(m[2])-1:null;}
  function trialNumericSuggestion(draft,field,scope){
    const ranked=[];
    for(const row of trialSuggestionRows(draft,field,scope)){
      const value=num(row&&row[field]);if(!(value>0))continue;if(scope?.season&&norm(row.season)!==norm(scope.season))continue;
      const item={row,score:trialContextScore(row,draft,field)};
      if(ranked.length<25){ranked.push(item);continue;}
      let minIndex=0;for(let i=1;i<ranked.length;i++)if(ranked[i].score<ranked[minIndex].score)minIndex=i;
      if(item.score>ranked[minIndex].score)ranked[minIndex]=item;
    }
    if(!ranked.length)return null;const values=ranked.map(item=>num(item.row[field])).filter(value=>value>0).sort((a,b)=>a-b);if(!values.length)return null;
    const middle=Math.floor(values.length/2),median=values.length%2?values[middle]:(values[middle-1]+values[middle])/2;
    return field==='quantity'?Math.max(1,Math.round(median)):Math.round(median*100)/100;
  }
  function trialSuggestionFor(draft,field,issue,scope,months){
    // FOB Trial içinde tahmin/düzeltme konusu değildir; tek kaynak Collection FOB'dur.
    if(field==='fob')return null;
    if(field==='quantity'){
      const value=trialNumericSuggestion(draft,field,scope);return value==null?null:{value,reason:isEn()?'Median of the closest matching LFL rows':'En yakın eşleşen LFL satırlarının medyanı'};
    }
    const candidates=trialAllowedValues(field,scope,months);if(!candidates.length)return null;
    if(field==='inStoreMonth'){
      const origin=trialMonthOrdinal(draft.inStoreMonth)||trialMonthOrdinal(draft.collectionMonth),ranked=candidates.map((value,index)=>({value,index,dist:origin==null?index:Math.abs((trialMonthOrdinal(value)??origin)-origin)})).sort((a,b)=>a.dist-b.dist||a.index-b.index);
      return ranked.length?{value:ranked[0].value,reason:isEn()?'Closest month in the active period':'Aktif dönemdeki en yakın ay'}:null;
    }
    const current=norm(draft&&draft[field]),typoFocused=issue?.type==='invalid'&&isUsableValue(current);
    // Yazım hatasında bütün LFL satırlarını yeniden puanlamak yerine doğrudan
    // katalogdaki en yakın geçerli değeri bul. Bu, CU3W benzeri hatalarda hem
    // daha doğru hem de büyük veri kümelerinde belirgin biçimde daha hızlıdır.
    if(typoFocused){
      const ranked=candidates.map((value,index)=>({value,index,similarity:trialSimilarity(current,value)})).sort((a,b)=>b.similarity-a.similarity||a.index-b.index||a.value.localeCompare(b.value,'tr-TR',{numeric:true,sensitivity:'base'}));
      const best=ranked[0];return best?{value:best.value,reason:isEn()?'Closest valid value in the LFL database':'LFL veritabanındaki en yakın geçerli değer'}:null;
    }
    const candidateMap=new Map(candidates.map(value=>[trialCandidateKey(field,value),{value,score:0,count:0}]));
    const scoreRows=rows=>{let counted=0;rows.forEach(row=>{const rowKey=FILTER_META[field]?.rowKey||field,value=resolveDimensionLabel(field,norm(row&&row[rowKey])),key=trialCandidateKey(field,value),item=candidateMap.get(key);if(!item)return;item.score+=1+trialContextScore(row,draft,field);item.count++;counted++;});return counted;};
    const focusedRows=trialSuggestionRows(draft,field,scope);if(!scoreRows(focusedRows)&&focusedRows!==trialSeasonRows(scope))scoreRows(trialSeasonRows(scope));
    const ranked=[...candidateMap.values()].map((item,index)=>{const similarity=trialSimilarity(current,item.value);return {...item,index,similarity,rankScore:item.score+similarity*10};}).sort((a,b)=>b.rankScore-a.rankScore||b.similarity-a.similarity||b.count-a.count||a.index-b.index||a.value.localeCompare(b.value,'tr-TR',{numeric:true,sensitivity:'base'}));
    const best=ranked[0];if(!best)return null;
    return {value:best.value,reason:isEn()?'Best match from related model attributes':'İlişkili model özelliklerine göre en uygun eşleşme'};
  }
  function trialEditorField(draft,field,listId=''){
    const number=field==='quantity'||field==='fob',value=number?(draft[field]??''):norm(draft[field]);
    return `<label><span>${esc(trialLabel(field))}</span><input ${number?'type="number" step="0.01" min="0"':'type="text"'} data-trial-field="${esc(field)}" value="${esc(value)}"${listId?` list="${esc(listId)}"`:''}></label>`;
  }
  function trialSuggestionMarkup(draft,field,suggestion,loading=false){
    const label=esc(isEn()?'Suggested':'Önerilen');
    if(loading)return `<div class="lflTrialSuggestion isLoading" data-trial-suggestion-slot="1" data-trial-suggestion-id="${esc(draft.id)}" data-trial-suggestion-field="${esc(field)}"><span>${label}</span><small>${esc(isEn()?'Calculating the closest valid value…':'En yakın geçerli değer hesaplanıyor…')}</small></div>`;
    if(!suggestion)return `<div class="lflTrialSuggestion isEmpty"><span>${label}</span><small>${esc(isEn()?'No reliable suggestion was found.':'Güvenilir bir öneri bulunamadı.')}</small></div>`;
    return `<div class="lflTrialSuggestion"><span>${label}</span><strong>${esc(field==='inStoreMonth'?monthCodeLabel(suggestion.value):suggestion.value)}</strong><small>${esc(suggestion.reason)}</small><button type="button" data-trial-suggest-id="${esc(draft.id)}" data-trial-suggest-field="${esc(field)}">${esc(isEn()?'Use suggestion':'Öneriyi kullan')}</button></div>`;
  }
  function trialIssueEditor(draft,field,months,issue,scope,deferSuggestion=false){
    let editor='';
    if(field==='fob'){
      const value=positiveNumber(draft&&draft.fob);
      editor=`<label><span>${esc(trialLabel(field))}</span><input type="number" step="0.01" min="0" value="${esc(value??'')}" readonly aria-readonly="true"></label><div class="lflTrialSuggestion isEmpty"><span>${esc(isEn()?'Source':'Kaynak')}</span><small>${esc(isEn()?'LFL Trial always uses the calculated FOB from Collection. Fix the Collection price/royalty calculation if FOB is empty.':'LFL Trial her zaman Koleksiyon’daki hesaplanmış FOB değerini kullanır. FOB boşsa Collection fiyat/royalty hesabını düzelt.')}</small></div>`;
      return `<div class="lflTrialFieldEditor">${editor}</div>`;
    }
    if(field==='inStoreMonth'){
      const options=unique([draft.inStoreMonth,...months].filter(Boolean));
      editor=`<label><span>${esc(trialLabel(field))}</span><select data-trial-field="inStoreMonth"><option value="">${esc(isEn()?'Select…':'Seç…')}</option>${options.map(value=>`<option value="${esc(value)}"${value===draft.inStoreMonth?' selected':''}>${esc(monthCodeLabel(value))}</option>`).join('')}</select></label>`;
    }else{
      const listId=TRIAL_TEXT_FIELDS.includes(field)?`trialList_${field}`:'';editor=trialEditorField(draft,field,listId);
    }
    const suggestion=deferSuggestion?null:trialSuggestionFor(draft,field,issue,scope,months);
    return `<div class="lflTrialFieldEditor">${editor}${deferSuggestion?trialSuggestionMarkup(draft,field,null,true):trialSuggestionMarkup(draft,field,suggestion,false)}</div>`;
  }
  function openTrialPanel(options){
    options=options||{};
    const en=isEn(),scope=trialScope(),bridge=window.BLCollection;
    document.getElementById('_lflTrialModal')?.remove();
    if(!bridge){trialToast(en?'Collection data is not ready.':'Koleksiyon verisi hazır değil.');return;}
    if(!scope.season){trialToast(en?'Select the current LFL season first.':'Önce güncel LFL sezonunu seç.');return;}
    const canEditCollection=bridge.canEdit?.()!==false;
    const candidates=trialCandidates(scope),byId=new Map([...candidates.available,...candidates.ordered].map(item=>[trialModelId(item.model),item]));
    const working=new Map([...state.trial.items].map(([id,item])=>{
      const key=String(id),found=byId.get(key);
      return [key,found?trialDraftFromModel(found.model,scope,item):{...trialClone(item),fob:null,priceSource:'fob',priceBase:null}];
    }));
    const seeds=Array.isArray(options.seedIds)?options.seedIds.map(String):(working.size?[]:(bridge.selectedIds?.()||[]).map(String));
    let skipped=0;
    seeds.forEach(id=>{const found=byId.get(id);if(found&&!found.ordered&&!found.dropped){if(!working.has(id))working.set(id,trialDraftFromModel(found.model,scope));}else skipped++;});
    const touched=new Map([...(state.trial.pendingCorrections||new Map())].filter(([id])=>working.has(String(id))).map(([id,fields])=>[String(id),new Set([...(fields||[])].filter(field=>field!=='fob'))])),suggestionCache=new Map();
    const touch=(id,field)=>{id=String(id);if(!touched.has(id))touched.set(id,new Set());touched.get(id).add(field);};
    const touchedFieldCount=()=>[...touched.values()].reduce((sum,fields)=>sum+fields.size,0);
    const modal=document.createElement('div');modal.id='_lflTrialModal';modal.className='warnOverlay lflTrialOverlay';
    modal.innerHTML=`<div class="modalCard lflTrialStudio lflTrialStudio--compact" role="dialog" aria-modal="true" aria-labelledby="lflTrialTitle">
      <div class="lflTrialStudioHead"><div><h2 id="lflTrialTitle">${esc(en?'Simulation basket check':'Simülasyon sepeti kontrolü')}</h2><p>${esc(en?'Only missing or database-invalid classification values require correction. Manufacturer may be blank and is represented as Trial. Models outside active filters remain unchanged and are still included in Trial.':'Yalnız eksik veya veritabanında geçersiz sınıflandırma değerleri düzeltme gerektirir. Üretici boş olabilir ve Trial olarak kullanılır. Aktif filtre dışındaki modeller değiştirilmeden Trial analizine dahil edilir.')}</p></div><button type="button" class="verHistClose" data-trial-close title="${esc(en?'Close':'Kapat')}"><svg class="ic"><use href="#i-x"/></svg></button></div>
      <div class="lflTrialScopeBar"><span><strong>${esc(en?'Target period':'Hedef dönem')}:</strong> ${esc(scope.season)} · ${esc(scope.months.length?scope.months.map(monthCodeLabel).join(', '):(en?'All current months':'Tüm güncel aylar'))}</span><span class="${canEditCollection?'':'isWarning'}">${esc(canEditCollection?(en?'Corrections can be saved separately; Trial can also be applied without updating Collection.':'Düzeltmeler ayrı kaydedilebilir; Koleksiyon güncellenmeden de Trial uygulanabilir.'):(en?'Collection is view-only; temporary corrections can still be used in Trial.':'Koleksiyon yalnız görüntülenebilir; geçici düzeltmeler Trial içinde kullanılabilir.'))}</span></div>
      <div class="lflTrialCompactStats" id="lflTrialCompactStats" data-bl-tabs="metrics" role="tablist" aria-label="${esc(en?'Simulation basket views':'Simülasyon sepeti görünümleri')}"></div>
      <div class="lflTrialIssueList" id="lflTrialDraftList" role="tabpanel" aria-labelledby="lflTrialView-all" tabindex="0"></div>
      <div class="lflTrialStudioFoot"><span id="lflTrialFootNote"></span><button type="button" class="lflButton lflButton--ghost" data-trial-close>${esc(en?'Cancel':'Vazgeç')}</button><button type="button" class="lflButton lflButton--tonal" data-trial-remove>${esc(en?'Remove active trial':'Aktif trialı kaldır')}</button><button type="button" class="lflButton lflButton--tonal" id="lflTrialSave">${esc(en?'Save corrections':'Düzeltmeleri kaydet')}</button><button type="button" class="lflButton" id="lflTrialApply">${esc(en?'Apply Trial':"Trial'ı uygula")}</button></div>
      ${TRIAL_TEXT_FIELDS.map(field=>`<datalist id="trialList_${field}">${trialCatalog(field).map(value=>`<option value="${esc(value)}"></option>`).join('')}</datalist>`).join('')}
    </div>`;
    document.body.appendChild(modal);
    const draftHost=modal.querySelector('#lflTrialDraftList'),statsHost=modal.querySelector('#lflTrialCompactStats'),foot=modal.querySelector('#lflTrialFootNote'),saveBtn=modal.querySelector('#lflTrialSave'),applyBtn=modal.querySelector('#lflTrialApply');
    const months=trialAllowedMonths(scope);let renderedGroups=[],renderedIssueMap=new Map(),activeView='needs',viewInitialized=false,renderToken=0;
    const uiYield=()=>new Promise(resolve=>setTimeout(resolve,0));
    function snapshot(){
      const entries=[...working.values()].map(draft=>{const issues=trialValidationDetails(draft,scope),notices=trialScopeNotices(draft,scope);return {draft,issues,notices,ready:issues.length===0};});
      return {entries,invalid:entries.filter(item=>item.issues.length),ready:entries.filter(item=>!item.issues.length),outside:entries.filter(item=>item.notices.length)};
    }
    function suggestionKey(draft,issue){
      return JSON.stringify([draft.id,issue.field,issue.type,scope.season,months,...TRIAL_TEXT_FIELDS.map(field=>draft[field]),draft.inStoreMonth,draft.collectionMonth,draft.quantity,draft.fob,draft.license,draft.licensor,draft.modelName]);
    }
    function suggestionForIssue(draft,issue){
      if(!issue||!issue.field||issue.field==='_season')return null;
      const key=suggestionKey(draft,issue);if(suggestionCache.has(key))return suggestionCache.get(key);
      const suggestion=trialSuggestionFor(draft,issue.field,issue,scope,months);suggestionCache.set(key,suggestion||null);return suggestion||null;
    }
    function applySuggestion(draft,issue){
      const suggestion=suggestionForIssue(draft,issue);if(!suggestion)return false;
      draft[issue.field]=suggestion.value;touch(draft.id,issue.field);return true;
    }
    function groupedIssues(entries){
      const groups=new Map();
      entries.forEach(({draft,issues})=>issues.forEach(issue=>{const key=`${issue.type}|${issue.field}|${issue.message}`;if(!groups.has(key))groups.set(key,{key,issue,models:[]});groups.get(key).models.push({draft,issue});}));
      return [...groups.values()].sort((a,b)=>a.issue.message.localeCompare(b.issue.message,'tr-TR',{numeric:true,sensitivity:'base'}));
    }
    function emptyView(title,detail,icon='i-search'){
      return `<div class="lflTrialEmpty"><svg class="ic"><use href="#${icon}"/></svg><strong>${esc(title)}</strong><span>${esc(detail)}</span></div>`;
    }
    function modelRow(entry,detailMode='all'){
      const {draft,issues,notices}=entry,status=[];
      if(issues.length)status.push(`<span class="isIssue">${esc(en?`${issues.length} correction(s)`:`${issues.length} düzeltme`)}</span>`);else status.push(`<span class="isReady">${esc(en?'Ready':'Hazır')}</span>`);
      if(notices.length)status.push(`<span class="isNotice">${esc(en?'Outside active filter':'Aktif filtre dışında')}</span>`);
      const details=detailMode==='outside'?notices:(detailMode==='ready'?notices:[...issues,...notices]);
      return `<article class="lflTrialModelRow" data-trial-draft="${esc(draft.id)}"><header><div><strong>${esc(`${draft.plmId||'—'} · ${draft.modelName||'—'}`)}</strong><div class="lflTrialModelStatuses">${status.join('')}</div></div><button type="button" class="lflTrialRemoveModel" data-trial-remove-id="${esc(draft.id)}" title="${esc(en?'Remove':'Çıkar')}"><svg class="ic"><use href="#i-trash"/></svg></button></header>${details.length?`<div class="lflTrialModelDetails">${details.map(item=>`<span class="${item.type==='scope'?'isNotice':'isIssue'}">${esc(item.message)}</span>`).join('')}</div>`:''}</article>`;
    }
    function renderModelList(entries,mode,emptyTitle,emptyDetail){
      if(!entries.length)return emptyView(emptyTitle,emptyDetail,mode==='ready'?'i-check':'i-search');
      return `<div class="lflTrialModelList">${entries.map(entry=>modelRow(entry,mode)).join('')}</div>`;
    }
    function renderStats(data){
      const items=[
        {view:'all',label:en?'Total models':'Toplam model',count:data.entries.length,cls:''},
        {view:'ready',label:en?'Ready':'Hazır',count:data.ready.length,cls:'isReady'},
        {view:'needs',label:en?'Needs correction':'Düzeltme gerekli',count:data.invalid.length,cls:data.invalid.length?'isIssue':''},
        {view:'outside',label:en?'Outside active filter':'Aktif filtre dışında',count:data.outside.length,cls:data.outside.length?'isNotice':''},
      ];
      statsHost.innerHTML=items.map(item=>`<button type="button" id="lflTrialView-${item.view}" role="tab" data-trial-view="${item.view}" aria-controls="lflTrialDraftList" aria-selected="${activeView===item.view?'true':'false'}" tabindex="${activeView===item.view?'0':'-1'}" class="${item.cls}${activeView===item.view?' isActive':''}"><span>${esc(item.label)}</span><strong>${integer(item.count)}</strong></button>`).join('');
      draftHost.setAttribute('aria-labelledby',`lflTrialView-${activeView}`);
    }
    async function hydrateVisibleSuggestions(token){
      const slots=[...draftHost.querySelectorAll('[data-trial-suggestion-slot]')];
      for(let index=0;index<slots.length;index++){
        if(token!==renderToken||!modal.isConnected)return;
        const slot=slots[index],id=String(slot.dataset.trialSuggestionId||''),field=slot.dataset.trialSuggestionField,draft=working.get(id),issue=renderedIssueMap.get(`${id}|${field}`);
        if(draft&&issue)slot.outerHTML=trialSuggestionMarkup(draft,field,suggestionForIssue(draft,issue),false);
        if((index+1)%2===0)await uiYield();
      }
      
    }
    function mountTrialMarkup(markup,fallbackMarkup=''){
      // Uygulamanın geri kalanında olduğu gibi doğrudan innerHTML kullanılır.
      // Önceki template/replaceChildren yolu bazı Chromium tabanlı kurulumlarda
      // sayaçlar dolu olduğu hâlde tabpanel içeriğini boş bırakabiliyordu.
      draftHost.hidden=false;
      draftHost.removeAttribute('hidden');
      draftHost.style.display='block';
      draftHost.innerHTML=String(markup||'').trim();
      if(!draftHost.firstElementChild&&fallbackMarkup)draftHost.innerHTML=String(fallbackMarkup||'').trim();
      // Gerçek bir model sayısı varken görünüm yine boş kalırsa son savunma olarak
      // okunabilir bir model listesi kurulması renderIssues içinde doğrulanır.
    }
    function renderNeedsMarkup(data){
      renderedGroups=groupedIssues(data.invalid);renderedIssueMap=new Map();
      if(!renderedGroups.length)return emptyView(en?'No correction is required':'Düzeltme gerekmiyor',en?'All models contain valid database values.':'Tüm modeller geçerli veritabanı değerlerine sahip.','i-check');
      return renderedGroups.map((group,groupIndex)=>{
        group.models.forEach(({draft,issue})=>renderedIssueMap.set(`${draft.id}|${issue.field}`,issue));
        const canSuggest=group.issue.field!=='_season';
        return `<section class="lflTrialIssueGroup" data-trial-error-group="${groupIndex}"><header class="lflTrialIssueGroupHead"><div><strong>${esc(group.issue.message)}</strong><span>${esc(en?`${group.models.length} model(s)`:`${group.models.length} model`)}</span></div><button type="button" class="lflTrialAutoGroup" data-trial-suggest-group="${groupIndex}"${canSuggest?'':' disabled'}>${esc(en?'Auto Suggestion':'Otomatik Öneri')}</button></header><div class="lflTrialIssueModels">${group.models.map(({draft,issue})=>`<article class="lflTrialIssueModel" data-trial-draft="${esc(draft.id)}"><header><div><strong>${esc(`${draft.plmId||'—'} · ${draft.modelName||'—'}`)}</strong><span>${esc(`${trialLabel(issue.field)}: ${isUsableValue(draft[issue.field])?draft[issue.field]:(en?'Blank':'Boş')}`)}</span></div><button type="button" class="lflTrialRemoveModel" data-trial-remove-id="${esc(draft.id)}" title="${esc(en?'Remove':'Çıkar')}"><svg class="ic"><use href="#i-trash"/></svg></button></header><div class="lflTrialIssueFields">${issue.field==='_season'?'':trialIssueEditor(draft,issue.field,months,issue,scope,true)}</div></article>`).join('')}</div></section>`;
      }).join('');
    }
    function renderOutsideMarkup(data){
      if(!data.outside.length)return emptyView(en?'No model is outside the active filter':'Aktif filtre dışında model yok',en?'Every basket model matches the current LFL filters.':'Sepetteki tüm modeller güncel LFL filtreleriyle eşleşiyor.','i-check');
      return `<section class="lflTrialNoticeGroup"><header><div><strong>${esc(en?'Models outside active LFL filters':'Aktif LFL filtreleri dışındaki modeller')}</strong><span>${esc(en?`${data.outside.length} model(s) remain unchanged and are included in Trial.`:`${data.outside.length} model değiştirilmeden Trial analizine dahil edilir.`)}</span></div></header><p>${esc(en?'This view is informational. Being outside the current filter never creates a correction or changes Collection data.':'Bu görünüm yalnız bilgilendirme amaçlıdır. Aktif filtrenin dışında olmak düzeltme oluşturmaz ve Koleksiyon verisini değiştirmez.')}</p><div class="lflTrialModelList">${data.outside.map(entry=>modelRow(entry,'outside')).join('')}</div></section>`;
    }
    function renderIssues(){
      const token=++renderToken,data=snapshot(),issueCount=data.invalid.reduce((sum,item)=>sum+item.issues.length,0),outsideCount=data.outside.length;
      if(!viewInitialized){activeView=data.invalid.length?'needs':(data.outside.length?'outside':'all');viewInitialized=true;}
      renderStats(data);draftHost.dataset.view=activeView;renderedGroups=[];renderedIssueMap=new Map();
      let markup='',fallback='';
      try{
        if(!data.entries.length)markup=emptyView(en?'No model in the basket':'Sepette model yok',en?'Select models in Collection and send them to LFL Trial.':"Koleksiyonda modelleri seçip LFL Trial'a gönder.",'i-hanger');
        else if(activeView==='ready')markup=renderModelList(data.ready,'ready',en?'No ready model':'Hazır model yok',en?'Models that require correction are available under Needs correction.':'Düzeltme gerektiren modeller Düzeltme gerekli bölümündedir.');
        else if(activeView==='needs'){
          markup=renderNeedsMarkup(data);
          fallback=renderModelList(data.invalid,'all',en?'No correction is required':'Düzeltme gerekmiyor',en?'All models contain valid database values.':'Tüm modeller geçerli veritabanı değerlerine sahip.');
        }else if(activeView==='outside'){
          markup=renderOutsideMarkup(data);
          fallback=renderModelList(data.outside,'outside',en?'No model is outside the active filter':'Aktif filtre dışında model yok',en?'Every basket model matches the current LFL filters.':'Sepetteki tüm modeller güncel LFL filtreleriyle eşleşiyor.');
        }else markup=renderModelList(data.entries,'all',en?'No model in the basket':'Sepette model yok',en?'Select models in Collection and send them to LFL Trial.':"Koleksiyonda modelleri seçip LFL Trial'a gönder.");
        mountTrialMarkup(markup,fallback);
        const expectedCount=activeView==='ready'?data.ready.length:(activeView==='needs'?data.invalid.length:(activeView==='outside'?data.outside.length:data.entries.length));
        if(expectedCount>0&&!draftHost.firstElementChild){
          const emergencyEntries=activeView==='ready'?data.ready:(activeView==='needs'?data.invalid:(activeView==='outside'?data.outside:data.entries));
          mountTrialMarkup(renderModelList(emergencyEntries,activeView==='outside'?'outside':(activeView==='ready'?'ready':'all'),en?'No model could be displayed':'Model görüntülenemedi',en?'Close and reopen the Simulation Basket.':'Simülasyon Sepetini kapatıp yeniden açın.'));
        }
      }catch(error){
        console.error('Simulation basket view could not be rendered:',error);
        mountTrialMarkup(renderModelList(activeView==='outside'?data.outside:(activeView==='needs'?data.invalid:data.entries),activeView==='outside'?'outside':'all',en?'No model could be displayed':'Model görüntülenemedi',en?'Close and reopen the Simulation Basket.':'Simülasyon Sepetini kapatıp yeniden açın.'));
      }
      if(activeView==='needs'&&draftHost.querySelector('[data-trial-suggestion-slot]'))setTimeout(()=>hydrateVisibleSuggestions(token),0);
      const suffix=skipped?(en?` · ${skipped} unavailable model(s) skipped`:` · ${skipped} kullanılamayan model atlandı`):'';
      const outsideSuffix=outsideCount?(en?` · ${outsideCount} model(s) outside active filters remain unchanged`:` · Aktif filtre dışındaki ${outsideCount} model değiştirilmez`):'';
      const changed=touchedFieldCount();
      foot.textContent=!data.entries.length?(en?'The simulation cannot be applied without a model.':'Model olmadan simülasyon uygulanamaz.')
        :data.invalid.length?(en?`${data.invalid.length} model(s), ${issueCount} field(s) require real data correction before Trial can be applied${outsideSuffix}${suffix}.`:`Trial uygulanmadan önce ${data.invalid.length} modelde ${issueCount} gerçek veri alanı düzeltilmeli${outsideSuffix}${suffix}.`)
        :changed?(canEditCollection
          ?(en?`${changed} unsaved correction(s): save them to Collection or apply them only to Trial${outsideSuffix}${suffix}.`:`${changed} kaydedilmemiş düzeltme var: Koleksiyon’a kaydedebilir veya yalnız Trial içinde uygulayabilirsiniz${outsideSuffix}${suffix}.`)
          :(en?`${changed} temporary correction(s) will be used only in Trial; Collection is view-only${outsideSuffix}${suffix}.`:`${changed} geçici düzeltme yalnız Trial içinde kullanılacak; Koleksiyon görüntüleme modunda${outsideSuffix}${suffix}.`))
        :(en?`All ${data.ready.length} model(s) are ready${outsideSuffix}${suffix}.`:`${data.ready.length} model hazır${outsideSuffix}${suffix}.`);
      saveBtn.disabled=!canEditCollection||!changed||!!data.invalid.length;
      applyBtn.disabled=!data.entries.length||!!data.invalid.length;
    }
    statsHost.addEventListener('click',event=>{const button=event.target.closest('[data-trial-view]');if(!button)return;if(button.dataset.trialView!==activeView){activeView=button.dataset.trialView;renderIssues();}statsHost.querySelector(`[data-trial-view="${activeView}"]`)?.focus();});
    statsHost.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;const tabs=[...statsHost.querySelectorAll('[data-trial-view]')],current=Math.max(0,tabs.indexOf(document.activeElement));let next=current;if(event.key==='ArrowLeft')next=(current-1+tabs.length)%tabs.length;if(event.key==='ArrowRight')next=(current+1)%tabs.length;if(event.key==='Home')next=0;if(event.key==='End')next=tabs.length-1;event.preventDefault();tabs[next]?.click();});
    draftHost.addEventListener('input',event=>{
      const card=event.target.closest('[data-trial-draft]'),field=event.target.dataset.trialField;if(!card||!field)return;const item=working.get(card.dataset.trialDraft);if(!item)return;
      if(field==='fob')return;
      item[field]=field==='quantity'?(event.target.value===''?null:Number(event.target.value)):event.target.value;touch(item.id,field);
    });
    draftHost.addEventListener('change',event=>{
      const card=event.target.closest('[data-trial-draft]'),field=event.target.dataset.trialField;if(!card||!field)return;const item=working.get(card.dataset.trialDraft);if(!item)return;
      if(field==='fob')return;
      item[field]=field==='quantity'?(event.target.value===''?null:Number(event.target.value)):event.target.value;touch(item.id,field);renderIssues();
    });
    draftHost.addEventListener('click',async event=>{
      const removeBtn=event.target.closest('[data-trial-remove-id]');if(removeBtn){working.delete(removeBtn.dataset.trialRemoveId);touched.delete(String(removeBtn.dataset.trialRemoveId));renderIssues();return;}
      const suggestionBtn=event.target.closest('[data-trial-suggest-id]');if(suggestionBtn){const item=working.get(String(suggestionBtn.dataset.trialSuggestId)),field=suggestionBtn.dataset.trialSuggestField;if(!item||!field)return;const issue=trialValidationDetails(item,scope).find(entry=>entry.field===field);if(applySuggestion(item,issue))renderIssues();return;}
      const groupBtn=event.target.closest('[data-trial-suggest-group]');if(groupBtn){const group=renderedGroups[Number(groupBtn.dataset.trialSuggestGroup)];if(!group)return;const oldText=groupBtn.textContent;groupBtn.disabled=true;groupBtn.textContent=en?'Applying…':'Uygulanıyor…';let changed=0;for(let index=0;index<group.models.length;index++){const {draft,issue}=group.models[index];if(applySuggestion(draft,issue))changed++;if((index+1)%2===0)await uiYield();}if(!changed)trialToast(en?'No reliable suggestion was found for this error group.':'Bu hata grubu için güvenilir öneri bulunamadı.');if(modal.isConnected)renderIssues();else{groupBtn.disabled=false;groupBtn.textContent=oldText;}return;}
    });
    const close=()=>{renderToken++;document.removeEventListener('keydown',onKey);modal.remove();};const onKey=event=>{if(event.key==='Escape')close();};document.addEventListener('keydown',onKey);
    modal.addEventListener('click',event=>{if(event.target===modal||event.target.closest('[data-trial-close]'))close();});
    modal.querySelector('[data-trial-remove]')?.addEventListener('click',()=>{trialClear();trialToast(en?'Trial simulation removed.':'Trial simülasyonu kaldırıldı.');close();});
    const pendingChanges=()=>[...touched].map(([id,fields])=>{const draft=working.get(String(id));return draft&&fields.size?{id:String(id),fields:Object.fromEntries([...fields].map(field=>[field,draft[field]]))}:null;}).filter(Boolean);
    saveBtn.addEventListener('click',async()=>{
      const data=snapshot();if(data.invalid.length){activeView='needs';renderIssues();trialToast(en?'Correct the missing or database-invalid Trial fields before saving.':'Kaydetmeden önce eksik veya veritabanında geçersiz Trial alanlarını düzelt.');return;}
      const changes=pendingChanges();if(!changes.length){trialToast(en?'There are no unsaved corrections.':'Kaydedilmemiş düzeltme yok.');return;}
      if(!canEditCollection){trialToast(en?'Collection is view-only; corrections can only be used temporarily in Trial.':'Koleksiyon yalnız görüntülenebilir; düzeltmeler yalnız Trial içinde geçici olarak kullanılabilir.');return;}
      const oldText=saveBtn.textContent;saveBtn.disabled=true;saveBtn.textContent=en?'Saving…':'Kaydediliyor…';
      try{
        if(typeof bridge.applyTrialCorrections!=='function')throw new Error(en?'Collection update bridge is unavailable.':'Koleksiyon güncelleme köprüsü kullanılamıyor.');
        const persisted=await Promise.resolve(bridge.applyTrialCorrections(changes));if(persisted&&persisted.ok===false)throw new Error(persisted.error||(en?'Collection could not be updated.':'Koleksiyon güncellenemedi.'));
        touched.clear();state.trial.pendingCorrections.clear();saveBtn.textContent=oldText;
        const updated=Number(persisted?.updatedFields)||0;trialToast(en?`${updated} correction(s) saved to Collection. Trial has not been applied yet.`:`${updated} düzeltme Koleksiyon’a kaydedildi. Trial henüz uygulanmadı.`);renderIssues();
      }catch(err){trialToast(err?.message||String(err));saveBtn.disabled=false;saveBtn.textContent=oldText;}
    });
    applyBtn.addEventListener('click',()=>{
      const data=snapshot();if(data.invalid.length){activeView='needs';renderIssues();trialToast(en?'Correct the missing or database-invalid Trial fields.':'Eksik veya veritabanında geçersiz Trial alanlarını düzelt.');return;}
      const changes=pendingChanges();
      state.trial.items=new Map([...working].map(([id,item])=>[id,trialClone(item)]));
      state.trial.pendingCorrections=new Map([...touched].map(([id,fields])=>[String(id),new Set(fields)]));
      const appliedScope=trialClone(scope);if(appliedScope.filters)appliedScope.filters.brandDirectorate=[];
      state.trial.scope=appliedScope;state.trial.enabled=state.trial.items.size>0;trialRefresh();
      trialToast(changes.length
        ?(en?`${integer(trialActiveCount())} model(s) applied to LFL Trial. ${changes.reduce((sum,item)=>sum+Object.keys(item.fields).length,0)} correction(s) were used only in Trial and were not saved to Collection.`:`${integer(trialActiveCount())} model LFL Trial'a uygulandı. ${changes.reduce((sum,item)=>sum+Object.keys(item.fields).length,0)} düzeltme yalnız Trial içinde kullanıldı ve Koleksiyon'a kaydedilmedi.`)
        :(en?`${integer(trialActiveCount())} model(s) applied to the LFL simulation.`:`${integer(trialActiveCount())} model LFL simülasyonuna uygulandı.`));close();
    });
    renderIssues();
  }
  window.openLflTrialFromCollection=async function(ids){
    if(!state.rows.length&&!state.loading)await load(false);else if(state.loading)await new Promise(resolve=>{const started=Date.now(),timer=setInterval(()=>{if(!state.loading||Date.now()-started>15000){clearInterval(timer);resolve();}},80);});
    openTrialPanel({seedIds:Array.isArray(ids)?ids:[]});
  };
  function customCompareValue(row,dim){
    if(BREAKDOWN_META[dim])return breakdownValue(row,dim);
    if(dim==='lflKey')return [row&&row.mag,row&&row.mmyg,row&&row.classification].map(norm).filter(Boolean).join(' · ');
    if(CUSTOM_COMPARE_META[dim]?.monthCode)return monthCodeLabel(norm(row&&row[CUSTOM_COMPARE_META[dim].rowKey]));
    const key=CUSTOM_COMPARE_META[dim]?.rowKey||dim;return norm(row&&row[key]);
  }
  function quantityTotal(rows){return (rows||[]).reduce((sum,row)=>{const q=num(row&&row.quantity);return sum+(q>0?q:0);},0);}
  function uniqueOrderCount(rows){return new Set((rows||[]).map(orderKey).filter(Boolean)).size;}
  function customCompareOptionsFromRows(currentRows,previousRows,dimension){
    const map=new Map(),collect=(rows,side)=>rows.forEach(row=>{const value=customCompareValue(row,dimension);if(!isUsableValue(value))return;if(!map.has(value))map.set(value,{value,currentQty:0,previousQty:0,currentOrders:new Set(),previousOrders:new Set()});const item=map.get(value),q=num(row.quantity);if(q>0)item[side+'Qty']+=q;const key=orderKey(row);if(key)item[side+'Orders'].add(key);});
    collect(currentRows||[],'current');collect(previousRows||[],'previous');
    return [...map.values()].map(item=>({value:item.value,currentQty:item.currentQty,previousQty:item.previousQty,currentOrders:item.currentOrders.size,previousOrders:item.previousOrders.size})).sort((a,b)=>b.currentQty-a.currentQty||b.previousQty-a.previousQty||a.value.localeCompare(b.value,'tr-TR',{numeric:true}));
  }
  // Backward-compatible single-dimension helper retained for tests and old saved workflows.
  function customComparisonRows(currentRows,previousRows,dimension,selectedValues){
    const selected=[...new Set((selectedValues||[]).filter(isUsableValue).map(String))],currentTotal=quantityTotal(currentRows),previousTotal=quantityTotal(previousRows);
    return selected.map(value=>{
      const cRows=(currentRows||[]).filter(row=>customCompareValue(row,dimension)===value),pRows=(previousRows||[]).filter(row=>customCompareValue(row,dimension)===value),current=summary(cRows),previous=summary(pRows),currentQty=quantityTotal(cRows),previousQty=quantityTotal(pRows);
      return {value,currentRows:cRows,previousRows:pRows,current,previous,currentQty,previousQty,currentOrders:uniqueOrderCount(cRows),previousOrders:uniqueOrderCount(pRows),currentModels:new Set(cRows.map(r=>countryKey(r.modelName)).filter(Boolean)).size,previousModels:new Set(pRows.map(r=>countryKey(r.modelName)).filter(Boolean)).size,currentShare:currentTotal>0?currentQty/currentTotal*100:0,previousShare:previousTotal>0?previousQty/previousTotal*100:0,qtyChange:previousQty>0?(currentQty-previousQty)/previousQty*100:null,priceChange:metricBetween(current,previous,'change'),improvement:metricBetween(current,previous,'improvement')};
    });
  }
  function customCompareDimensions(){const dims=[...new Set((state.customCompare.dimensions||[]).filter(dim=>CUSTOM_COMPARE_AXIS_DIMS.includes(dim)))].slice(0,3);return dims.length?dims:['mag'];}
  function customCompareExcludedDims(dimensions){return new Set((dimensions||[]).flatMap(dim=>dim==='lflKey'?['mag','mmyg','classification']:[dim]));}
  function customCompareBaseRows(a,dimensions){
    const excluded=customCompareExcludedDims(dimensions),dims={};SHARED_DIMS.forEach(key=>{dims[key]=excluded.has(key)?new Set():state.filters[key];});
    return {currentRows:filterRows(state.rows,{season:a.currentSeason,dateField:a.currentDateField,periods:a.currentMonths,...dims}),previousRows:filterRows(state.rows,{season:a.compareSeason,dateField:a.compareDateField,periods:a.compareMonths,...dims})};
  }
  function ensureCustomCompareSelections(base,dimensions){
    const optionsByDim={};
    dimensions.forEach((dim,index)=>{
      const options=customCompareOptionsFromRows(base.currentRows,base.previousRows,dim);optionsByDim[dim]=options;
      const hadState=state.customCompare.values[dim] instanceof Set,available=new Set(options.map(item=>item.value)),existing=hadState?state.customCompare.values[dim]:new Set();
      const selected=new Set([...existing].filter(value=>available.has(value)));
      if(!hadState&&state.filters[dim]?.size){[...state.filters[dim]].filter(value=>available.has(value)).forEach(value=>selected.add(value));}
      if(!hadState&&!selected.size&&!state.customCompare.seeded){const limit=index===0?Math.min(5,options.length):Math.min(3,options.length);options.slice(0,limit).forEach(item=>selected.add(item.value));}
      state.customCompare.values[dim]=selected;
    });
    Object.keys(state.customCompare.values).forEach(dim=>{if(!dimensions.includes(dim))delete state.customCompare.values[dim];});
    return optionsByDim;
  }
  function rowMatchesCustomSelections(row,dimensions,valuesMap=state.customCompare.values){return dimensions.every(dim=>{const selected=valuesMap[dim];return !selected||!selected.size||selected.has(customCompareValue(row,dim));});}
  function customCombinationKey(row,dimensions){return dimensions.map(dim=>customCompareValue(row,dim)).filter(Boolean).join(' · ');}
  function multiComparisonRows(currentRows,previousRows,dimensions,valuesMap=state.customCompare.values){
    const map=new Map(),collect=(rows,side)=>rows.filter(row=>rowMatchesCustomSelections(row,dimensions,valuesMap)).forEach(row=>{const key=customCombinationKey(row,dimensions);if(!key)return;if(!map.has(key))map.set(key,{value:key,currentRows:[],previousRows:[]});map.get(key)[side+'Rows'].push(row);});
    collect(currentRows||[],'current');collect(previousRows||[],'previous');
    const currentTotal=quantityTotal((currentRows||[]).filter(row=>rowMatchesCustomSelections(row,dimensions,valuesMap))),previousTotal=quantityTotal((previousRows||[]).filter(row=>rowMatchesCustomSelections(row,dimensions,valuesMap)));
    return [...map.values()].map(item=>{const current=summary(item.currentRows),previous=summary(item.previousRows),currentQty=quantityTotal(item.currentRows),previousQty=quantityTotal(item.previousRows);return {...item,current,previous,currentQty,previousQty,currentOrders:uniqueOrderCount(item.currentRows),previousOrders:uniqueOrderCount(item.previousRows),currentShare:currentTotal>0?currentQty/currentTotal*100:0,previousShare:previousTotal>0?previousQty/previousTotal*100:0,qtyChange:previousQty>0?(currentQty-previousQty)/previousQty*100:null,priceChange:metricBetween(current,previous,'change')};});
  }
  function relativePercent(value,reference){const v=num(value),r=num(reference);return v==null||r==null||r===0?null:(v-r)/r*100;}
  function customCompareRelativeClasses(r){return {relativeQty:tablePriceClass(r.relativeQty),relativeOrders:tablePriceClass(r.relativeOrders),relativeFob:tablePriceClass(r.relativeFob)};}
  function customCompareSortRows(rows){
    const key=state.customCompare.sort,dir=state.customCompare.dir;
    return [...rows].sort((a,b)=>{if(key==='name')return a.value.localeCompare(b.value,'tr-TR',{numeric:true})*dir;const av=a[key],bv=b[key];if(av==null&&bv==null)return a.value.localeCompare(b.value,'tr-TR',{numeric:true});if(av==null)return 1;if(bv==null)return -1;return (av-bv)*dir||a.value.localeCompare(b.value,'tr-TR',{numeric:true});});
  }
  function customCompareAnalysis(a){
    const dimensions=customCompareDimensions(),base=customCompareBaseRows(a,dimensions),optionsByDim=ensureCustomCompareSelections(base,dimensions);let rows=multiComparisonRows(base.currentRows,base.previousRows,dimensions);
    const defaultReference=[...rows].sort((x,y)=>y.currentQty-x.currentQty||y.previousQty-x.previousQty)[0]?.value||'';
    if(!rows.some(row=>row.value===state.customCompare.reference))state.customCompare.reference=defaultReference;
    const reference=rows.find(row=>row.value===state.customCompare.reference)||null;
    rows=rows.map(row=>{const enriched={...row,relativeQty:reference?relativePercent(row.currentQty,reference.currentQty):null,relativeOrders:reference?relativePercent(row.currentOrders,reference.currentOrders):null,relativeFob:reference?metricBetween(row.current,reference.current,'change'):null,isReference:reference?.value===row.value};return {...enriched,relativeClasses:customCompareRelativeClasses(enriched)};});
    rows=customCompareSortRows(rows);saveCustomCompare();
    return {dimensions,base,optionsByDim,rows,reference,currentTotal:quantityTotal(base.currentRows),previousTotal:quantityTotal(base.previousRows)};
  }
  function closeCustomComparePanels(exceptAxis=-1){for(let i=0;i<3;i++){if(i===exceptAxis)continue;const panel=$(`lflCustomComparePanel${i}`),btn=$(`lflCustomCompareValueBtn${i}`);if(panel)panel.hidden=true;if(btn)btn.setAttribute('aria-expanded','false');}}
  function customCompareValueText(values){if(!values.length)return isEn()?'All values':'Tüm değerler';if(values.length===1)return values[0];if(values.length===2)return values.join(' · ');return `${values.slice(0,2).join(' · ')} +${values.length-2}`;}
  function renderCustomComparePanel(a,axisIndex){
    const panel=$(`lflCustomComparePanel${axisIndex}`);if(!panel)return;const c=customCompareAnalysis(a),dim=c.dimensions[axisIndex];if(!dim){panel.hidden=true;return;}const options=c.optionsByDim[dim]||[],selected=state.customCompare.values[dim]||new Set(),label=customCompareLabel(dim);
    panel.innerHTML=`<div class="lflCustomComparePanelHead"><div><strong>${esc(label)}</strong><span>${isEn()?`${selected.size} selected · maximum 10`:`${selected.size} seçili · en fazla 10`}</span></div><div class="lflCustomComparePanelActions">${state.filters[dim]?.size?`<button type="button" class="lflCustomCompareMiniBtn" data-custom-main>${isEn()?'Main Filter':'Ana Filtre'}</button>`:''}<button type="button" class="lflCustomCompareMiniBtn" data-custom-top>${isEn()?'Top 5':'En yüksek 5'}</button><button type="button" class="lflCustomCompareMiniBtn isClear" data-custom-clear>${isEn()?'All':'Tümü'}</button></div></div><div class="lflCustomCompareSearchWrap"><input type="search" class="lflCustomCompareSearch" placeholder="${isEn()?'Search…':'Ara…'}" autocomplete="off"></div><div class="lflCustomCompareOptions">${options.map(item=>`<label class="lflCustomCompareOption${selected.has(item.value)?' isSelected':''}" data-search="${esc(item.value)}"><input type="checkbox" value="${esc(item.value)}"${selected.has(item.value)?' checked':''}><span class="lflCustomCompareOptionMain"><strong>${esc(item.value)}</strong><small>${isEn()?`${integer(item.currentOrders)} / ${integer(item.previousOrders)} orders`:`${integer(item.currentOrders)} / ${integer(item.previousOrders)} sipariş`}</small></span><em>${integer(item.currentQty)} / ${integer(item.previousQty)}</em></label>`).join('')||`<div class="lflDimNoResult">${esc(isEn()?'No selectable value was found.':'Seçilebilir değer bulunamadı.')}</div>`}</div>`;
    panel.querySelector('[data-custom-main]')?.addEventListener('click',()=>{const asOption=v=>CUSTOM_COMPARE_META[dim]?.monthCode?monthCodeLabel(v):v;state.customCompare.values[dim]=new Set([...state.filters[dim]].map(asOption).filter(value=>options.some(item=>item.value===value)));state.customCompare.reference='';state.customCompare.seeded=true;saveCustomCompare();renderCustomCompare(a);renderCustomComparePanel(a,axisIndex);});
    panel.querySelector('[data-custom-top]')?.addEventListener('click',()=>{state.customCompare.values[dim]=new Set(options.slice(0,Math.min(5,options.length)).map(item=>item.value));state.customCompare.reference='';state.customCompare.seeded=true;saveCustomCompare();renderCustomCompare(a);renderCustomComparePanel(a,axisIndex);});
    panel.querySelector('[data-custom-clear]')?.addEventListener('click',()=>{state.customCompare.values[dim].clear();state.customCompare.reference='';state.customCompare.seeded=true;saveCustomCompare();renderCustomCompare(a);renderCustomComparePanel(a,axisIndex);});
    panel.querySelectorAll('.lflCustomCompareOption input').forEach(input=>input.addEventListener('change',()=>{const set=state.customCompare.values[dim];if(input.checked&&set.size>=10&&!set.has(input.value)){input.checked=false;if(window.showToast)showToast(isEn()?'You can select up to 10 values per breakdown.':'Her kırılımda en fazla 10 değer seçebilirsin.');return;}if(input.checked)set.add(input.value);else set.delete(input.value);state.customCompare.reference='';state.customCompare.seeded=true;saveCustomCompare();renderCustomCompare(a);renderCustomComparePanel(a,axisIndex);}));
    panel.querySelector('.lflCustomCompareSearch')?.addEventListener('input',event=>{const terms=normalizeSearchTerms(event.target.value);let visible=0;panel.querySelectorAll('.lflCustomCompareOption[data-search]').forEach(row=>{const match=matchesSearch(row.dataset.search,terms);row.hidden=!match;if(match)visible++;});let empty=panel.querySelector('.lflCustomCompareSearchEmpty');if(!empty){empty=document.createElement('div');empty.className='lflDimNoResult lflCustomCompareSearchEmpty';empty.textContent=isEn()?'No value matches this search.':'Aramayla eşleşen değer yok.';panel.querySelector('.lflCustomCompareOptions')?.appendChild(empty);}empty.hidden=visible>0;});
  }
  function toggleCustomComparePanel(axisIndex){const panel=$(`lflCustomComparePanel${axisIndex}`),btn=$(`lflCustomCompareValueBtn${axisIndex}`);if(!panel||!btn||btn.disabled)return;const open=panel.hidden;closePanels();closeReadyPanel();closeBreakdownPanel();closeCustomComparePanels(open?axisIndex:-1);panel.hidden=!open;btn.setAttribute('aria-expanded',open?'true':'false');if(open){renderCustomComparePanel(state.analysis||compute(),axisIndex);setTimeout(()=>panel.querySelector('.lflCustomCompareSearch')?.focus(),0);}}
  function customCompareSortHeader(key,label,cls='num'){const active=state.customCompare.sort===key;return `<th class="${cls}" data-custom-sort="${key}">${esc(label)}${active?(state.customCompare.dir>0?' ↑':' ↓'):''}</th>`;}
  function updateCustomCompareDimension(axisIndex,value){
    const dimensions=customCompareDimensions();
    if(!value){dimensions.splice(axisIndex);}
    else if(axisIndex<dimensions.length)dimensions[axisIndex]=value;
    else dimensions.push(value);
    state.customCompare.dimensions=[...new Set(dimensions.filter(dim=>CUSTOM_COMPARE_AXIS_DIMS.includes(dim)))].slice(0,3);if(!state.customCompare.dimensions.length)state.customCompare.dimensions=['mag'];
    if(value&&!(state.customCompare.values[value] instanceof Set)){
      const a=state.analysis||compute(),base=customCompareBaseRows(a,state.customCompare.dimensions),options=customCompareOptionsFromRows(base.currentRows,base.previousRows,value),main=state.filters[value]||new Set(),limit=axisIndex===0?5:3;
      const selected=[...main].filter(item=>options.some(option=>option.value===item));state.customCompare.values[value]=new Set((selected.length?selected:options.slice(0,limit).map(option=>option.value)));
    }
    state.customCompare.reference='';state.customCompare.seeded=true;saveCustomCompare();closeCustomComparePanels();render();
  }
  function scenarioResultCacheKey(scenario){
    return JSON.stringify({
      dataset:`${analysisDatasetRevision}|${state.analysisRevision||0}|${state.loadedAt||''}|${state.serverRows.length}|${state.rows.length}`,
      lang:isEn()?'en':'tr',scenario:serializeComparisonScenario(scenario),
      global:Object.fromEntries(SHARED_DIMS.map(dim=>[dim,globalScenarioFilterValues(state.filters,dim)])),
      breakdown:[...state.breakdown],dateFields:[state.periods.current.dateField,state.periods.compare.dateField],
    });
  }
  function cachedScenarioComparisonResult(item){
    const key=scenarioResultCacheKey(item),cached=lflScenarioCache.get(key);if(cached)return cached;
    const result=scenarioComparisonResult(state.rows,item,state.filters);lflScenarioCache.set(key,result);return result;
  }
  function comparisonScenarioResults(a){return ensureComparisonScenarios(a).map(item=>cachedScenarioComparisonResult(item));}
  function renderComparisonScenarioCards(a,results){
    const host=$('lflScenarioCards');if(!host)return;
    host.innerHTML=results.map((result,index)=>{
      const hasComparable=result.priceChange!=null,filters=scenarioScopeParts(result),periodCurrent=scenarioPeriodLabel(result.currentSeason,result.currentMonths,result.currentDateField),periodPrevious=scenarioPeriodLabel(result.compareSeason,result.compareMonths,result.compareDateField);
      return `<article class="lflScenarioCard${hasComparable?'':' hasNoData'}" data-scenario-id="${esc(result.id)}"><div class="lflScenarioCardHead"><div><span class="lflScenarioIndex">${index+1}</span><strong>${esc(result.name)}</strong></div><div class="lflScenarioCardActions"><button type="button" class="lflScenarioIconBtn" data-scenario-edit="${esc(result.id)}" title="${esc(isEn()?'Edit comparison':'Karşılaştırmayı düzenle')}"><svg class="ic"><use href="#i-pencil"/></svg></button><button type="button" class="lflScenarioIconBtn" data-scenario-clone="${esc(result.id)}" title="${esc(isEn()?'Duplicate':'Çoğalt')}"><svg class="ic"><use href="#i-copy"/></svg></button><button type="button" class="lflScenarioIconBtn isDanger" data-scenario-delete="${esc(result.id)}" title="${esc(isEn()?'Delete':'Sil')}"><svg class="ic"><use href="#i-trash"/></svg></button></div></div><div class="lflScenarioPeriods"><div><small>${esc(isEn()?'Current':'Güncel')}</small><span>${esc(periodCurrent)}</span></div><svg class="ic"><use href="#i-chevron-right"/></svg><div><small>${esc(isEn()?'Comparison':'Kıyas')}</small><span>${esc(periodPrevious)}</span></div></div><div class="lflScenarioScopeChips">${filters.map(text=>`<span>${esc(text)}</span>`).join('')}</div><div class="lflScenarioResult"><div><small>${esc(isEn()?'Current weighted FOB':'Güncel ağırlıklı FOB')}</small><strong>${moneySummary(result.current)}</strong><em>${integer(result.currentQty)} ${esc(isEn()?'units':'adet')}</em></div><div><small>${esc(isEn()?'Comparison weighted FOB':'Kıyas ağırlıklı FOB')}</small><strong>${moneySummary(result.previous)}</strong><em>${integer(result.previousQty)} ${esc(isEn()?'units':'adet')}</em></div><div class="lflScenarioDelta ${tablePriceClass(result.priceChange)}"><small>LFL</small><strong>${comparablePct(result.priceChange)}</strong><em>${hasComparable?esc(result.priceChange<0?(isEn()?'Improvement':'İyileşme'):(isEn()?'Increase':'Artış')):esc(isEn()?'No comparable data':'Kıyaslanacak veri yok')}</em></div></div></article>`;
    }).join('');
    host.querySelectorAll('[data-scenario-edit]').forEach(btn=>btn.addEventListener('click',()=>openComparisonScenarioEditor(btn.dataset.scenarioEdit)));
    host.querySelectorAll('[data-scenario-clone]').forEach(btn=>btn.addEventListener('click',()=>cloneComparisonScenario(btn.dataset.scenarioClone,a)));
    host.querySelectorAll('[data-scenario-delete]').forEach(btn=>btn.addEventListener('click',()=>deleteComparisonScenario(btn.dataset.scenarioDelete,a)));
  }
  function closeComparisonScenarioEditor(){const modal=$('lflScenarioEditor');if(modal){modal.hidden=true;modal.setAttribute('aria-hidden','true');}document.body.classList.remove('lflScenarioEditorOpen');state.customCompare.editingId='';state.customCompare.editorDraft=null;}
  function openComparisonScenarioEditor(id='',fallback=null){
    const base=(state.customCompare.scenarios||[]).find(item=>item.id===id)||fallback||defaultComparisonScenario(state.customCompare.scenarios.length,state.analysis||compute()),current=reconcileComparisonScenario(base,state.analysis||compute());
    state.customCompare.editingId=id||'';state.customCompare.editorDraft=normalizeComparisonScenario(JSON.parse(JSON.stringify(serializeComparisonScenario(current))),state.customCompare.scenarios.length);state.customCompare.editorDim=SHARED_DIMS.find(dim=>state.customCompare.editorDraft.filters[dim]?.length)||'buyingGroup';state.customCompare.editorSearch='';
    const modal=$('lflScenarioEditor');if(modal){modal.hidden=false;modal.setAttribute('aria-hidden','false');}document.body.classList.add('lflScenarioEditorOpen');renderComparisonScenarioEditor();setTimeout(()=>$('lflScenarioName')?.focus(),0);
  }
  function scenarioSeasonOptions(selected){const seasons=unique((state.meta.dimensions&&state.meta.dimensions.seasons)||state.rows.map(row=>row.season)).sort(seasonSort);return seasons.map(value=>`<option value="${esc(value)}"${value===selected?' selected':''}>${esc(value)}</option>`).join('');}
  function scenarioDateFieldOptions(selected){const active=scenarioDateField(selected,'inStore');return DATE_FIELDS.map(value=>`<option value="${esc(value)}"${value===active?' selected':''}>${esc(dateFieldLabel(value))}</option>`).join('');}
  function scenarioMonthChecklist(scenario,side){
    const selected=new Set(side==='current'?scenario.currentMonths:scenario.compareMonths),available=scenarioAvailableMonths(scenario,side),values=unique([...selected,...available]).sort();
    return values.length?values.map(value=>`<label class="lflScenarioMonthOption${selected.has(value)?' isSelected':''}"><input type="checkbox" data-scenario-month="${side}" value="${esc(value)}"${selected.has(value)?' checked':''}><span>${esc(scenarioMonthLabel(value))}</span></label>`).join(''):`<div class="lflScenarioNoOption">${esc(isEn()?'No month found for this season and scope.':'Bu sezon ve kapsam için ay bulunamadı.')}</div>`;
  }
  function renderComparisonScenarioEditor(){
    const body=$('lflScenarioEditorBody'),scenario=state.customCompare.editorDraft;if(!body||!scenario)return;
    const dim=SHARED_DIMS.includes(state.customCompare.editorDim)?state.customCompare.editorDim:'buyingGroup',selected=new Set(scenario.filters[dim]||[]),options=scenarioAvailableValues(scenario,dim),available=new Map(options.map(item=>[item.value,item])),values=[...new Set([...selected,...options.map(item=>item.value)])],filterChips=SHARED_DIMS.filter(key=>scenario.filters[key]?.length).map(key=>`<button type="button" class="lflScenarioFilterChip${key===dim?' isActive':''}" data-scenario-filter-dim="${key}"><span>${esc(customCompareLabel(key))}</span><strong>${scenario.filters[key].length}</strong><svg class="ic" data-scenario-filter-clear="${key}"><use href="#i-x"/></svg></button>`).join('');
    body.innerHTML=`<div class="lflScenarioIdentity"><label class="lflField"><span>${esc(isEn()?'Comparison name':'Karşılaştırma adı')}</span><input id="lflScenarioName" type="text" maxlength="80" value="${esc(scenario.name)}"></label><label class="lflScenarioSwitch"><input type="checkbox" id="lflScenarioInheritGlobal"${scenario.inheritGlobal!==false?' checked':''}><span></span><div><strong>${esc(isEn()?'Use active main filters':'Aktif ana filtreleri temel al')}</strong><small>${esc(isEn()?'Turn on for live main-filter changes. Turning it off freezes the current main scope in this scenario.':'Canlı ana filtre değişiklikleri için aç. Kapatıldığında mevcut ana kapsam bu senaryoya sabitlenir.')}</small></div></label></div><div class="lflScenarioPeriodGrid"><section class="lflScenarioPeriodBlock"><div class="lflScenarioPeriodHead"><div><strong>${esc(isEn()?'Current period':'Güncel dönem')}</strong><small>${esc(isEn()?'Weighted average numerator':'Ağırlıklı ortalamanın güncel tarafı')}</small></div><button type="button" class="lflScenarioMiniBtn" data-scenario-month-clear="current">${esc(isEn()?'All months':'Tüm aylar')}</button></div><label class="lflField"><span>${esc(isEn()?'Date field':'Tarih alanı')}</span><select data-scenario-date-field="current">${scenarioDateFieldOptions(scenario.currentDateField)}</select></label><label class="lflField"><span>${esc(isEn()?'Season':'Sezon')}</span><select data-scenario-season="current">${scenarioSeasonOptions(scenario.currentSeason)}</select></label><div class="lflScenarioMonthGrid">${scenarioMonthChecklist(scenario,'current')}</div></section><section class="lflScenarioPeriodBlock"><div class="lflScenarioPeriodHead"><div><strong>${esc(isEn()?'Comparison period':'Kıyas dönemi')}</strong><small>${esc(isEn()?'Weighted average denominator':'Ağırlıklı ortalamanın kıyas tarafı')}</small></div><div class="lflScenarioPeriodActions"><button type="button" class="lflScenarioMiniBtn" data-scenario-shift-year>${esc(isEn()?'Copy −1 year':'1 yıl geri eşleştir')}</button><button type="button" class="lflScenarioMiniBtn" data-scenario-month-clear="compare">${esc(isEn()?'All months':'Tüm aylar')}</button></div></div><label class="lflField"><span>${esc(isEn()?'Date field':'Tarih alanı')}</span><select data-scenario-date-field="compare">${scenarioDateFieldOptions(scenario.compareDateField)}</select></label><label class="lflField"><span>${esc(isEn()?'Season':'Sezon')}</span><select data-scenario-season="compare">${scenarioSeasonOptions(scenario.compareSeason)}</select></label><div class="lflScenarioMonthGrid">${scenarioMonthChecklist(scenario,'compare')}</div></section></div><section class="lflScenarioFilterEditor"><div class="lflScenarioFilterHead"><div><strong>${esc(isEn()?'Portfolio scope':'Portföy kapsamı')}</strong><small>${esc(isEn()?'Add any number of filters; values within a field are OR, fields are AND.':'İstenen alanları ekle; aynı alandaki değerler VEYA, farklı alanlar VE mantığıyla çalışır.')}</small></div><select id="lflScenarioFilterDimension">${SHARED_DIMS.map(key=>`<option value="${key}"${key===dim?' selected':''}>${esc(customCompareLabel(key))}</option>`).join('')}</select></div><div class="lflScenarioFilterChips">${filterChips||`<span class="lflScenarioFilterEmpty">${esc(scenario.inheritGlobal!==false?(isEn()?'No override; active main filters apply.':'Özel kapsam yok; aktif ana filtreler uygulanır.'):(isEn()?'No filter; all portfolio applies.':'Filtre yok; tüm portföy uygulanır.'))}</span>`}</div><div class="lflScenarioValuePicker"><div class="lflScenarioValuePickerHead"><div><strong>${esc(customCompareLabel(dim))}</strong><span>${selected.size?`${selected.size} ${esc(isEn()?'selected':'seçili')}`:esc(isEn()?'All values':'Tüm değerler')}</span></div><button type="button" class="lflScenarioMiniBtn" data-scenario-filter-clear="${dim}"${selected.size?'':' disabled'}>${esc(isEn()?'Clear':'Temizle')}</button></div><input type="search" id="lflScenarioValueSearch" placeholder="${esc(isEn()?'Search values…':'Değer ara…')}" autocomplete="off"><div class="lflScenarioValueOptions">${values.map(value=>{const item=available.get(value)||{currentQty:0,previousQty:0};return `<label class="lflScenarioValueOption${selected.has(value)?' isSelected':''}" data-search="${esc(value)}"><input type="checkbox" data-scenario-filter-value="${esc(dim)}" value="${esc(value)}"${selected.has(value)?' checked':''}><span><strong>${esc(value)}</strong><small>${integer(item.currentQty)} / ${integer(item.previousQty)} ${esc(isEn()?'units':'adet')}</small></span></label>`;}).join('')||`<div class="lflScenarioNoOption">${esc(isEn()?'No selectable value was found.':'Seçilebilir değer bulunamadı.')}</div>`}</div></div></section>`;
    bindComparisonScenarioEditor();
  }
  function bindComparisonScenarioEditor(){
    const body=$('lflScenarioEditorBody'),scenario=state.customCompare.editorDraft;if(!body||!scenario)return;
    $('lflScenarioName')?.addEventListener('input',event=>{scenario.name=event.target.value.slice(0,80);});
    $('lflScenarioInheritGlobal')?.addEventListener('change',event=>{if(event.target.checked)scenario.inheritGlobal=true;else freezeScenarioScope(scenario,state.filters,true);renderComparisonScenarioEditor();});
    body.querySelectorAll('[data-scenario-date-field]').forEach(select=>select.addEventListener('change',()=>{const side=select.dataset.scenarioDateField;scenario[side==='current'?'currentDateField':'compareDateField']=normalizeDateField(select.value);scenario[side==='current'?'currentMonths':'compareMonths']=[];renderComparisonScenarioEditor();}));
    body.querySelectorAll('[data-scenario-season]').forEach(select=>select.addEventListener('change',()=>{const side=select.dataset.scenarioSeason;scenario[side==='current'?'currentSeason':'compareSeason']=select.value;scenario[side==='current'?'currentMonths':'compareMonths']=[];renderComparisonScenarioEditor();}));
    body.querySelectorAll('[data-scenario-month]').forEach(input=>input.addEventListener('change',()=>{const key=input.dataset.scenarioMonth==='current'?'currentMonths':'compareMonths',set=new Set(scenario[key]);if(input.checked)set.add(input.value);else set.delete(input.value);scenario[key]=[...set].sort();renderComparisonScenarioEditor();}));
    body.querySelectorAll('[data-scenario-month-clear]').forEach(btn=>btn.addEventListener('click',()=>{scenario[btn.dataset.scenarioMonthClear==='current'?'currentMonths':'compareMonths']=[];renderComparisonScenarioEditor();}));
    body.querySelector('[data-scenario-shift-year]')?.addEventListener('click',()=>{scenario.compareDateField=scenarioDateField(scenario.currentDateField,state.periods.current.dateField);scenario.compareMonths=scenario.currentMonths.map(value=>shiftMonth(value,-1));const seasons=unique((state.meta.dimensions&&state.meta.dimensions.seasons)||state.rows.map(row=>row.season));const prior=previousSeason(scenario.currentSeason,seasons);if(prior)scenario.compareSeason=prior;renderComparisonScenarioEditor();});
    $('lflScenarioFilterDimension')?.addEventListener('change',event=>{state.customCompare.editorDim=event.target.value;state.customCompare.editorSearch='';renderComparisonScenarioEditor();});
    body.querySelectorAll('[data-scenario-filter-dim]').forEach(btn=>btn.addEventListener('click',event=>{if(event.target.closest('[data-scenario-filter-clear]'))return;state.customCompare.editorDim=btn.dataset.scenarioFilterDim;renderComparisonScenarioEditor();}));
    body.querySelectorAll('[data-scenario-filter-clear]').forEach(btn=>btn.addEventListener('click',event=>{event.stopPropagation();const dim=btn.dataset.scenarioFilterClear;scenario.filters[dim]=[];state.customCompare.editorDim=dim;renderComparisonScenarioEditor();}));
    body.querySelectorAll('[data-scenario-filter-value]').forEach(input=>input.addEventListener('change',()=>{const dim=input.dataset.scenarioFilterValue,set=new Set(scenario.filters[dim]||[]);if(input.checked)set.add(input.value);else set.delete(input.value);scenario.filters[dim]=[...set];renderComparisonScenarioEditor();}));
    $('lflScenarioValueSearch')?.addEventListener('input',event=>{const terms=normalizeSearchTerms(event.target.value);let visible=0;body.querySelectorAll('.lflScenarioValueOption[data-search]').forEach(row=>{const match=matchesSearch(row.dataset.search,terms);row.hidden=!match;if(match)visible++;});let empty=body.querySelector('.lflScenarioSearchEmpty');if(!empty){empty=document.createElement('div');empty.className='lflScenarioNoOption lflScenarioSearchEmpty';empty.textContent=isEn()?'No value matches this search.':'Aramayla eşleşen değer yok.';body.querySelector('.lflScenarioValueOptions')?.appendChild(empty);}empty.hidden=visible>0;});
  }
  function saveComparisonScenarioEditor(){
    const draft=normalizeComparisonScenario(state.customCompare.editorDraft||{},state.customCompare.scenarios.length);if(!draft.name)draft.name=isEn()?'Comparison':'Karşılaştırma';
    const index=state.customCompare.scenarios.findIndex(item=>item.id===state.customCompare.editingId);if(index>=0){draft.id=state.customCompare.editingId;state.customCompare.scenarios[index]=draft;}else state.customCompare.scenarios.push(draft);
    saveCustomCompare();closeComparisonScenarioEditor();renderCustomCompare(state.analysis||compute());
  }
  function cloneComparisonScenario(id,a){const source=state.customCompare.scenarios.find(item=>item.id===id);if(!source||state.customCompare.scenarios.length>=12)return;const clone=normalizeComparisonScenario({...serializeComparisonScenario(source),id:comparisonScenarioId(),name:`${source.name} ${isEn()?'Copy':'Kopya'}`},state.customCompare.scenarios.length);state.customCompare.scenarios.push(clone);saveCustomCompare();renderCustomCompare(a);openComparisonScenarioEditor(clone.id);}
  function deleteComparisonScenario(id,a){
    // v6.35 — son kayıt da silinebilir; scenariosSeeded sayesinde liste boş kalır.
    state.customCompare.scenarios=state.customCompare.scenarios.filter(item=>item.id!==id);
    state.customCompare.scenariosSeeded=true;
    saveCustomCompare();renderCustomCompare(a);
  }
  async function refreshComparisonScenarios(){
    // Kayıtlı senaryo tanımlarını veri yenilemesinden tamamen bağımsız tut.
    // Kaynak yenilenirken render/reconcile geçici olarak ay veya sezonları budasa bile
    // yenileme bitince aynı dönem + aynı portföy filtreleriyle yeniden hesaplanır.
    const snapshots=(state.customCompare.scenarios||[]).map((item,index)=>serializeComparisonScenario(item,index));
    if(!snapshots.length){
      if(window.showToast)showToast(isEn()?'There are no saved comparisons to refresh.':'Yenilenecek kayıtlı karşılaştırma yok.');
      return false;
    }
    const btn=$('lflScenarioRefreshBtn'),label=btn?.querySelector('span');
    if(btn)btn.disabled=true;if(label)label.textContent=isEn()?'Refreshing…':'Yenileniyor…';
    let ok=false;
    try{
      ok=await load(true,{silent:true,preserveOnError:true});
      state.customCompare.scenarios=snapshots.map((item,index)=>normalizeComparisonScenario(item,index));
      state.customCompare.scenariosSeeded=true;
      saveCustomCompare();lflScenarioCache.clear();
      renderCustomCompare(state.analysis||compute());
      if(window.showToast){
        showToast(ok
          ?(isEn()?(snapshots.length+' saved comparison(s) refreshed with the latest LFL data using the same filters.'):(snapshots.length+' kayıtlı karşılaştırma aynı filtrelerle güncel LFL verisine göre yenilendi.'))
          :(isEn()?'Saved comparisons could not be refreshed; the previous results were kept.':'Kayıtlı karşılaştırmalar yenilenemedi; önceki sonuçlar korundu.'));
      }
      return ok;
    }finally{
      const current=$('lflScenarioRefreshBtn'),currentLabel=current?.querySelector('span');
      if(currentLabel)currentLabel.textContent=isEn()?'Refresh summaries':'Özetleri Yenile';
      if(current)current.disabled=state.loading||!state.customCompare.scenarios.length;
    }
  }
  function renderCustomCompare(a){
    const scenarios=ensureComparisonScenarios(a),results=comparisonScenarioResults(a);if(!$('lflScenarioCards'))return;
    $('lflCustomCompareTitle').textContent=isEn()?'Multi-dimensional Comparison · Independent Scenarios':'Çok Boyutlu Karşılaştırma · Bağımsız Senaryolar';
    $('lflCustomCompareSubtitle').textContent=isEn()?'Compare different periods and portfolio scopes as separate weighted-average scenarios.':'Farklı dönem ve portföy kapsamlarını ayrı ağırlıklı ortalama senaryoları olarak yan yana karşılaştır.';
    $('lflCustomCompareScope').textContent=isEn()?'Each row has independent seasons, date fields, month sets and portfolio filters. Weighted FOB is Σ(FOB × Quantity) / Σ(Quantity); LFL uses only breakdown/currency pairs that exist in both periods, matching the main report. A scenario filter replaces the matching main filter.':'Her satırın sezonları, tarih alanları, ay setleri ve portföy filtreleri bağımsızdır. Ağırlıklı FOB = Σ(FOB × Quantity) / Σ(Quantity); LFL ana raporla aynı şekilde yalnız iki dönemde de bulunan kırılım/para birimi çiftlerini hesaba katar. Senaryo filtresi aynı ana filtrenin yerine geçer.';
    renderComparisonScenarioCards(a,results);
    const columns=[
      {key:'name',label:isEn()?'Comparison':'Karşılaştırma',value:r=>r.name,type:'text',html:r=>`<strong>${esc(r.name)}</strong>`,weight:15},
      {key:'scope',label:isEn()?'Portfolio Scope':'Portföy Kapsamı',value:r=>scenarioScopeLabel(r),display:r=>scenarioScopeLabel(r),type:'text',weight:24},
      {key:'currentPeriod',label:isEn()?'Current Period':'Güncel Dönem',value:r=>scenarioPeriodLabel(r.currentSeason,r.currentMonths,r.currentDateField),display:r=>scenarioPeriodLabel(r.currentSeason,r.currentMonths,r.currentDateField),type:'text',weight:18},
      {key:'previousPeriod',label:isEn()?'Comparison Period':'Kıyas Dönemi',value:r=>scenarioPeriodLabel(r.compareSeason,r.compareMonths,r.compareDateField),display:r=>scenarioPeriodLabel(r.compareSeason,r.compareMonths,r.compareDateField),type:'text',weight:18},
      {key:'currentQty',label:isEn()?'Current Units':'Güncel Adet',value:r=>r.currentQty,display:r=>integer(r.currentQty),type:'number',integer:true,cls:'num',weight:10},
      {key:'previousQty',label:isEn()?'Comparison Units':'Kıyas Adet',value:r=>r.previousQty,display:r=>integer(r.previousQty),type:'number',integer:true,cls:'num',weight:10},
      {key:'qtyChange',label:isEn()?'Volume Change':'Hacim Değişimi',value:r=>r.qtyChange,display:r=>pct(r.qtyChange),type:'number',cls:'num',cellClass:r=>tablePriceClass(r.qtyChange),weight:10},
      {key:'currentFob',label:isEn()?'Current Weighted FOB':'Güncel Ağırlıklı FOB',value:r=>r.current.avg??r.current.byCurrency.USD?.avg??r.current.byCurrency.TRY?.avg,display:r=>moneySummary(r.current),exportDisplay:true,type:'number',cls:'num',weight:13},
      {key:'previousFob',label:isEn()?'Comparison Weighted FOB':'Kıyas Ağırlıklı FOB',value:r=>r.previous.avg??r.previous.byCurrency.USD?.avg??r.previous.byCurrency.TRY?.avg,display:r=>moneySummary(r.previous),exportDisplay:true,type:'number',cls:'num',weight:13},
      {key:'priceChange',label:isEn()?'Weighted LFL Change':'Ağırlıklı LFL Değişimi',value:r=>r.priceChange,display:r=>comparablePct(r.priceChange),type:'number',cls:'num',cellClass:r=>tablePriceClass(r.priceChange),weight:12},
    ];
    renderCpTable({tableId:'lflCustomCompareTable',viewName:'customCompare',columns,sourceRows:results,title:()=>$('lflCustomCompareTitle')?.textContent||(isEn()?'Independent LFL Comparisons':'Bağımsız LFL Karşılaştırmaları'),drillKey:'name',onDrill:r=>openLflPortfolioModal({title:r.name,currentRows:r.currentRows,previousRows:r.previousRows,currentSeason:r.currentSeason,compareSeason:r.compareSeason}),emptyText:isEn()?'Add at least one comparison scenario.':'En az bir karşılaştırma senaryosu ekle.'});
    const add=$('lflScenarioAddBtn');if(add){add.disabled=scenarios.length>=12;add.title=scenarios.length>=12?(isEn()?'Maximum 12 comparisons':'En fazla 12 karşılaştırma'):'';}
    const refresh=$('lflScenarioRefreshBtn');if(refresh){const label=refresh.querySelector('span');if(label)label.textContent=isEn()?'Refresh summaries':'Özetleri Yenile';refresh.disabled=state.loading||!scenarios.length;refresh.title=isEn()?'Reload the latest LFL data and recalculate every saved comparison with exactly the same periods and portfolio filters.':'En güncel LFL verisini yeniden yükle ve tüm kayıtlı karşılaştırmaları aynı dönem ve portföy filtreleriyle tekrar hesapla.';}
  }
  function fabricDetailColumns(){return [
    {key:'fabricCategory',label:isEn()?'Fabric Category':'Kumaş Kategorisi',value:r=>r.fabricCategory||'',type:'text'},
    {key:'fabricSupplierCountry',label:isEn()?'Fabric Supplier Country':'Kumaşçı Ülkesi',value:r=>r.fabricSupplierCountry||'',type:'text'},
    {key:'fabricSupplier',label:isEn()?'Fabric Supplier':'Kumaşçı',value:r=>r.fabricSupplier||'',type:'text'},
    {key:'kumasTipi',label:isEn()?'Fabric Type':'Kumaş Tipi',value:r=>r.kumasTipi||'',type:'text'},
    {key:'iplikNo',label:isEn()?'Yarn Count':'İplik No',value:r=>r.iplikNo||'',type:'text'},
    {key:'fabricWeight',label:isEn()?'Weight (GSM)':'Gramaj',value:r=>r.fabricWeight||'',type:'text'},
    {key:'karisim',label:isEn()?'Composition':'Karışım',value:r=>r.karisim||'',type:'text'},
  ];}
  function detailColumns(){return [
    {key:'rowType',label:isEn()?'Type':'Tür',value:r=>r.isTrial?'TRIAL':'REAL',display:r=>r.isTrial?'TRIAL':(isEn()?'Real':'Gerçek'),type:'text'},
    {key:'orderCode',label:'Order Code',value:r=>r.orderCode||'',type:'text'},
    {key:'modelName',label:isEn()?'Model':'Model',value:r=>r.modelName||'',type:'text'},
    {key:'mag',label:'MAG',value:r=>r.mag||'',type:'text'},
    {key:'mmyg',label:'MMYG',value:r=>r.mmyg||'',type:'text'},
    {key:'classification',label:isEn()?'Classification':'Klasman',value:r=>r.classification||'',type:'text'},
    {key:'season',label:isEn()?'Season':'Sezon',value:r=>r.season||'',type:'text'},
    {key:'opd',label:'OPD',value:r=>r.opd||'',display:r=>dateTR(r.opd),type:'date'},
    {key:'exFactory',label:isEn()?'Ex-F.':'Ex-F.',value:r=>r.exFactory||'',display:r=>dateTR(r.exFactory),type:'date'},
    {key:'inStore',label:'In-Store',value:r=>r.inStore||'',display:r=>dateTR(r.inStore),type:'date'},
    {key:'manufacturer',label:isEn()?'Manufacturer':'Üretici',value:r=>r.manufacturer||'',type:'text'},
    {key:'country',label:isEn()?'Country':'Ülke',value:r=>r.country||'',type:'text'},
    {key:'buyingGroup',label:'Buying Group',value:r=>r.buyingGroup||'',type:'text'},
    {key:'buyer',label:'Buyer',value:r=>r.buyer||'',type:'text'},
    ...(state.showFabricDetails?fabricDetailColumns():[]),
    {key:'fob',label:'FOB',value:r=>num(r.fob),display:r=>money(r.fob,currencyForRow(r)),type:'number',cls:'num'},
    {key:'quantity',label:isEn()?'Quantity':'Miktar',value:r=>num(r.quantity),display:r=>integer(r.quantity),type:'number',cls:'num'},
    {key:'amount',label:isEn()?'Amount':'Tutar',value:r=>(num(r.fob)||0)*(num(r.quantity)||0),display:r=>money((num(r.fob)||0)*(num(r.quantity)||0),currencyForRow(r)),type:'number',cls:'num'},
  ];}
  function updateFabricDetailsButton(){
    const btn=$('lflFabricDetailsBtn'),label=$('lflFabricDetailsBtnText');if(!btn)return;
    btn.classList.toggle('isOn',!!state.showFabricDetails);btn.setAttribute('aria-pressed',state.showFabricDetails?'true':'false');
    if(label)label.textContent=isEn()?'Fabric Details':'Kumaş Detayları';
    btn.title=state.showFabricDetails?(isEn()?'Hide main fabric fields in portfolio details':'Portföy detaylarında ana kumaş alanlarını gizle'):(isEn()?'Show main fabric fields in portfolio details':'Portföy detaylarında ana kumaş alanlarını göster');
  }
  function toggleFabricDetails(){
    state.showFabricDetails=!state.showFabricDetails;saveFilters();render();
    if(lflPortfolioModalState)renderLflPortfolioModal();
  }

  function render(){
    enforceTrialFilterRules();
    trialUpdateButton();
    updateFabricDetailsButton();
    updateAllFilterButtons();
    if(!state.rows.length){$('lflContent').hidden=true;$('lflEmpty').hidden=false;updatePortfolioAccessButtons(null);renderSource();return;}
    $('lflContent').hidden=false;$('lflEmpty').hidden=true;
    // Ayırıcı ancak lflContent görünür olduğunda ölçülebilir; bağlama tek seferlik
    // (dataset.splitBound) olduğu için her çizimde çağrılması güvenli.
    initAnalysisSplitter();
    initAnalysisHeightResizers();
    const a=compute();state.analysis=a;updatePortfolioAccessButtons(a);renderTrialImpact(a);renderKpis(a);renderInsights(a);renderSource();renderGroupTable(a);renderManufacturerVolumes(a);renderCustomCompare(a);
    // v6.64: Sipariş hacmi analizi mevcut LFL current/compare satırlarını doğrudan
    // tüketir. Burada ikinci bir fetch/API çağrısı yoktur; drilldown da LFL'nin
    // mevcut salt-okunur portföy penceresine geri bağlanır.
    window.BLLFLOrderAnalytics?.render({
      analysis:a,
      seasons:unique((state.meta.dimensions&&state.meta.dimensions.seasons)||state.rows.map(row=>row.season)).sort(seasonSort),
      source:state.source,
      openDrilldown:openLflPortfolioModal,
    });
    if(lflDetailModalState)renderLflDetailModal();saveFilters();
  }
  function exportAnalysis(){
    const a=state.analysis||compute();if(!window.XLSX){if(window.showToast)showToast('Excel kütüphanesi yüklenemedi.');return;}
    const list=dim=>[...state.filters[dim]].sort().map(v=>displayFilterValue(dim,v)).join(', ')||'Tümü';
    const filters=[['Güncel Sezon',a.currentSeason],[`Güncel ${dateFieldLabel(a.currentDateField)} Ayları`,list('currentMonth')],['Karşılaştırma Sezonu',a.compareSeason],[`Karşılaştırma ${dateFieldLabel(a.compareDateField)} Ayları`,list('compareMonth')],['Ülke',list('country')],['MAG',list('mag')],['MMYG',list('mmyg')],['Marka Müdürlükleri',list('brandDirectorate')],['Klasman',list('classification')],['Üretici',list('manufacturer')],['Buying Group',list('buyingGroup')],['Buyer',list('buyer')],['Kumaş Kategorisi',list('fabricCategory')],['Kumaşçı Ülkesi',list('fabricSupplierCountry')],['Kumaşçı',list('fabricSupplier')],['Kumaş Tipi',list('kumasTipi')],['İplik No',list('iplikNo')],['Gramaj',list('fabricWeight')],['Karışım',list('karisim')]];
    const kpiRows=[];for(const currency of ['TRY','USD']){if(a.current.byCurrency[currency])kpiRows.push([`${a.currentSeason} Ağırlıklı FOB`,a.current.byCurrency[currency].avg,currency]);if(a.previous.byCurrency[currency])kpiRows.push([`${a.compareSeason} Ağırlıklı FOB`,a.previous.byCurrency[currency].avg,currency]);}
    kpiRows.push(['FOB Değişimi %',a.priceChange,''],[`${a.currentSeason} Sipariş Sayısı`,a.current.orders,''],[`${a.currentSeason} Model Sayısı`,a.current.models,''],[`${a.currentSeason} Ürün Adedi`,a.current.qty,'']);
    if(a.current.hasDtrBreakdown)kpiRows.push([`${a.currentSeason} DTR Sipariş Sayısı`,a.current.dtrOrders.dtr,''],[`${a.currentSeason} NON-DTR Sipariş Sayısı`,a.current.dtrOrders.nonDtr,'']);
    kpiRows.push([`${a.compareSeason} Sipariş Sayısı`,a.previous.orders,''],[`${a.compareSeason} Model Sayısı`,a.previous.models,''],[`${a.compareSeason} Ürün Adedi`,a.previous.qty,'']);
    if(a.previous.hasDtrBreakdown)kpiRows.push([`${a.compareSeason} DTR Sipariş Sayısı`,a.previous.dtrOrders.dtr,''],[`${a.compareSeason} NON-DTR Sipariş Sayısı`,a.previous.dtrOrders.nonDtr,'']);
    if(trialActiveCount()){
      const impact=trialImpactFor(a);
      kpiRows.push(['Trial Model Sayısı',impact.trialModels,''],['Trial Ürün Adedi',impact.trialQty,''],['Gerçek LFL %',impact.baselineLfl,''],['Trial Sonrası LFL %',impact.simulatedLfl,''],['Net Trial Etkisi (puan)',impact.lflPointImpact,'']);
    }
    const fxRows=fxRateReport(a);
    const summaryRows=[['LFL Analiz Özeti','Değer','Para Birimi'],['Kaynak Dosya',state.source||'',''],...filters.map(r=>[...r,'']),[],['KPI','Değer','Para Birimi'],...kpiRows,...(fxRows.length?[[],['Ülke / Ay Bazlı USD Kuru','Değer','Döviz'],...fxRows.flatMap(x=>x.points.map(p=>[`${x.country} · ${monthLabel(p.requested)}`,p.rate,x.currency]))]:[])];
    const groupRows=[[breakdownLabel(a.groupBy),comparisonColumnHeader(a.currentPeriod,'Ağırlıklı FOB'),comparisonColumnHeader(a.comparePeriod,'Ağırlıklı FOB'),'FOB Değişimi %','Adet','Sipariş'],...a.groups.map(g=>[g.key,moneySummary(g.current),moneySummary(g.previous),g.priceChange,g.qty,g.orders])];
    const scenarioRows=comparisonScenarioResults(a),customRows=[['Karşılaştırma','Portföy Kapsamı','Güncel Dönem','Kıyas Dönemi','Güncel Adet','Kıyas Adet','Hacim Değişimi %','Güncel Sipariş','Kıyas Sipariş','Güncel Ağırlıklı FOB','Kıyas Ağırlıklı FOB','Ağırlıklı LFL Değişimi %'],...scenarioRows.map(row=>[row.name,scenarioScopeLabel(row),scenarioPeriodLabel(row.currentSeason,row.currentMonths,row.currentDateField),scenarioPeriodLabel(row.compareSeason,row.compareMonths,row.compareDateField),row.currentQty,row.previousQty,row.qtyChange,row.currentOrders,row.previousOrders,moneySummary(row.current),moneySummary(row.previous),row.priceChange])];
    const fabricExcelHead=state.showFabricDetails?['Kumaş Kategorisi','Kumaşçı Ülkesi','Kumaşçı','Kumaş Tipi','İplik No','Gramaj','Karışım']:[];
    const detailHead=['Tür','Order Code','Model','MAG','MMYG','Klasman','Sezon','OPD','Ex-F.','In-Store','Üretici','Ülke','Buying Group','Buyer',...fabricExcelHead,'FOB','Para Birimi','Quantity','Weighted Amount'];
    const excelDate=iso=>{const m=String(iso||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);return m?new Date(Number(m[1]),Number(m[2])-1,Number(m[3])):iso;};
    const fabricExcelValues=r=>state.showFabricDetails?[r.fabricCategory,r.fabricSupplierCountry,r.fabricSupplier,r.kumasTipi,r.iplikNo,r.fabricWeight,r.karisim]:[];
    const rowToExcel=r=>[r.isTrial?'TRIAL':'GERÇEK',String(r.orderCode||'').replace(/\.(?=\d{3}(?:\D|$))/g,''),r.modelName,r.mag,r.mmyg,r.classification,r.season,excelDate(r.opd),excelDate(r.exFactory),excelDate(r.inStore),r.manufacturer,r.country,r.buyingGroup,r.buyer,...fabricExcelValues(r),r.fob,currencyForRow(r),r.quantity,r.fob*r.quantity];
    const currentDetailRows=[detailHead,...a.currentRows.map(rowToExcel)],compareDetailRows=[detailHead,...a.compareRows.map(rowToExcel)];
    const wb=XLSX.utils.book_new(),ws1=XLSX.utils.aoa_to_sheet(summaryRows),ws2=XLSX.utils.aoa_to_sheet(groupRows),wsCustom=XLSX.utils.aoa_to_sheet(customRows),ws3=XLSX.utils.aoa_to_sheet(currentDetailRows),ws4=XLSX.utils.aoa_to_sheet(compareDetailRows);ws1['!cols']=[{wch:34},{wch:30},{wch:14}];ws2['!cols']=[{wch:30},...Array(5).fill({wch:18})];wsCustom['!cols']=[{wch:28},{wch:42},{wch:30},{wch:30},...Array(8).fill({wch:18})];const fabricDetailCols=state.showFabricDetails?[{wch:20},{wch:20},{wch:24},{wch:18},{wch:14},{wch:12},{wch:26}]:[];const detailCols=[{wch:10},{wch:15},{wch:28},{wch:13},{wch:13},{wch:18},{wch:10},{wch:13},{wch:13},{wch:13},{wch:25},{wch:16},{wch:18},{wch:18},...fabricDetailCols,{wch:12},{wch:12},{wch:12},{wch:16}];ws3['!cols']=detailCols;ws4['!cols']=detailCols;[ws3,ws4].forEach(ws=>{const range=ws['!ref']?XLSX.utils.decode_range(ws['!ref']):null;if(!range)return;for(let r=1;r<=range.e.r;r++){const idCell=ws[XLSX.utils.encode_cell({r,c:1})];if(idCell){idCell.t='s';idCell.v=String(idCell.v??'');idCell.z='@';}for(const c of [7,8,9]){const cell=ws[XLSX.utils.encode_cell({r,c})];if(cell&&cell.t==='d')cell.z='dd.mm.yy';}}});XLSX.utils.book_append_sheet(wb,ws1,'Özet');XLSX.utils.book_append_sheet(wb,ws2,'Grup Analizi');XLSX.utils.book_append_sheet(wb,wsCustom,'Bağımsız Kıyaslar');XLSX.utils.book_append_sheet(wb,ws3,'Seçili Portföy');XLSX.utils.book_append_sheet(wb,ws4,'Kıyas Portföyü');const d=new Date(),p=n=>String(n).padStart(2,'0');XLSX.writeFile(wb,`LFL_Analizi_${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}.xlsx`);
  }
  async function load(force=false,options={}){
    if(state.loading)return false;
    const preserved=options.preserveOnError?{serverRows:state.serverRows,rows:state.rows,meta:state.meta,source:state.source,loadedAt:state.loadedAt,trialRows:state.trial.rows}:null;
    state.loading=true;const btn=$('lflRefreshBtn'),old=btn?.innerHTML;if(btn){btn.disabled=true;btn.innerHTML='<span>'+(isEn()?'Refreshing…':'Yenileniyor…')+'</span>';}
    analysisDatasetRevision+=1;lflAnalysisCache.clear();lflScenarioCache.clear();
    try{
      if(window.BLFX&&BLFX.load)await BLFX.load();
      const res=await fetch(force?'/api/lfl/refresh':'/api/lfl',{method:force?'POST':'GET'}),data=await res.json();
      if(!res.ok)throw new Error(data.error||'LFL verisi okunamadı.');
      if(data&&data.sourceFilterRequired&&typeof window.showSourceFilterRequiredNotice==='function')window.showSourceFilterRequiredNotice(data.sourceFilterStatus,data.sourceFilterMessage);
      state.serverRows=(Array.isArray(data.rows)?data.rows:[]).filter(r=>['mag','mmyg','classification','season','manufacturer','country','buyingGroup','buyer'].every(k=>isUsableValue(r[k]))&&['inStore','opd','retailDate'].some(k=>isUsableValue(r[k])));
      rebuildDimensionLabelIndex(state.serverRows);applyTrialRows();state.meta=data.meta||{};state.source=data.source||null;state.loadedAt=data.loadedAt||null;fillControls();render();
      if(force&&!options.silent&&window.showToast)showToast(isEn()?('LFL refresh completed: '+state.rows.length.toLocaleString('en-GB')+' rows.'):('LFL yenileme tamamlandı: '+state.rows.length.toLocaleString('tr-TR')+' satır.'));
      return true;
    }catch(err){
      if(preserved){
        state.serverRows=preserved.serverRows;state.rows=preserved.rows;state.meta=preserved.meta;state.source=preserved.source;state.loadedAt=preserved.loadedAt;state.trial.rows=preserved.trialRows;rebuildDimensionLabelIndex(state.serverRows);render();
      }else{
        state.serverRows=[];rebuildDimensionLabelIndex([]);state.trial.rows=[];state.rows=[];state.meta={warnings:[err.message],rowCount:0};state.source=null;render();
      }
      if(!options.silent&&window.showToast)showToast((isEn()?'LFL refresh failed: ':'LFL yenileme başarısız: ')+err.message);
      return false;
    }finally{state.loading=false;if(btn){btn.disabled=false;btn.innerHTML=old;}}
  }
  function copyPreviousYearMonths(){
    const seasons=unique((state.meta.dimensions&&state.meta.dimensions.seasons)||state.rows.map(r=>r.season));
    const currentSeason=$('lflCurrentSeason').value,previous=previousSeason(currentSeason,seasons);if(previous)$('lflCompareSeason').value=previous;
    state.filters.compareMonth=new Set([...state.filters.currentMonth].map(m=>shiftMonth(m,-1)));
    closePanels();saveFilters();render();
    if(window.showToast)showToast(state.filters.currentMonth.size?`${dateFieldLabel(state.periods.current.dateField)} ayları ${dateFieldLabel(state.periods.compare.dateField)} kıyas tarafına 1 yıl geri kopyalandı.`:(isEn()?'No current period was selected; comparison remains all months.':'Güncel dönem seçimi olmadığı için kıyas tarafı tüm aylar olarak bırakıldı.'));
  }
  function resetFilters(){
    const seasons=unique((state.meta.dimensions&&state.meta.dimensions.seasons)||state.rows.map(r=>r.season)).sort(seasonSort),current=seasons[seasons.length-1]||'';$('lflCurrentSeason').value=current;$('lflCompareSeason').value=previousSeason(current,seasons);state.periods.current.dateField='inStore';state.periods.compare.dateField='inStore';syncDateFieldControls();state.breakdown=['mag','mmyg','classification'];FILTER_DIMS.forEach(dim=>state.filters[dim].clear());Object.values(state.tableViews).forEach(view=>view.filters={});Object.values(LFL_CP_TABLE_KEYS).forEach(key=>window.BLTableFramework?.clearFilters(key));closePanels();closeBreakdownPanel();closeCustomComparePanels();closeLflColumnPanel();render();
  }
  function bind(){
    if(state.initialized)return;state.initialized=true;
    const refreshButton=$('lflRefreshBtn');if(refreshButton)refreshButton.title=isEn()?'The source folder must contain the LFL KAYNAK Excel file.':'Kaynak klasörde LFL KAYNAK Excel dosyası bulunmalıdır.';
    $('lflRefreshBtn')?.addEventListener('click',()=>load(true));$('lflCurrentPortfolioBtn')?.addEventListener('click',()=>openLflDetailModal('current'));$('lflComparePortfolioBtn')?.addEventListener('click',()=>openLflDetailModal('compare'));$('lflExportBtn')?.addEventListener('click',exportAnalysis);$('lflResetBtn')?.addEventListener('click',resetFilters);$('lflReadyFiltersBtn')?.addEventListener('click',e=>{e.stopPropagation();toggleReadyPanel();});$('lflShiftYear')?.addEventListener('click',copyPreviousYearMonths);$('lflFabricDetailsBtn')?.addEventListener('click',toggleFabricDetails);
    $('lflBreakdownBtn')?.addEventListener('click',event=>{event.stopPropagation();toggleBreakdownPanel();});
    for(let i=0;i<3;i++){$(`lflCustomCompareDimension${i}`)?.addEventListener('change',event=>updateCustomCompareDimension(i,event.target.value));$(`lflCustomCompareValueBtn${i}`)?.addEventListener('click',event=>{event.stopPropagation();toggleCustomComparePanel(i);});}
    $('lflCustomCompareReference')?.addEventListener('change',event=>{state.customCompare.reference=event.target.value;saveCustomCompare();renderCustomCompare(state.analysis||compute());});
    $('lflScenarioRefreshBtn')?.addEventListener('click',refreshComparisonScenarios);
    $('lflScenarioAddBtn')?.addEventListener('click',()=>{if(state.customCompare.scenarios.length>=12)return;openComparisonScenarioEditor('',defaultComparisonScenario(state.customCompare.scenarios.length,state.analysis||compute()));});
    $('lflScenarioSaveBtn')?.addEventListener('click',saveComparisonScenarioEditor);
    document.querySelectorAll('[data-scenario-close]').forEach(btn=>btn.addEventListener('click',closeComparisonScenarioEditor));
    $('lflCompareSeason')?.addEventListener('change',()=>{state.filters.compareMonth.clear();closePanels();saveFilters();render();});
    $('lflCurrentSeason')?.addEventListener('change',()=>{const seasons=unique((state.meta.dimensions&&state.meta.dimensions.seasons)||state.rows.map(r=>r.season));$('lflCompareSeason').value=previousSeason($('lflCurrentSeason').value,seasons);state.filters.currentMonth.clear();state.filters.compareMonth.clear();closePanels();saveFilters();render();});
    $('lflCurrentDateField')?.addEventListener('change',event=>{state.periods.current.dateField=normalizeDateField(event.target.value);state.filters.currentMonth.clear();closePanels();saveFilters();render();});
    $('lflCompareDateField')?.addEventListener('change',event=>{state.periods.compare.dateField=normalizeDateField(event.target.value);state.filters.compareMonth.clear();closePanels();saveFilters();render();});
    document.querySelectorAll('[data-lfldim]').forEach(btn=>btn.addEventListener('click',e=>{e.stopPropagation();openFacet(btn.dataset.lfldim);}));
    document.addEventListener('click',e=>{if(!e.target.closest('.lflDimWrap'))closePanels();if(!e.target.closest('.lflReadyWrap'))closeReadyPanel();if(!e.target.closest('.lflBreakdownPicker'))closeBreakdownPanel();if(!e.target.closest('.lflCustomComparePicker'))closeCustomComparePanels();});
    document.addEventListener('keydown',e=>{if(e.key==='Escape'){closePanels();closeReadyPanel();closeBreakdownPanel();closeCustomComparePanels();closeLflPortfolioModal();closeLflDetailModal();closeComparisonScenarioEditor();}});
    // EN SONDA ve kendi hatasini yutarak: Trial baglanamazsa bile yukaridaki filtre
    // baglamalarinin hicbiri etkilenmemeli.
    try{ mountTrialButton(); }catch(err){ console.warn('LFL Trial düğmesi bağlanamadı:', err); }
  }
  window.initLFL=function(){bind();if(!state.rows.length&&!state.loading)load(false);else render();};
  // v2.20: "LFL İçin ASAS Yükle" sonrası kullanılır. load(false) sunucudaki GÜNCEL
  // (yüklenmiş) veriyi GET ile çeker; load(true) diskten yeniden okuyup yüklenen
  // dosyanın üzerine yazacağı için burada bilerek kullanılmaz.
  window.reloadLflFromCache=function(){return load(false);};
  window.renderLFLLanguage=function(){const btn=$('lflRefreshBtn');if(btn)btn.title=isEn()?'The source folder must contain the LFL KAYNAK Excel file.':'Kaynak klasörde LFL KAYNAK Excel dosyası bulunmalıdır.';render();if(!$('lflReadyFiltersPanel')?.hidden)renderReadyPanel();if(!$('lflScenarioEditor')?.hidden)renderComparisonScenarioEditor();if(lflDetailModalState)renderLflDetailModal();if(lflPortfolioModalState)renderLflPortfolioModal();};
  window.BLPriceSupplierLFLBridge={
    async get(scope='all'){
      if(!state.rows.length&&!state.loading)await load(false);
      const analysis=state.analysis||compute();
      const rows=scope==='filtered'?[...new Set([...(analysis.currentRows||[]),...(analysis.compareRows||[])])]:state.rows;
      const observations=[];for(let start=0;start<rows.length;start+=800){rows.slice(start,start+800).forEach((row,index)=>observations.push({source:'lfl',row,raw:row,rowId:start+index,orderKey:norm(row.orderCode),modelKey:`${norm(row.orderCode)}\u0000${norm(row.modelName)}`,model:norm(row.modelName),classification:norm(row.classification)||'—',manufacturer:norm(row.manufacturer)||'—',country:norm(row.country)||'—',buyer:norm(row.buyer)||'—',buyingGroup:norm(row.buyingGroup)||'—',collection:norm(row.collection),productGroup:norm(row.productGroup),category:norm(row.category),season:norm(row.season)||'—',status:norm(row.status),colour:norm(row.colour),date:norm(row.inStore||row.opd),month:norm(row.inStoreMonth),planStartMonth:norm(row.planStartMonth),price:Number(row.fob)>0?Number(row.fob):null,currency:currencyForRow(row),quantity:Number(row.quantity)||null,margin:row.margin!=null&&String(row.margin).trim()!==''&&Number.isFinite(Number(row.margin))?Number(row.margin):null}));if(start+800<rows.length)await new Promise(resolve=>setTimeout(resolve,0));}
      return {source:'lfl',scope,priceType:'fob',priceTypes:[{key:'fob',label:'FOB',currency:'ROW'}],observations,rawCount:rows.length,version:`lfl:${state.loadedAt||''}:${rows.length}`};
    },
    openDrilldown(observations,title){const rows=(observations||[]).map(item=>item.row||item.raw||item);openLflPortfolioModal({title:title||'LFL',currentRows:rows,previousRows:[],currentSeason:'',compareSeason:''});}
  };
  window.BLLFLCatalog={
    values(field){const rowKey=field==='category'?'classification':field==='inStoreMonth'?'inStoreMonth':field;return unique((state.serverRows||[]).map(row=>norm(row&&row[rowKey])).filter(isUsableValue)).sort((a,b)=>a.localeCompare(b,'tr-TR',{numeric:true,sensitivity:'base'}));},
    async ensureLoaded(){if(!state.serverRows.length&&!state.loading)await load(false);return this.values('category');}
  };
  window.__lflTest={countryCurrency,countryIdentity,dimensionIdentity,resolveDimensionLabel,normalizeDateField,rowPeriodMonth,comparisonColumnHeader,dateFieldLabel,filterRows,fxRateReport,selectedFxMonths,dtrTypeForRow,summary,dtrScopeText,manufacturerVolumes,customCompareValue,customCompareOptionsFromRows,customComparisonRows,multiComparisonRows,quantityTotal,uniqueOrderCount,groupValue,breakdownValue,breakdownDimLabel,breakdownDims:()=>[...BREAKDOWN_DIMS,...new Set(state.breakdown.filter(isAsasBreakdownDim))],filterDims:()=>[...FILTER_DIMS],fabricDetailColumns,detailColumns,showFabricDetails:()=>!!state.showFabricDetails,matchesSearch,pct,comparablePct,metricBetween,comparablePeriodRows,comparableMetricBetweenRows,normalizeComparisonScenario,freezeScenarioScope,scenarioComparisonResult,scenarioPeriodLabel,scenarioScopeLabel,scenarioDateField,refreshComparisonScenarios,trialScope,trialDraftFromModel,trialValidation,trialValidationDetails,trialScopeNotices,trialRowFrom,trialImpactFor,trialConfiguredCount,trialActiveCount,openTrialPanel};
})();
