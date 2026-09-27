/* Buyer Log — Backlog dynamic quantity/time charts + Excel chart export. */
(function attachBacklogChart(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BLBacklogChart = api;
  if (root && root.document) {
    const boot = () => api.init();
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', boot, { once:true });
    else Promise.resolve().then(boot);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createBacklogChart(root) {
  'use strict';

  const DATE_DIMENSION = root.BLDateDimension || (typeof require==='function' ? (()=>{try{return require('./date-dimension.js');}catch(_){return null;}})() : null);
  const STORAGE_KEY = 'lcw.backlog.chart.v1';
  const DEFAULT_STATE = Object.freeze({
    enabled:false,
    timeField:'',
    timeField2:'',
    granularity:'week',
    metricField:'__records',
    aggregation:'count',
    seriesField:'',
    chartType:'line',
    seriesLimit:'20',
    title:'',
    seriesFilter:[],
    showAverage:false,
    showSubtotal:false,
  });
  const COLORS = ['#2563eb','#7c3aed','#0891b2','#059669','#d97706','#dc2626','#db2777','#4f46e5','#0f766e','#9333ea','#475569','#ca8a04'];
  let state = Object.assign({}, DEFAULT_STATE);
  let initialized = false;
  let cache = { signature:'', headers:[], rows:[] };
  let chartView = { signature:'', start:0, end:0 };

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }
  function xml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&apos;');
  }
  function lang() {
    try { return root.BLBacklogChartContext && typeof root.BLBacklogChartContext.language === 'function'
      ? root.BLBacklogChartContext.language() : 'tr'; } catch (_) { return 'tr'; }
  }
  function tr(trText,enText) { return lang() === 'en' ? enText : trText; }
  function notify(message) {
    try {
      if (root.BLBacklogChartContext && typeof root.BLBacklogChartContext.toast === 'function') {
        root.BLBacklogChartContext.toast(message); return;
      }
    } catch (_) {}
    if (root.console) root.console.warn(message);
  }
  function store() {
    try { return root.BLStorage || root.localStorage || null; } catch (_) { return null; }
  }
  function sanitizeState(input) {
    const src = input && typeof input === 'object' ? input : {};
    const gran = ['day','week','month','year'].includes(src.granularity) ? src.granularity : DEFAULT_STATE.granularity;
    const agg = ['count','distinct','sum','avg'].includes(src.aggregation) ? src.aggregation : DEFAULT_STATE.aggregation;
    const chart = ['line','bar'].includes(src.chartType) ? src.chartType : DEFAULT_STATE.chartType;
    const limit = ['5','10','20','50','all'].includes(String(src.seriesLimit)) ? String(src.seriesLimit) : DEFAULT_STATE.seriesLimit;
    const seriesFilter = Array.isArray(src.seriesFilter)
      ? [...new Set(src.seriesFilter.map(v=>String(v == null ? '' : v).trim()).filter(Boolean))].slice(0,200)
      : [];
    return {
      enabled:!!src.enabled,
      timeField:String(src.timeField || ''),
      timeField2:String(src.timeField2 || ''),
      granularity:gran,
      metricField:String(src.metricField || '__records'),
      aggregation:agg,
      seriesField:String(src.seriesField || ''),
      chartType:chart,
      seriesLimit:limit,
      title:String(src.title || '').slice(0,160),
      seriesFilter,
      showAverage:!!src.showAverage,
      showSubtotal:!!src.showSubtotal,
    };
  }
  function loadState() {
    try {
      const s=store(), raw=s && s.getItem(STORAGE_KEY);
      state = sanitizeState(raw ? JSON.parse(raw) : DEFAULT_STATE);
    } catch (_) { state = Object.assign({}, DEFAULT_STATE); }
    return Object.assign({}, state);
  }
  function saveState(next) {
    state = sanitizeState(next);
    try { const s=store(); if (s) s.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
    return Object.assign({}, state);
  }
  function getState() { return Object.assign({}, state); }
  function getViewRange() { return {start:Number(chartView.start)||0,end:Number(chartView.end)||0,signature:String(chartView.signature||'')}; }

  function normalizeHeader(value) {
    const helper = root.BLExcelDates && root.BLExcelDates.normalizedHeader;
    if (typeof helper === 'function') return helper(value);
    const map={'İ':'I','Ş':'S','Ç':'C','Ö':'O','Ü':'U','Ğ':'G'};
    return String(value == null ? '' : value).toUpperCase()
      .replace(/[İŞÇÖÜĞ]/g,ch=>map[ch]||ch)
      .replace(/[^A-Z0-9]+/g,' ').replace(/\s+/g,' ').trim();
  }
  function parseDate(value) {
    try {
      if (DATE_DIMENSION && typeof DATE_DIMENSION.parseDate==='function') {
        const parsed=DATE_DIMENSION.parseDate(value);
        if (parsed instanceof Date && !isNaN(parsed)) return parsed;
      }
      const helper=root.BLExcelDates && root.BLExcelDates.parseDate;
      if (typeof helper === 'function') {
        const parsed=helper(value);
        if (parsed instanceof Date && !isNaN(parsed)) return parsed;
      }
    } catch (_) {}
    if (value instanceof Date && !isNaN(value)) return new Date(value.getFullYear(),value.getMonth(),value.getDate());
    if (value == null || value === '') return null;
    const text=String(value).trim();
    let m=text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (m) { const d=new Date(+m[1],+m[2]-1,+m[3]); return isNaN(d)?null:d; }
    m=text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
    if (m) { const d=new Date(+m[3],+m[2]-1,+m[1]); return isNaN(d)?null:d; }
    const d=new Date(text); return isNaN(d)?null:new Date(d.getFullYear(),d.getMonth(),d.getDate());
  }
  function parseNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (value == null || value === '') return null;
    let s=String(value).trim().replace(/\s/g,'');
    if (!/[0-9]/.test(s)) return null;
    const comma=s.lastIndexOf(','), dot=s.lastIndexOf('.');
    if (comma>=0 && dot>=0) {
      if (comma>dot) s=s.replace(/\./g,'').replace(',','.');
      else s=s.replace(/,/g,'');
    } else if (comma>=0) {
      if (/^[+-]?\d{1,3}(?:,\d{3})+$/.test(s)) s=s.replace(/,/g,'');
      else s=s.replace(',','.');
    } else if (dot>=0 && /^[+-]?\d{1,3}(?:\.\d{3})+$/.test(s)) {
      s=s.replace(/\./g,'');
    }
    s=s.replace(/[^0-9+.\-]/g,'');
    const n=Number(s);
    return Number.isFinite(n)?n:null;
  }
  function isoDate(d) {
    return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
  }
  function bucketFor(date,granularity) {
    const d=parseDate(date);
    if(!d)return {key:'',label:''};
    if(DATE_DIMENSION&&typeof DATE_DIMENSION.bucketKey==='function'&&typeof DATE_DIMENSION.bucketLabel==='function'){
      const key=DATE_DIMENSION.bucketKey(d,granularity);
      return {key,label:DATE_DIMENSION.bucketLabel(key,granularity,lang())};
    }
    const key=granularity==='year'?String(d.getFullYear()):granularity==='month'
      ? d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')
      : granularity==='week'?isoDate((()=>{const m=new Date(d);m.setDate(m.getDate()-((m.getDay()+6)%7));return m;})())
      : isoDate(d);
    return {key,label:key};
  }
  function normalizeHeaders(headers, rows) {
    const out=[], seen=new Set();
    function add(v) {
      const h=String(v == null ? '' : v).trim();
      if (!h || seen.has(h) || h[0]==='_') return;
      seen.add(h); out.push(h);
    }
    (Array.isArray(headers)?headers:[]).forEach(add);
    (Array.isArray(rows)?rows.slice(0,80):[]).forEach(row=>{
      if (row && typeof row==='object') Object.keys(row).forEach(add);
    });
    return out;
  }
  function detectDateHeaders(headers,rows) {
    const all=normalizeHeaders(headers,rows);
    return all.filter(header=>{
      try { if (root.BLExcelDates && typeof root.BLExcelDates.isDateHeader==='function' && root.BLExcelDates.isDateHeader(header)) return true; } catch (_) {}
      const vals=[];
      for (const row of (rows||[])) {
        const v=row && row[header];
        if (v!=null && String(v).trim()!=='') vals.push(v);
        if (vals.length>=40) break;
      }
      if (vals.length<3) return false;
      const good=vals.reduce((n,v)=>n+(parseDate(v)?1:0),0);
      return good/vals.length>=0.75;
    });
  }
  function fieldIndex(headers, patterns) {
    for (const re of patterns) {
      const found=headers.find(h=>re.test(normalizeHeader(h)));
      if (found) return found;
    }
    return '';
  }
  function inferState(headers,rows,base) {
    const all=normalizeHeaders(headers,rows), next=sanitizeState(base||state);
    const dates=detectDateHeaders(all,rows);
    if (!all.includes(next.timeField)) next.timeField=fieldIndex(dates,[/ANTREPO GIRIS/,/IN STORE/,/MODEL BUTCE/,/RETAIL/,/SEVK/,/TARIH/,/DATE/]) || dates[0] || '';
    if (next.timeField2 && !all.includes(next.timeField2)) next.timeField2='';
    if (next.metricField!=='__records' && !all.includes(next.metricField)) next.metricField='__records';
    if (next.metricField==='__records') {
      const qty=fieldIndex(all,[/^ADET$/,/^QUANTITY$/,/^QTY$/,/KALAN MIKTAR/,/ORDER QTY/]);
      if (qty) { next.metricField=qty; next.aggregation='sum'; }
    }
    if (next.seriesField && !all.includes(next.seriesField)) next.seriesField='';
    if (!next.seriesField) next.seriesField=fieldIndex(all,[/^BUYER$/,/BUYER GRUP|BUYING GROUP/,/^MAG$|MERCH ALT GRUP/,/KLASMAN|CATEGORY/]);
    return next;
  }
  function newAccumulator() { return {rows:0,nonblank:0,sum:0,numeric:0,distinct:new Set()}; }
  function addAccumulator(acc,value,metricField) {
    acc.rows++;
    if (metricField==='__records') { acc.nonblank++; acc.sum++; acc.numeric++; acc.distinct.add('__row__'+acc.rows); return; }
    if (value!=null && String(value).trim()!=='') {
      acc.nonblank++; acc.distinct.add(String(value));
      const n=parseNumber(value); if (n!=null) { acc.sum+=n; acc.numeric++; }
    }
  }
  function accumulatorValue(acc,aggregation,metricField) {
    if (!acc) return 0;
    if (aggregation==='distinct') return acc.distinct.size;
    if (aggregation==='sum') return acc.sum;
    if (aggregation==='avg') return acc.numeric ? acc.sum/acc.numeric : 0;
    return metricField==='__records' ? acc.rows : acc.nonblank;
  }
  function generatedTitle(st) {
    const period={day:tr('Gün','Day'),week:tr('Hafta','Week'),month:tr('Ay','Month'),year:tr('Yıl','Year')}[st.granularity];
    const measure=st.metricField==='__records'?tr('Kayıt Sayısı','Record Count'):st.metricField;
    return measure+' / '+period+(st.seriesField?' · '+st.seriesField:'');
  }
  function buildModel(rows,headers,inputState) {
    const all=normalizeHeaders(headers,rows), st=sanitizeState(inputState||state);
    if (!st.timeField || !all.includes(st.timeField)) return {categories:[],series:[],availableSeriesNames:[],state:st,reason:'time-field'};
    const fieldSpecs=[{field:st.timeField,index:1}];
    if(st.timeField2&&st.timeField2!==st.timeField&&all.includes(st.timeField2))fieldSpecs.push({field:st.timeField2,index:2});
    const buckets=new Map(),labels=new Map(),mapsByField=fieldSpecs.map(()=>new Map());
    let used=0,invalidDates=0;
    for(const row of (Array.isArray(rows)?rows:[])){
      const baseName=st.seriesField
        ? String(row[st.seriesField]==null||String(row[st.seriesField]).trim()===''?tr('(boş)','(blank)'):row[st.seriesField])
        : generatedTitle(st);
      fieldSpecs.forEach((spec,fi)=>{
        const d=parseDate(row&&row[spec.field]);
        if(!d){if(fi===0)invalidDates++;return;}
        if(fi===0)used++;
        const bucket=bucketFor(d,st.granularity);
        buckets.set(bucket.key,true);labels.set(bucket.key,bucket.label);
        const seriesMaps=mapsByField[fi];
        if(!seriesMaps.has(baseName))seriesMaps.set(baseName,new Map());
        const map=seriesMaps.get(baseName);
        if(!map.has(bucket.key))map.set(bucket.key,newAccumulator());
        addAccumulator(map.get(bucket.key),st.metricField==='__records'?1:row[st.metricField],st.metricField);
      });
    }
    const categoryKeys=[...buckets.keys()].sort();
    let names=[...new Set(mapsByField.flatMap(map=>[...map.keys()]))];
    const totals=new Map();
    names.forEach(name=>{
      let total=0;
      mapsByField.forEach(map=>{
        const seriesMap=map.get(name);
        if(seriesMap)total+=categoryKeys.reduce((sum,key)=>sum+accumulatorValue(seriesMap.get(key),st.aggregation,st.metricField),0);
      });
      totals.set(name,total);
    });
    names.sort((a,b)=>(totals.get(b)||0)-(totals.get(a)||0)||String(a).localeCompare(String(b),'tr'));
    const availableSeriesNames=names.slice();
    if(st.seriesFilter.length){
      const selected=new Set(st.seriesFilter),matched=names.filter(name=>selected.has(name));
      if(matched.length)names=matched;
    }
    const filteredOutSeriesCount=Math.max(0,availableSeriesNames.length-names.length);
    const limit=st.seriesLimit==='all'?Infinity:Number(st.seriesLimit)||20;
    const omitted=Math.max(0,names.length-limit);
    if(Number.isFinite(limit))names=names.slice(0,limit);
    const hasOverlay=fieldSpecs.length>1;
    const series=[];
    names.forEach(baseName=>{
      const colorIndex=Math.max(0,availableSeriesNames.indexOf(baseName));
      fieldSpecs.forEach((spec,fi)=>{
        const map=mapsByField[fi].get(baseName);
        if(!map)return;
        series.push({
          name:hasOverlay?baseName+' · '+spec.field:baseName,
          baseName,
          timeField:spec.field,
          timeFieldIndex:spec.index,
          dash:spec.index===2,
          color:COLORS[colorIndex%COLORS.length],
          values:categoryKeys.map(key=>accumulatorValue(map.get(key),st.aggregation,st.metricField)),
        });
      });
    });
    return {
      title:st.title.trim()||generatedTitle(st),
      state:st,
      categories:categoryKeys.map(key=>({key,label:labels.get(key)||key})),
      series,availableSeriesNames,fieldSpecs,usedRows:used,invalidDates,
      omittedSeriesCount:omitted,filteredOutSeriesCount,sourceSeriesCount:availableSeriesNames.length,
    };
  }
  function formatWholeValue(value) {
    const n=Number(value)||0;
    try{return Math.round(n).toLocaleString('tr-TR',{maximumFractionDigits:0});}catch(_){return String(Math.round(n));}
  }
  function formatAxisValue(value) {
    const n=Math.round(Number(value)||0),abs=Math.abs(n);
    if(abs>=1000){
      const k=Math.round(n/1000);
      try{return k.toLocaleString('tr-TR',{maximumFractionDigits:0})+'k';}catch(_){return String(k)+'k';}
    }
    return String(n);
  }
  function formatValue(value) { return formatWholeValue(value); }
  function niceStep(maxValue,targetTicks) {
    const max=Math.max(0,Number(maxValue)||0),target=Math.max(2,Number(targetTicks)||5);
    if(!(max>0))return 1;
    const raw=max/target,pow=Math.pow(10,Math.floor(Math.log10(raw))),norm=raw/pow;
    const nice=[1,2,2.5,3,5,10].find(v=>v>=norm)||10;
    return nice*pow;
  }
  function niceTickScale(maxValue,targetTicks) {
    const step=niceStep(maxValue,targetTicks),max=Math.max(step,Math.ceil((Number(maxValue)||0)/step)*step);
    const ticks=[];for(let v=0;v<=max+step*.001;v+=step)ticks.push(Math.round(v*1e8)/1e8);
    return {step,max,ticks};
  }
  function configSummary(st) {
    const agg={count:tr('Adet','Count'),distinct:tr('Benzersiz adet','Distinct count'),sum:tr('Toplam','Sum'),avg:tr('Ortalama','Average')}[st.aggregation];
    const gran={day:tr('Gün','Day'),week:tr('Hafta','Week'),month:tr('Ay','Month'),year:tr('Yıl','Year')}[st.granularity];
    const metric=st.metricField==='__records'?tr('Kayıtlar','Records'):st.metricField;
    return st.timeField+(st.timeField2?' + '+st.timeField2:'')+' · '+gran+' · '+agg+' '+metric+(st.seriesField?' · '+st.seriesField:'');
  }
  function todayKeyFor(granularity,date) {
    const d=parseDate(date||new Date());return d?bucketFor(d,granularity).key:'';
  }
  function todayPosition(categories,key) {
    const list=Array.isArray(categories)?categories:[];
    if(!key||!list.length)return null;
    const keys=list.map(item=>String(item&&item.key||''));
    if(key<keys[0]||key>keys[keys.length-1])return null;
    const exact=keys.indexOf(key);if(exact>=0)return exact+.5;
    const insert=keys.findIndex(item=>item>key);return insert<0?keys.length:insert;
  }
  const SHORT_MONTHS=['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  function axisTickLabel(category,granularity) {
    const cat=category||{},key=String(cat.key||''),label=String(cat.label||key);
    if(granularity==='year')return key||label;
    if(granularity==='month'){
      const m=key.match(/^(\d{4})-(\d{2})$/);
      if(m)return SHORT_MONTHS[Math.max(0,Math.min(11,+m[2]-1))]+' '+String(m[1]).slice(-2);
    }
    if(granularity==='week'){
      const wk=key.match(/-W(\d{1,2})$/i)||label.match(/(?:Week\s*)?(\d+)(?:\.\s*Hafta)?/i);
      if(wk)return String(Number(wk[1]));
    }
    if(granularity==='day'){
      const d=parseDate(key);if(d)return String(d.getDate()).padStart(2,'0')+' '+SHORT_MONTHS[d.getMonth()];
    }
    return label.length>14?label.slice(0,13)+'…':label;
  }
  function subtotalValues(model) {
    const count=(model&&model.categories||[]).length;
    return Array.from({length:count},(_,i)=>(model.series||[]).reduce((sum,s)=>sum+(Number(s.values&&s.values[i])||0),0));
  }
  function averageValue(model) {
    const values=(model&&model.series||[]).flatMap(series=>(series.values||[]).filter(Number.isFinite));
    return values.length?values.reduce((sum,value)=>sum+value,0)/values.length:0;
  }
  function chartMetrics(model) {
    const width=1080,height=430,left=24,right=88,top=28,bottom=58,pw=width-left-right,ph=height-top-bottom;
    const values=(model&&model.series||[]).flatMap(s=>s.values||[]).filter(Number.isFinite);
    if(model&&model.state&&model.state.showSubtotal)values.push(...subtotalValues(model));
    if(model&&model.state&&model.state.showAverage)values.push(averageValue(model));
    const rawMax=Math.max(0,...values),scale=niceTickScale(rawMax,5);
    return {width,height,left,right,top,bottom,pw,ph,max:scale.max,tickStep:scale.step,ticks:scale.ticks};
  }
  function svgChart(model,options) {
    const m=chartMetrics(model),width=m.width,height=m.height,left=m.left,right=m.right,top=m.top,pw=m.pw,ph=m.ph,max=m.max;
    const plotRight=width-right,fade=Math.min(24,Math.max(12,pw*.025));
    let out='<svg class="backlogChartSvg" viewBox="0 0 '+width+' '+height+'" role="img" aria-label="'+esc(model.title)+'">';
    out+='<defs>'
      +'<clipPath id="backlogChartPlotClip"><rect x="'+left+'" y="0" width="'+pw+'" height="'+height+'"/></clipPath>'
      +'<linearGradient id="backlogChartEdgeFade" gradientUnits="userSpaceOnUse" x1="'+left+'" x2="'+plotRight+'" y1="0" y2="0">'
      +'<stop offset="0" stop-color="black"/><stop offset="'+(fade/pw).toFixed(4)+'" stop-color="white"/>'
      +'<stop offset="'+(1-fade/pw).toFixed(4)+'" stop-color="white"/><stop offset="1" stop-color="black"/></linearGradient>'
      +'<mask id="backlogChartPlotMask" maskUnits="userSpaceOnUse" x="'+left+'" y="0" width="'+pw+'" height="'+height+'"><rect x="'+left+'" y="0" width="'+pw+'" height="'+height+'" fill="url(#backlogChartEdgeFade)"/></mask>'
      +'</defs>';
    out+='<rect x="0" y="0" width="'+width+'" height="'+height+'" rx="8" class="backlogChartBg"/>';
    out+='<rect x="'+plotRight+'" y="'+top+'" width="'+right+'" height="'+ph+'" class="backlogChartPriceAxis"/>';
    m.ticks.slice().reverse().forEach(val=>{
      const y=top+ph*(1-val/max);
      out+='<line x1="'+left+'" x2="'+plotRight+'" y1="'+y+'" y2="'+y+'" class="backlogChartGrid"/>';
      out+='<text x="'+(plotRight+10)+'" y="'+(y+4)+'" text-anchor="start" class="backlogChartAxisText">'+esc(formatAxisValue(val))+'</text>';
    });
    const n=Math.max(1,model.categories.length),step=pw/n,minLabelPx=model.state.granularity==='week'?30:model.state.granularity==='month'?58:50;
    const maxLabels=Math.max(1,Math.floor(pw/minLabelPx)),labelStep=Math.max(1,Math.ceil(n/maxLabels));
    out+='<g class="backlogChartPlotWindow" clip-path="url(#backlogChartPlotClip)" mask="url(#backlogChartPlotMask)"><g class="backlogChartPanLayer" data-backlog-chart-pan-layer>';
    model.categories.forEach((cat,i)=>{
      const x=left+step*(i+.5);
      if(i%labelStep===0||i===model.categories.length-1)out+='<text x="'+x+'" y="'+(top+ph+27)+'" text-anchor="middle" class="backlogChartAxisText">'+esc(axisTickLabel(cat,model.state.granularity))+'</text>';
    });
    const today=options&&options.today?options.today:new Date(),todayKey=todayKeyFor(model.state.granularity,today),todayPos=todayPosition(model.categories,todayKey);
    if(todayPos!=null){
      const x=left+step*todayPos;
      out+='<line x1="'+x.toFixed(2)+'" x2="'+x.toFixed(2)+'" y1="'+top+'" y2="'+(top+ph)+'" class="backlogChartTodayLine"/>';
      out+='<rect x="'+(x-25).toFixed(2)+'" y="'+(top-21)+'" width="50" height="16" rx="4" class="backlogChartTodayBadge"/>';
      out+='<text x="'+x.toFixed(2)+'" y="'+(top-10)+'" text-anchor="middle" class="backlogChartTodayText">'+esc(tr('Bugün','Today'))+'</text>';
    }
    if(model.state.chartType==='bar'){
      const count=Math.max(1,model.series.length),group=step*.76,bw=Math.max(.7,group/count);
      model.series.forEach((serie,si)=>{
        serie.values.forEach((v,i)=>{
          const h=ph*(Number(v)||0)/max,x=left+step*(i+.5)-group/2+si*bw,y=top+ph-h;
          out+='<rect x="'+x.toFixed(2)+'" y="'+y.toFixed(2)+'" width="'+Math.max(.6,bw-1).toFixed(2)+'" height="'+Math.max(0,h).toFixed(2)+'" fill="'+serie.color+'" opacity="'+(serie.dash?'.48':'.86')+'"><title>'+esc(serie.name+' · '+model.categories[i].label+': '+formatWholeValue(v))+'</title></rect>';
        });
      });
    }else{
      model.series.forEach(serie=>{
        const pts=serie.values.map((v,i)=>{
          const x=left+step*(i+.5),y=top+ph-ph*(Number(v)||0)/max;return x.toFixed(2)+','+y.toFixed(2);
        }).join(' ');
        out+='<polyline points="'+pts+'" fill="none" stroke="'+serie.color+'" stroke-width="2"'+(serie.dash?' stroke-dasharray="7 5" opacity=".78"':'')+' vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>';
        serie.values.forEach((v,i)=>{
          const x=left+step*(i+.5),y=top+ph-ph*(Number(v)||0)/max;
          out+='<circle cx="'+x.toFixed(2)+'" cy="'+y.toFixed(2)+'" r="2.6" fill="'+serie.color+'" opacity="'+(serie.dash?'.68':'1')+'" class="backlogChartPoint"><title>'+esc(serie.name+' · '+model.categories[i].label+': '+formatWholeValue(v))+'</title></circle>';
        });
      });
    }
    if(model.state.showSubtotal){
      const totals=subtotalValues(model),pts=totals.map((v,i)=>{
        const x=left+step*(i+.5),y=top+ph-ph*(Number(v)||0)/max;return x.toFixed(2)+','+y.toFixed(2);
      }).join(' ');
      out+='<polyline points="'+pts+'" fill="none" class="backlogChartSubtotalLine" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>';
    }
    out+='</g></g>';
    if(model.state.showAverage){
      // model burada görünür aralığın slice edilmiş modelidir; dolayısıyla
      // ortalama yalnız ekranda görünen bucket + görünür seri alt toplamlarından gelir.
      const avg=averageValue(model),y=top+ph-ph*(avg/max);
      out+='<g clip-path="url(#backlogChartPlotClip)" mask="url(#backlogChartPlotMask)"><line x1="'+left+'" x2="'+plotRight+'" y1="'+y.toFixed(2)+'" y2="'+y.toFixed(2)+'" class="backlogChartAverageLine"/></g>';
      out+='<text x="'+(plotRight-6)+'" y="'+(y-5).toFixed(2)+'" text-anchor="end" class="backlogChartAverageText">'+esc(tr('Ort. ','Avg. ')+formatWholeValue(avg))+'</text>';
    }
    out+='</svg>';return out;
  }
  function chartViewSignature(model) {
    return [model.state.timeField,model.state.timeField2,model.state.granularity,(model.categories||[]).map(cat=>cat.key).join(',')].join('|');
  }
  function clampChartRange(range,total) {
    const count=Math.max(0,Number(total)||0);if(!count)return {start:0,end:0};
    let start=Math.max(0,Math.min(count-1,Math.floor(Number(range&&range.start)||0)));
    let end=Math.max(start+1,Math.min(count,Math.floor(Number(range&&range.end)||count)));
    if(end>count){const shift=end-count;start=Math.max(0,start-shift);end=count;}
    return {start,end};
  }
  function defaultVisibleSpan(granularity,total) {
    const wanted={day:30,week:16,month:12,year:8}[granularity]||16;
    return Math.max(1,Math.min(Math.max(1,Number(total)||1),wanted));
  }
  function centeredRange(model,span,date) {
    const total=(model.categories||[]).length,count=Math.max(1,Math.min(total,Number(span)||total));
    if(!total)return {start:0,end:0};
    const key=todayKeyFor(model.state.granularity,date||new Date()),pos=todayPosition(model.categories,key);
    if(pos==null)return {start:Math.max(0,total-count),end:total};
    let start=Math.round(pos-count*.38);start=Math.max(0,Math.min(total-count,start));
    return {start,end:start+count};
  }
  function defaultChartRange(model,date) { return centeredRange(model,defaultVisibleSpan(model.state.granularity,(model.categories||[]).length),date); }
  function zoomChartRange(range,total,delta,focusRatio) {
    const count=Math.max(0,Number(total)||0),current=clampChartRange(range,count);if(count<=1)return current;
    const span=current.end-current.start,minSpan=Math.min(count,4),zoomIn=Number(delta)<0;
    let nextSpan=Math.round(span*(zoomIn?.82:1.22));nextSpan=Math.max(minSpan,Math.min(count,nextSpan));
    if(nextSpan===span&&zoomIn&&span>minSpan)nextSpan=span-1;if(nextSpan===span&&!zoomIn&&span<count)nextSpan=span+1;
    const ratio=Math.max(0,Math.min(1,Number(focusRatio)||.5)),focus=current.start+ratio*Math.max(0,span-1);
    let start=Math.round(focus-ratio*Math.max(0,nextSpan-1));start=Math.max(0,Math.min(count-nextSpan,start));
    return {start,end:start+nextSpan};
  }
  function shiftChartRange(range,total,buckets) {
    const count=Math.max(0,Number(total)||0),current=clampChartRange(range,count),span=current.end-current.start;
    if(span>=count)return current;
    const start=Math.max(0,Math.min(count-span,current.start+(Number(buckets)||0)));return {start,end:start+span};
  }
  function panChartRange(range,total,direction) { return shiftChartRange(range,total,Number(direction)<0?-1:1); }
  function sliceModel(model,range) {
    const safe=clampChartRange(range,(model.categories||[]).length);
    return Object.assign({},model,{
      categories:(model.categories||[]).slice(safe.start,safe.end),
      series:(model.series||[]).map(item=>Object.assign({},item,{values:(item.values||[]).slice(safe.start,safe.end)})),
      viewRange:safe,
    });
  }
  function presetSpan(granularity,preset,total) {
    const table={day:{'4w':28,'3m':90,'6m':180,'1y':365},week:{'4w':4,'3m':13,'6m':26,'1y':52},month:{'4w':1,'3m':3,'6m':6,'1y':12},year:{'4w':1,'3m':1,'6m':1,'1y':1}};
    const wanted=table[granularity]&&table[granularity][preset];
    return Math.max(1,Math.min(Math.max(1,Number(total)||1),wanted||defaultVisibleSpan(granularity,total)));
  }
  function rangeForPreset(model,preset,date) {
    const total=(model.categories||[]).length;if(!total)return {start:0,end:0};
    if(preset==='all')return {start:0,end:total};if(preset==='fit')return defaultChartRange(model,date);
    if(preset==='ytd'){
      const d=parseDate(date||new Date()),year=d?String(d.getFullYear()):'',keys=model.categories.map(c=>String(c.key||''));
      let start=keys.findIndex(key=>key.slice(0,4)===year);if(start<0)return defaultChartRange(model,date);
      let end=keys.findIndex(key=>key>todayKeyFor(model.state.granularity,date||new Date()));if(end<0)end=total;
      return clampChartRange({start,end:Math.max(start+1,end)},total);
    }
    return centeredRange(model,presetSpan(model.state.granularity,preset,total),date);
  }
  function rangesEqual(a,b) { return !!a&&!!b&&a.start===b.start&&a.end===b.end; }
  function ensureChartView(model) {
    const total=(model.categories||[]).length,signature=chartViewSignature(model);
    if(chartView.signature!==signature){const initial=defaultChartRange(model);chartView={signature,start:initial.start,end:initial.end};}
    else{const safe=clampChartRange(chartView,total);chartView={signature,start:safe.start,end:safe.end};}
    return {start:chartView.start,end:chartView.end};
  }
  function moveViewToToday(model) {
    const current=ensureChartView(model),span=current.end-current.start,next=centeredRange(model,span,new Date());
    if(rangesEqual(current,next))return todayPosition(model.categories,todayKeyFor(model.state.granularity,new Date()))!=null;
    chartView={signature:chartViewSignature(model),start:next.start,end:next.end};return true;
  }
  function filterSelection(model) {
    const available=Array.isArray(model.availableSeriesNames)?model.availableSeriesNames:[];
    if(!available.length)return [];if(!model.state.seriesFilter.length)return available.slice();
    const selected=new Set(model.state.seriesFilter),matched=available.filter(name=>selected.has(name));return matched.length?matched:available.slice();
  }
  function legendHtml(model) {
    const available=model.availableSeriesNames||[],selected=new Set(filterSelection(model));
    return '<div class="backlogChartLegend" aria-label="'+esc(tr('Grafik serileri','Chart series'))+'">'+available.map((name,index)=>{
      const active=selected.has(name),hasSecond=!!model.state.timeField2;
      return '<button type="button" class="backlogChartLegendItem'+(active?'':' is-muted')+'" data-backlog-chart-legend-name="'+esc(name)+'" style="--series-color:'+COLORS[index%COLORS.length]+'" title="'+esc(tr('Tıkla: gizle/göster · Çift tık: yalnız bu seri','Click: hide/show · Double-click: isolate series'))+'"><span></span><b>'+esc(name)+'</b>'+(hasSecond?'<i class="backlogChartOverlayMark">A/B</i>':'')+'</button>';
    }).join('')+'</div>';
  }
  function safeChartFileName(title,ext) {
    const base=String(title||'Backlog Chart').replace(/[\\/:*?"<>|]+/g,' ').replace(/\s+/g,' ').trim().slice(0,80)||'Backlog Chart';
    return base+'.'+ext;
  }
  function downloadBlob(blob,name) {
    if(!root.document||!root.URL)return;
    const url=root.URL.createObjectURL(blob),a=root.document.createElement('a');a.href=url;a.download=name;a.style.display='none';
    root.document.body.appendChild(a);a.click();a.remove();setTimeout(()=>root.URL.revokeObjectURL(url),1500);
  }
  function serializeSvgForExport(svg) {
    if(!svg)return '';
    const clone=svg.cloneNode(true),original=[svg,...svg.querySelectorAll('*')],copies=[clone,...clone.querySelectorAll('*')];
    const props=['fill','stroke','stroke-width','stroke-dasharray','opacity','font-family','font-size','font-weight','font-style'];
    original.forEach((node,i)=>{
      const copy=copies[i];if(!copy||!root.getComputedStyle)return;
      const cs=root.getComputedStyle(node),style=props.map(p=>p+':'+cs.getPropertyValue(p)).filter(x=>!x.endsWith(':')).join(';');
      if(style)copy.setAttribute('style',style);
    });
    clone.setAttribute('xmlns','http://www.w3.org/2000/svg');
    const vb=clone.viewBox&&clone.viewBox.baseVal;if(vb&&vb.width){clone.setAttribute('width',vb.width);clone.setAttribute('height',vb.height);}
    return new XMLSerializer().serializeToString(clone);
  }
  async function exportChartGraphic(host,type,model) {
    const svg=host&&host.querySelector('.backlogChartSvg');if(!svg)return;
    const xmlText=serializeSvgForExport(svg);if(!xmlText)return;
    if(type==='svg'){downloadBlob(new Blob([xmlText],{type:'image/svg+xml;charset=utf-8'}),safeChartFileName(model.title,'svg'));return;}
    const blob=new Blob([xmlText],{type:'image/svg+xml;charset=utf-8'}),url=root.URL.createObjectURL(blob);
    try{
      const img=new root.Image();
      await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=reject;img.src=url;});
      const vb=svg.viewBox.baseVal,scale=2,canvas=root.document.createElement('canvas');canvas.width=Math.round(vb.width*scale);canvas.height=Math.round(vb.height*scale);
      const ctx=canvas.getContext('2d');ctx.scale(scale,scale);ctx.drawImage(img,0,0,vb.width,vb.height);
      const png=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      if(png)downloadBlob(png,safeChartFileName(model.title,'png'));
    }finally{root.URL.revokeObjectURL(url);}
  }
  function mountInteractiveChart(host,model,detail) {
    const target=host&&host.querySelector('[data-backlog-chart-body]');if(!target)return;
    const total=model.categories.length,range=ensureChartView(model),visible=sliceModel(model,range),span=range.end-range.start;
    const selected=filterSelection(model),available=model.availableSeriesNames||[],first=visible.categories[0],last=visible.categories[visible.categories.length-1];
    const rangeText=(first&&last?first.label+(first.key===last.key?'':' – '+last.label):'')+' · '+span+'/'+total;
    const fullTodayPos=todayPosition(model.categories,todayKeyFor(model.state.granularity,new Date()));
    const filterButton=available.length>1?'<button type="button" class="tbtn" data-backlog-chart-filter aria-expanded="false">'+esc(tr('Filtre','Filter')+' '+selected.length+'/'+available.length)+'</button>':'';
    const todayButton=fullTodayPos!=null?'<button type="button" class="tbtn" data-backlog-chart-today>'+esc(tr('Bugün','Today'))+'</button>':'<span class="backlogChartTodayStatus">'+esc(tr('Bugün veri aralığı dışında','Today is outside the data range'))+'</span>';
    const presetDefs=[['4w',tr('4H','4W')],['3m',tr('3Ay','3M')],['6m',tr('6Ay','6M')],['ytd','YTD'],['1y','1Y'],['fit',tr('Sığdır','Fit')],['all',tr('Tümü','All')]];
    const presetButtons=presetDefs.map(item=>{
      const key=item[0],label=item[1],active=rangesEqual(range,rangeForPreset(model,key,new Date()));
      return '<button type="button" class="backlogChartRangeBtn'+(active?' is-active':'')+'" data-backlog-chart-range="'+key+'">'+esc(label)+'</button>';
    }).join('');
    const filterPanel=available.length>1?'<div class="backlogChartFilterPanel" data-backlog-chart-filter-panel hidden><div class="backlogChartFilterHead"><input type="search" data-backlog-chart-filter-search placeholder="'+esc(tr('Seri ara…','Search series…'))+'" aria-label="'+esc(tr('Grafik serilerinde ara','Search chart series'))+'"><div><button type="button" class="tbtn" data-backlog-chart-filter-all>'+esc(tr('Tümünü göster','Show all'))+'</button><button type="button" class="tbtn primary" data-backlog-chart-filter-apply>'+esc(tr('Uygula','Apply'))+'</button></div></div><div class="backlogChartFilterList">'+available.map((name,index)=>'<label data-backlog-chart-filter-item><input type="checkbox" data-backlog-chart-series-index="'+index+'"'+(selected.includes(name)?' checked':'')+'><span>'+esc(name)+'</span></label>').join('')+'</div></div>':'';
    target.innerHTML='<div class="backlogChartTradingToolbar"><div class="backlogChartPresets">'+presetButtons+'</div><div class="backlogChartInlineActions"><span class="backlogChartRangeInfo" aria-live="polite">'+esc(rangeText)+'</span><button type="button" class="tbtn'+(model.state.showAverage?' is-active':'')+'" data-backlog-chart-average>'+esc(tr('Ortalama','Average'))+'</button><button type="button" class="tbtn'+(model.state.showSubtotal?' is-active':'')+'" data-backlog-chart-subtotal>'+esc(tr('Alt Toplam','Subtotal'))+'</button>'+todayButton+filterButton+'<button type="button" class="tbtn" data-backlog-chart-export="svg">SVG</button><button type="button" class="tbtn" data-backlog-chart-export="png">PNG</button></div></div>'
      +filterPanel
      +'<div class="backlogChartCanvas" tabindex="0" aria-label="'+esc(tr('Backlog grafiği. Tekerlek ile zoom, sürükleyerek yatay kaydırma yapabilirsiniz.','Backlog chart. Use the wheel to zoom and drag to pan horizontally.'))+'"><div class="backlogChartViewport" data-backlog-chart-viewport>'+svgChart(visible)+'<div class="backlogChartCrosshair" data-backlog-chart-crosshair hidden><i class="backlogChartCrosshairV"></i><i class="backlogChartCrosshairH"></i><span class="backlogChartCrosshairValue"></span><div class="backlogChartTooltip"></div></div></div></div>'
      +legendHtml(model)
      +'<div class="backlogChartGestureHint">'+esc(tr('Tekerlek: zoom · Sürükle: akışkan kaydır · Noktaya tıkla: bilgiyi sabitle · Legend tıkla: seri gizle · çift tık: tek seri','Wheel: zoom · Drag: smooth pan · Click a point: pin values · Click legend: hide series · double-click: isolate'))+'</div>';
    const updateRange=next=>{
      const safe=clampChartRange(next,total);chartView={signature:chartViewSignature(model),start:safe.start,end:safe.end};mountInteractiveChart(host,model,detail);
    };
    target.querySelectorAll('[data-backlog-chart-range]').forEach(button=>button.addEventListener('click',()=>updateRange(rangeForPreset(model,button.getAttribute('data-backlog-chart-range'),new Date()))));
    target.querySelector('[data-backlog-chart-average]')?.addEventListener('click',()=>{saveState(Object.assign({},state,{showAverage:!state.showAverage}));render(false,detail);});
    target.querySelector('[data-backlog-chart-subtotal]')?.addEventListener('click',()=>{saveState(Object.assign({},state,{showSubtotal:!state.showSubtotal}));render(false,detail);});
    target.querySelector('[data-backlog-chart-today]')?.addEventListener('click',()=>{if(moveViewToToday(model))mountInteractiveChart(host,model,detail);});
    target.querySelectorAll('[data-backlog-chart-export]').forEach(button=>button.addEventListener('click',()=>void exportChartGraphic(host,button.getAttribute('data-backlog-chart-export'),visible)));
    const canvas=target.querySelector('.backlogChartCanvas'),viewport=target.querySelector('[data-backlog-chart-viewport]'),svg=viewport&&viewport.querySelector('svg'),panLayer=svg&&svg.querySelector('[data-backlog-chart-pan-layer]');
    const metrics=chartMetrics(visible),cross=viewport&&viewport.querySelector('[data-backlog-chart-crosshair]');
    let pinnedIndex=null,drag=null,suppressClickUntil=0,dragFrame=0;
    function hideCrosshair(){if(cross&&pinnedIndex==null)cross.hidden=true;}
    function crosshairAt(clientX,clientY,forceIndex){
      if(!viewport||!svg||!cross)return null;
      const sr=svg.getBoundingClientRect(),vr=viewport.getBoundingClientRect();if(!sr.width||!sr.height)return null;
      let vx=(clientX-sr.left)/sr.width*metrics.width,vy=(clientY-sr.top)/sr.height*metrics.height;
      if(forceIndex==null&&(vx<metrics.left||vx>metrics.width-metrics.right||vy<metrics.top||vy>metrics.top+metrics.ph)){hideCrosshair();return null;}
      const count=Math.max(1,visible.categories.length),step=metrics.pw/count;
      let index=forceIndex==null?Math.floor((vx-metrics.left)/step):Number(forceIndex);index=Math.max(0,Math.min(count-1,index));
      const xSvg=metrics.left+step*(index+.5);vy=Math.max(metrics.top,Math.min(metrics.top+metrics.ph,vy));
      const xPx=(xSvg/metrics.width)*sr.width+(sr.left-vr.left),yPx=(vy/metrics.height)*sr.height+(sr.top-vr.top);
      const plotTop=(metrics.top/metrics.height)*sr.height+(sr.top-vr.top),plotHeight=(metrics.ph/metrics.height)*sr.height,plotLeft=(metrics.left/metrics.width)*sr.width+(sr.left-vr.left),plotWidth=(metrics.pw/metrics.width)*sr.width;
      const value=metrics.max*(1-(vy-metrics.top)/metrics.ph),cat=visible.categories[index],subtotal=(visible.series||[]).reduce((sum,serie)=>sum+(Number(serie.values[index])||0),0);
      cross.hidden=false;cross.classList.toggle('is-pinned',pinnedIndex!=null);
      cross.querySelector('.backlogChartCrosshairV').style.cssText='left:'+xPx+'px;top:'+plotTop+'px;height:'+plotHeight+'px;';
      cross.querySelector('.backlogChartCrosshairH').style.cssText='left:'+plotLeft+'px;top:'+yPx+'px;width:'+plotWidth+'px;';
      const valueEl=cross.querySelector('.backlogChartCrosshairValue');valueEl.textContent=formatWholeValue(value);valueEl.style.cssText='left:'+(plotLeft+plotWidth+4)+'px;top:'+yPx+'px;';
      const tooltip=cross.querySelector('.backlogChartTooltip');
      tooltip.innerHTML='<strong>'+esc(cat&&cat.label||'')+'</strong>'+(visible.series||[]).map(serie=>'<span><i style="--series-color:'+serie.color+'"></i><b>'+esc(serie.name)+'</b><em>'+esc(formatWholeValue(serie.values[index]))+'</em></span>').join('')+'<span class="backlogChartTooltipTotal"><i></i><b>'+esc(tr('Alt Toplam','Subtotal'))+'</b><em>'+esc(formatWholeValue(subtotal))+'</em></span>';
      tooltip.classList.toggle('is-flipped',xPx>vr.width*.62);
      const maxTooltipHeight=Math.max(120,Math.min(300,vr.height-16));
      tooltip.style.maxHeight=maxTooltipHeight+'px';
      tooltip.style.left=xPx+'px';
      const tooltipHeight=Math.min(maxTooltipHeight,tooltip.scrollHeight||maxTooltipHeight);
      tooltip.style.top=Math.max(8,Math.min(yPx-8,vr.height-tooltipHeight-8))+'px';
      return index;
    }
    function setDragTransform(px,animate){
      if(!panLayer)return;
      panLayer.style.transition=animate?'transform 140ms cubic-bezier(.2,.75,.25,1)':'none';
      panLayer.style.transform='translate3d('+px+'px,0,0)';
    }
    function animatedPan(next){
      if(!viewport||!svg){updateRange(next);return;}
      const delta=next.start-range.start;if(!delta){return;}
      const plotPx=Math.max(1,viewport.getBoundingClientRect().width*(metrics.pw/metrics.width)),pxPerBucket=plotPx/Math.max(1,span);
      setDragTransform(-delta*pxPerBucket,true);setTimeout(()=>updateRange(next),105);
    }
    viewport?.addEventListener('pointermove',event=>{
      if(drag){
        const now=performance.now(),dx=event.clientX-drag.startX,dt=Math.max(1,now-drag.lastT);
        drag.velocity=(event.clientX-drag.lastX)/dt;drag.lastX=event.clientX;drag.lastT=now;
        if(Math.abs(dx)>3){drag.moved=true;viewport.classList.add('is-grabbing');hideCrosshair();}
        if(dragFrame)cancelAnimationFrame(dragFrame);dragFrame=requestAnimationFrame(()=>setDragTransform(dx,false));return;
      }
      if(pinnedIndex==null)crosshairAt(event.clientX,event.clientY,null);
    });
    const tooltip=cross?.querySelector('.backlogChartTooltip');
    tooltip?.addEventListener('wheel',event=>event.stopPropagation(),{passive:true});
    tooltip?.addEventListener('pointerdown',event=>event.stopPropagation());
    tooltip?.addEventListener('click',event=>event.stopPropagation());
    viewport?.addEventListener('pointerleave',hideCrosshair);
    viewport?.addEventListener('pointerdown',event=>{
      if(event.button!==0)return;const now=performance.now();
      drag={pointerId:event.pointerId,startX:event.clientX,lastX:event.clientX,lastT:now,velocity:0,startRange:{start:range.start,end:range.end},moved:false};
      try{viewport.setPointerCapture(event.pointerId);}catch(_){}
    });
    viewport?.addEventListener('pointerup',event=>{
      if(!drag||drag.pointerId!==event.pointerId)return;
      const current=drag,dx=event.clientX-current.startX,momentum=current.velocity*120;drag=null;viewport.classList.remove('is-grabbing');
      try{viewport.releasePointerCapture(event.pointerId);}catch(_){}
      if(current.moved){
        suppressClickUntil=Date.now()+250;
        const plotPx=Math.max(1,viewport.getBoundingClientRect().width*(metrics.pw/metrics.width)),pxPerBucket=plotPx/Math.max(1,span);
        const shift=-Math.round((dx+momentum)/pxPerBucket),next=shiftChartRange(current.startRange,total,shift);
        const settledPx=-(next.start-current.startRange.start)*pxPerBucket;
        if(rangesEqual(next,current.startRange)){setDragTransform(0,true);return;}
        setDragTransform(settledPx,true);setTimeout(()=>updateRange(next),105);
      }else setDragTransform(0,true);
    });
    viewport?.addEventListener('pointercancel',()=>{drag=null;viewport.classList.remove('is-grabbing');setDragTransform(0,true);});
    viewport?.addEventListener('click',event=>{
      if(Date.now()<suppressClickUntil)return;const index=crosshairAt(event.clientX,event.clientY,null);if(index==null)return;
      pinnedIndex=pinnedIndex===index?null:index;if(pinnedIndex==null)crosshairAt(event.clientX,event.clientY,null);else crosshairAt(event.clientX,event.clientY,pinnedIndex);
    });
    viewport?.addEventListener('dblclick',event=>{event.preventDefault();updateRange(defaultChartRange(model,new Date()));});
    canvas?.addEventListener('wheel',event=>{
      if(total<=1)return;event.preventDefault();
      const rect=viewport?viewport.getBoundingClientRect():canvas.getBoundingClientRect(),ratio=rect.width?Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)):.5;
      if(event.shiftKey||Math.abs(event.deltaX)>Math.abs(event.deltaY)){animatedPan(panChartRange(range,total,(event.deltaX||event.deltaY)>0?1:-1));return;}
      updateRange(zoomChartRange(range,total,event.deltaY,ratio));
    },{passive:false});
    canvas?.addEventListener('keydown',event=>{
      let next=null;if(event.key==='Escape'&&pinnedIndex!=null){pinnedIndex=null;if(cross)cross.hidden=true;event.preventDefault();return;}
      if(event.key==='+'||event.key==='=')next=zoomChartRange(range,total,-1,.5);else if(event.key==='-')next=zoomChartRange(range,total,1,.5);
      else if(event.key==='ArrowLeft'){event.preventDefault();animatedPan(panChartRange(range,total,-1));return;}
      else if(event.key==='ArrowRight'){event.preventDefault();animatedPan(panChartRange(range,total,1));return;}
      else if(event.key==='0'||event.key==='Home')next=defaultChartRange(model,new Date());
      if(next){event.preventDefault();updateRange(next);}
    });
    target.querySelectorAll('[data-backlog-chart-legend-name]').forEach(button=>{
      let clickTimer=null;const name=button.getAttribute('data-backlog-chart-legend-name');
      const applyLegend=isolate=>{
        const current=filterSelection(model),set=new Set(current);let next;
        if(isolate)next=[name];else{if(set.has(name)){if(set.size<=1){notify(tr('Grafikte en az bir seri görünür kalmalı.','Keep at least one series visible.'));return;}set.delete(name);}else set.add(name);next=available.filter(item=>set.has(item));}
        saveState(Object.assign({},state,{seriesFilter:next.length===available.length?[]:next}));render(false,detail);
      };
      button.addEventListener('click',()=>{if(clickTimer)clearTimeout(clickTimer);clickTimer=setTimeout(()=>{clickTimer=null;applyLegend(false);},210);});
      button.addEventListener('dblclick',event=>{event.preventDefault();if(clickTimer){clearTimeout(clickTimer);clickTimer=null;}applyLegend(true);});
    });
    const filterToggle=target.querySelector('[data-backlog-chart-filter]'),filterPanelEl=target.querySelector('[data-backlog-chart-filter-panel]');
    filterToggle?.addEventListener('click',()=>{const opening=!!filterPanelEl?.hidden;if(filterPanelEl)filterPanelEl.hidden=!opening;filterToggle.setAttribute('aria-expanded',opening?'true':'false');if(opening)target.querySelector('[data-backlog-chart-filter-search]')?.focus();});
    target.querySelector('[data-backlog-chart-filter-search]')?.addEventListener('input',event=>{
      const q=String(event.target.value||'').toLocaleLowerCase(lang()==='en'?'en-US':'tr-TR');
      target.querySelectorAll('[data-backlog-chart-filter-item]').forEach(label=>{label.hidden=q&&!String(label.textContent||'').toLocaleLowerCase(lang()==='en'?'en-US':'tr-TR').includes(q);});
    });
    target.querySelector('[data-backlog-chart-filter-all]')?.addEventListener('click',()=>{saveState(Object.assign({},state,{seriesFilter:[]}));render(false,detail);});
    target.querySelector('[data-backlog-chart-filter-apply]')?.addEventListener('click',()=>{
      const chosen=[...target.querySelectorAll('[data-backlog-chart-series-index]:checked')].map(input=>available[Number(input.getAttribute('data-backlog-chart-series-index'))]).filter(Boolean);
      if(!chosen.length){notify(tr('Grafikte en az bir seri seçili kalmalı.','Keep at least one series selected.'));return;}
      saveState(Object.assign({},state,{seriesFilter:chosen.length===available.length?[]:chosen}));render(false,detail);
    });
  }
  function cacheSignature(params) {
    return Object.keys(params||{}).sort().map(k=>k+'='+String(params[k]==null?'':params[k])).join('&');
  }
  function queryParams() {
    try {
      const ctx=root.BLBacklogChartContext;
      return ctx && typeof ctx.queryParams==='function' ? (ctx.queryParams()||{}) : {};
    } catch (_) { return {}; }
  }
  async function loadDetail(force) {
    try {
      const ctx=root.BLBacklogChartContext;
      if(ctx&&typeof ctx.prepareQuery==='function')await ctx.prepareQuery();
    } catch (_) {}
    const params=queryParams(), sig=cacheSignature(params);
    if (!force && cache.signature===sig && cache.rows.length) return cache;
    const qs=new URLSearchParams(Object.entries(params).filter(([,v])=>v!=null&&v!=='')).toString();
    const res=await root.fetch('/api/backlog-export'+(qs?'?'+qs:''));
    if(!res.ok){ let msg=res.statusText; try{const e=await res.json();msg=e.error||msg;}catch(_){} throw new Error(msg); }
    const data=await res.json();
    cache={signature:sig,headers:normalizeHeaders(data.headers||[],data.rows||[]),rows:Array.isArray(data.rows)?data.rows:[]};
    return cache;
  }
  function invalidate() { cache={signature:'',headers:[],rows:[]}; }

  function panel() { return root.document && root.document.getElementById('backlogChartPanel'); }
  async function render(force,detailOverride) {
    const host=panel(); if(!host || !state.enabled) { if(host)host.hidden=true; return; }
    host.hidden=false;
    host.innerHTML='<div class="backlogChartLoading">'+esc(tr('Grafik hazırlanıyor…','Preparing chart…'))+'</div>';
    try {
      const detail=detailOverride||await loadDetail(!!force);
      const inferred=inferState(detail.headers,detail.rows,state);
      if(!inferred.timeField) throw new Error(tr('Grafik için tarih alanı bulunamadı.','No date field was found for the chart.'));
      if(inferred.timeField!==state.timeField || inferred.metricField!==state.metricField || inferred.seriesField!==state.seriesField) {
        const preserveFilter=inferred.seriesField===state.seriesField?state.seriesFilter:[];
        saveState(Object.assign({},state,inferred,{enabled:true,seriesFilter:preserveFilter}));
      }
      const model=buildModel(detail.rows,detail.headers,state);
      if(!model.categories.length||!model.series.length) throw new Error(tr('Seçili ayarlarla grafikte gösterilecek veri yok.','There is no chart data for the selected settings.'));
      host.innerHTML='<div class="backlogChartHead"><div><strong>'+esc(model.title)+'</strong><small>'+esc(configSummary(model.state))+'</small></div>'
        +'<div class="backlogChartActions"><button type="button" class="tbtn" data-backlog-chart-refresh>'+esc(tr('Yenile','Refresh'))+'</button>'
        +'<button type="button" class="tbtn" data-backlog-chart-edit>'+esc(tr('Ayarlar','Settings'))+'</button>'
        +'<button type="button" class="tbtn" data-backlog-chart-disable aria-label="'+esc(tr('Grafiği kapat','Hide chart'))+'">×</button></div></div>'
        +(model.omittedSeriesCount?'<div class="backlogChartNotice">'+esc(tr('Okunabilirlik için en yüksek '+model.series.length+' seri gösteriliyor; '+model.omittedSeriesCount+' seri gizli. Ayarlardan seri limitini artırabilirsiniz.','Showing the top '+model.series.length+' series; '+model.omittedSeriesCount+' series are hidden. Increase the series limit in settings.'))+'</div>':'')
        +'<div data-backlog-chart-body></div>';
      mountInteractiveChart(host,model,detail);
      host.querySelector('[data-backlog-chart-edit]')?.addEventListener('click',openSettings);
      host.querySelector('[data-backlog-chart-refresh]')?.addEventListener('click',()=>{invalidate();render(true);});
      host.querySelector('[data-backlog-chart-disable]')?.addEventListener('click',()=>{saveState(Object.assign({},state,{enabled:false}));host.hidden=true;});
    } catch(err) {
      host.innerHTML='<div class="backlogChartError">'+esc(tr('Grafik oluşturulamadı: ','Chart could not be created: ')+err.message)+'</div>';
    }
  }
  function optionHtml(values,selected,blankLabel) {
    let html=blankLabel!=null?'<option value="">'+esc(blankLabel)+'</option>':'';
    return html+values.map(v=>'<option value="'+esc(v)+'"'+(v===selected?' selected':'')+'>'+esc(v)+'</option>').join('');
  }
  async function openSettings() {
    if(!root.document)return;
    root.document.getElementById('_backlogChartSettingsModal')?.remove();
    const overlay=root.document.createElement('div');overlay.id='_backlogChartSettingsModal';overlay.className='autoModalOverlay';
    overlay.innerHTML='<div class="autoModal backlogChartSettingsModal"><header><h3>'+esc(tr('Backlog Grafik Ayarları','Backlog Chart Settings'))+'</h3><button type="button" data-chart-close>×</button></header><div class="autoModalBody"><div class="backlogChartLoading">'+esc(tr('Alanlar yükleniyor…','Loading fields…'))+'</div></div></div>';
    root.document.body.appendChild(overlay);const close=()=>overlay.remove();overlay.querySelector('[data-chart-close]')?.addEventListener('click',close);
    let detail;try{detail=await loadDetail(false);}catch(err){overlay.querySelector('.autoModalBody').innerHTML='<div class="backlogChartError">'+esc(err.message)+'</div>';return;}
    const headers=normalizeHeaders(detail.headers,detail.rows),dates=detectDateHeaders(headers,detail.rows),draft=inferState(headers,detail.rows,state),body=overlay.querySelector('.autoModalBody');
    body.innerHTML='<div class="backlogChartSettingsGrid">'
      +'<label><span>'+esc(tr('Zaman alanı 1','Time field 1'))+'</span><select id="backlogChartTime">'+optionHtml(dates,draft.timeField,null)+'</select></label>'
      +'<label><span>'+esc(tr('Zaman alanı 2 (opsiyonel)','Time field 2 (optional)'))+'</span><select id="backlogChartTime2">'+optionHtml(dates,draft.timeField2,tr('İkinci zaman alanı yok','No second time field'))+'</select></label>'
      +'<label><span>'+esc(tr('Zaman kırılımı','Time interval'))+'</span><select id="backlogChartGran"><option value="day">'+esc(tr('Gün','Day'))+'</option><option value="week">'+esc(tr('Hafta','Week'))+'</option><option value="month">'+esc(tr('Ay','Month'))+'</option><option value="year">'+esc(tr('Yıl','Year'))+'</option></select></label>'
      +'<label><span>'+esc(tr('Adet / değer alanı','Quantity / value field'))+'</span><select id="backlogChartMetric"><option value="__records">'+esc(tr('Kayıtlar','Records'))+'</option>'+optionHtml(headers,draft.metricField,null)+'</select></label>'
      +'<label><span>'+esc(tr('Hesaplama','Aggregation'))+'</span><select id="backlogChartAgg"><option value="count">'+esc(tr('Adet','Count'))+'</option><option value="distinct">'+esc(tr('Benzersiz adet','Distinct count'))+'</option><option value="sum">'+esc(tr('Toplam','Sum'))+'</option><option value="avg">'+esc(tr('Ortalama','Average'))+'</option></select></label>'
      +'<label><span>'+esc(tr('Kırılım / seri','Breakdown / series'))+'</span><select id="backlogChartSeries">'+optionHtml(headers,draft.seriesField,tr('Kırılım yok','No breakdown'))+'</select></label>'
      +'<label><span>'+esc(tr('Grafik tipi','Chart type'))+'</span><select id="backlogChartType"><option value="line">'+esc(tr('Çizgi','Line'))+'</option><option value="bar">'+esc(tr('Sütun','Column'))+'</option></select></label>'
      +'<label><span>'+esc(tr('Seri limiti','Series limit'))+'</span><select id="backlogChartLimit"><option value="5">5</option><option value="10">10</option><option value="20">20</option><option value="50">50</option><option value="all">'+esc(tr('Tümü','All'))+'</option></select></label>'
      +'<label class="backlogChartToggleField"><input id="backlogChartAverage" type="checkbox"'+(draft.showAverage?' checked':'')+'><span>'+esc(tr('Görünür aralık ortalama çizgisini göster','Show visible-range average line'))+'</span></label>'
      +'<label class="backlogChartTitleField"><span>'+esc(tr('Başlık (opsiyonel)','Title (optional)'))+'</span><input id="backlogChartTitle" type="text" maxlength="160" value="'+esc(draft.title)+'"></label>'
      +'</div><p class="backlogChartSettingsHint">'+esc(tr('İkinci zaman alanı aynı metriği iki tarih eksenine göre üst üste bindirir. Excel aktarımı ekrandaki görünür tarih aralığını ve seri filtresini korur.','The second time field overlays the same metric by another date field. Excel export keeps the visible time range and series filter.'))+'</p>';
    const modal=overlay.querySelector('.autoModal'),footer=root.document.createElement('footer');
    footer.innerHTML=(state.enabled?'<button type="button" class="tbtn" data-chart-remove>'+esc(tr('Grafiği kaldır','Remove chart'))+'</button>':'<span></span>')+'<button type="button" class="tbtn" data-chart-cancel>'+esc(tr('Vazgeç','Cancel'))+'</button><button type="button" class="tbtn primary" data-chart-save>'+esc(tr('Uygula','Apply'))+'</button>';
    modal.appendChild(footer);
    const set=(id,val)=>{const el=overlay.querySelector('#'+id);if(el)el.value=val;};
    set('backlogChartGran',draft.granularity);set('backlogChartAgg',draft.aggregation);set('backlogChartType',draft.chartType);set('backlogChartLimit',draft.seriesLimit);
    overlay.querySelector('[data-chart-cancel]')?.addEventListener('click',close);
    overlay.querySelector('[data-chart-remove]')?.addEventListener('click',()=>{saveState(Object.assign({},state,{enabled:false}));const p=panel();if(p)p.hidden=true;close();});
    overlay.querySelector('[data-chart-save]')?.addEventListener('click',()=>{
      const seriesField=overlay.querySelector('#backlogChartSeries')?.value;
      const next=sanitizeState({enabled:true,timeField:overlay.querySelector('#backlogChartTime')?.value,timeField2:overlay.querySelector('#backlogChartTime2')?.value,granularity:overlay.querySelector('#backlogChartGran')?.value,metricField:overlay.querySelector('#backlogChartMetric')?.value,aggregation:overlay.querySelector('#backlogChartAgg')?.value,seriesField,seriesFilter:seriesField===state.seriesField?state.seriesFilter:[],chartType:overlay.querySelector('#backlogChartType')?.value,seriesLimit:overlay.querySelector('#backlogChartLimit')?.value,title:overlay.querySelector('#backlogChartTitle')?.value,showAverage:!!overlay.querySelector('#backlogChartAverage')?.checked});
      if(!next.timeField){notify(tr('Grafik için bir tarih alanı seçin.','Select a date field for the chart.'));return;}
      if(next.metricField==='__records')next.aggregation='count';
      const model=buildModel(detail.rows,detail.headers,next);if(!model.categories.length){notify(tr('Seçili tarih alanında grafiğe uygun veri yok.','The selected date field has no chartable data.'));return;}
      saveState(next);chartView={signature:'',start:0,end:0};close();render(false,detail);
    });
    overlay.addEventListener('mousedown',e=>{if(e.target===overlay)close();});
  }
  function uniqueSheetName(wb,base) {
    const used=new Set((wb.SheetNames||[]).map(String));
    if(!used.has(base))return base;
    for(let i=2;i<100;i++){const n=(base+' '+i).slice(0,31);if(!used.has(n))return n;}
    return (base.slice(0,27)+' '+Date.now().toString().slice(-3)).slice(0,31);
  }
  function excelColumn(index) {
    let n=index+1,out=''; while(n>0){const r=(n-1)%26;out=String.fromCharCode(65+r)+out;n=Math.floor((n-1)/26);} return out;
  }
  function quoteSheet(name) { return "'"+String(name).replace(/'/g,"''")+"'"; }
  function appendWorkbookSheets(wb,rows,headers,options) {
    const opts=options||{},XLSX=opts.XLSX||root.XLSX,st=sanitizeState(opts.state||state);
    if(!st.enabled||!st.timeField||!XLSX||!XLSX.utils||!wb)return null;
    const fullModel=buildModel(rows,headers,st);if(!fullModel.categories.length||!fullModel.series.length)return null;
    const range=opts.viewRange?clampChartRange(opts.viewRange,fullModel.categories.length):ensureChartView(fullModel);
    const model=sliceModel(fullModel,range);if(!model.categories.length)return null;
    const chartName=uniqueSheetName(wb,tr('Grafik','Chart')),dataName=uniqueSheetName(wb,tr('Grafik Verisi','Chart Data'));
    const chartWs=XLSX.utils.aoa_to_sheet([[model.title],[configSummary(st)],[tr('Görünür aralık','Visible range')+': '+(model.categories[0]?.label||'')+' – '+(model.categories[model.categories.length-1]?.label||'')],[]]);
    chartWs['!cols']=[{wch:28},{wch:18},{wch:18},{wch:18},{wch:18},{wch:18},{wch:18},{wch:18},{wch:18},{wch:18},{wch:18},{wch:18}];XLSX.utils.book_append_sheet(wb,chartWs,chartName);

    const live=opts.liveSource&&opts.liveSource.bucket1Col&&opts.liveSource.metricCol&&Number(opts.liveSource.lastRow)>=Number(opts.liveSource.firstRow)?opts.liveSource:null;
    const sourceSheet=live?quoteSheet(live.sheetName||'BACKLOG'):'';
    const sourceRange=col=>live&&col?sourceSheet+'!$'+col+'$'+Number(live.firstRow)+':$'+col+'$'+Number(live.lastRow):'';
    const formulaText=value=>'"'+String(value==null?'':value).replace(/"/g,'""')+'"';
    const metricRange=live?sourceRange(live.metricCol):'',seriesRange=live&&live.seriesCol?sourceRange(live.seriesCol):'';
    const liveFormula=(serie,keyRef)=>{
      if(!live)return '';
      const bucketCol=serie.timeFieldIndex===2&&live.bucket2Col?live.bucket2Col:live.bucket1Col;
      const bucketRange=sourceRange(bucketCol);if(!bucketRange)return '';
      const criteria=[bucketRange,keyRef],hasSeries=!!(st.seriesField&&seriesRange);
      if(hasSeries)criteria.push(seriesRange,formulaText(serie.baseName));
      if(st.aggregation==='sum')return 'IFERROR(SUMIFS('+metricRange+','+criteria.join(',')+'),0)';
      if(st.aggregation==='avg')return 'IFERROR(AVERAGEIFS('+metricRange+','+criteria.join(',')+'),0)';
      if(st.aggregation==='count'){
        if(st.metricField==='__records')return 'COUNTIFS('+criteria.join(',')+')';
        return 'COUNTIFS('+criteria.concat([metricRange,'"<>"']).join(',')+')';
      }
      if(st.aggregation==='distinct'){
        const predicates=['('+bucketRange+'='+keyRef+')'];
        if(hasSeries)predicates.push('('+seriesRange+'='+formulaText(serie.baseName)+')');
        predicates.push('('+metricRange+'<>"")');
        return 'IFERROR(ROWS(UNIQUE(FILTER('+metricRange+','+predicates.join('*')+'))),0)';
      }
      return '';
    };

    const baseSeries=model.series.map(item=>Object.assign({},item));
    const subtotalIndex=2+baseSeries.length,avgIndex=st.showAverage?subtotalIndex+1:-1;
    const headerRow=[tr('Zaman','Time'),'_BL_KEY',...baseSeries.map(item=>item.name),tr('Alt Toplam','Subtotal')];
    if(st.showAverage)headerRow.push(tr('Ortalama','Average'));
    const matrix=[headerRow],cachedTotals=subtotalValues(model),avg=averageValue(model);
    model.categories.forEach((cat,i)=>{
      const excelRow=i+2,row=[axisTickLabel(cat,st.granularity),cat.key];
      baseSeries.forEach((serie,si)=>{
        const formula=liveFormula(serie,'$B'+excelRow),cached=Number(serie.values[i])||0;
        row.push(formula?{f:formula,v:cached,t:'n'}:cached);
      });
      const firstSeriesCol=excelColumn(2),lastSeriesCol=excelColumn(1+baseSeries.length);
      row.push({f:'SUM('+firstSeriesCol+excelRow+':'+lastSeriesCol+excelRow+')',v:cachedTotals[i]||0,t:'n'});
      if(st.showAverage){
        const subtotalCol=excelColumn(subtotalIndex),lastDataRow=model.categories.length+1;
        row.push({f:'AVERAGE($'+subtotalCol+'$2:$'+subtotalCol+'$'+lastDataRow+')',v:avg,t:'n'});
      }
      matrix.push(row);
    });
    const dataWs=XLSX.utils.aoa_to_sheet(matrix);
    dataWs['!cols']=[{wch:20},{hidden:true,wch:2},...baseSeries.map(()=>({wch:18})),{hidden:true,wch:2},...(st.showAverage?[{wch:18}]:[])];
    XLSX.utils.book_append_sheet(wb,dataWs,dataName);

    const first=2,last=model.categories.length+1,categories=quoteSheet(dataName)+'!$A$'+first+':$A$'+last;
    const series=baseSeries.map((serie,i)=>({name:serie.name,valuesFormula:quoteSheet(dataName)+'!$'+excelColumn(i+2)+'$'+first+':$'+excelColumn(i+2)+'$'+last,dash:!!serie.dash,color:String(serie.color||'').replace('#',''),isAverage:false}));
    if(st.showAverage)series.push({name:tr('Ortalama','Average'),valuesFormula:quoteSheet(dataName)+'!$'+excelColumn(avgIndex)+'$'+first+':$'+excelColumn(avgIndex)+'$'+last,dash:true,color:'64748B',isAverage:true});
    const metrics=chartMetrics(model);
    return {model,viewRange:range,live:!!live,charts:[{sheetPath:'xl/worksheets/sheet'+((wb.SheetNames||[]).indexOf(chartName)+1)+'.xml',chartType:st.chartType,title:model.title,categoriesFormula:categories,series,majorUnit:metrics.tickStep,maxValue:metrics.max,axisFormatCode:metrics.max>=1000?'0,"k"':'#,##0',anchor:{fromCol:0,fromRow:4,toCol:15,toRow:28}}],chartSheetName:chartName,dataSheetName:dataName};
  }
  function titleXml(title) {
    return '<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="'+(lang()==='en'?'en-US':'tr-TR')+'"/><a:t>'+xml(title)+'</a:t></a:r><a:endParaRPr lang="'+(lang()==='en'?'en-US':'tr-TR')+'"/></a:p></c:rich></c:tx><c:layout/><c:overlay val="0"/></c:title>';
  }
  function chartXml(spec,index) {
    const catAx=100000+index*2,valAx=catAx+1;
    const seriesXml=(items,kind,offset)=>(items||[]).map((s,i)=>{
      const order=(Number(offset)||0)+i,color=String(s.color||'').replace(/[^0-9A-F]/ig,'').slice(0,6),lineStyle=color?'<c:spPr><a:ln w="19050"><a:solidFill><a:srgbClr val="'+color.toUpperCase()+'"/></a:solidFill>'+(s.dash?'<a:prstDash val="dash"/>':'')+'</a:ln></c:spPr>':'';
      return '<c:ser><c:idx val="'+order+'"/><c:order val="'+order+'"/><c:tx><c:v>'+xml(s.name)+'</c:v></c:tx>'+(kind==='line'?(s.isAverage?'<c:marker><c:symbol val="none"/></c:marker>':'<c:marker><c:symbol val="circle"/><c:size val="5"/></c:marker>'):'')+lineStyle+'<c:cat><c:strRef><c:f>'+xml(spec.categoriesFormula)+'</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>'+xml(s.valuesFormula)+'</c:f></c:numRef></c:val>'+(kind==='line'?'<c:smooth val="0"/>':'')+'</c:ser>';
    }).join('');
    const all=spec.series||[],avg=all.filter(s=>s.isAverage),normal=all.filter(s=>!s.isAverage);
    let chartBody;
    if(spec.chartType==='bar'){
      chartBody='<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>'+seriesXml(normal,'bar',0)+'<c:axId val="'+catAx+'"/><c:axId val="'+valAx+'"/></c:barChart>';
      if(avg.length)chartBody+='<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>'+seriesXml(avg,'line',normal.length)+'<c:marker val="1"/><c:smooth val="0"/><c:axId val="'+catAx+'"/><c:axId val="'+valAx+'"/></c:lineChart>';
    }else chartBody='<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>'+seriesXml(all,'line',0)+'<c:marker val="1"/><c:smooth val="0"/><c:axId val="'+catAx+'"/><c:axId val="'+valAx+'"/></c:lineChart>';
    const scaling='<c:scaling><c:orientation val="minMax"/><c:min val="0"/>'+(Number(spec.maxValue)>0?'<c:max val="'+Number(spec.maxValue)+'"/>':'')+'</c:scaling>';
    const major=Number(spec.majorUnit)>0?'<c:majorUnit val="'+Number(spec.majorUnit)+'"/>':'';
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:date1904 val="0"/><c:lang val="'+(lang()==='en'?'en-US':'tr-TR')+'"/><c:chart>'+titleXml(spec.title||'')+'<c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>'+chartBody+'<c:catAx><c:axId val="'+catAx+'"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:tickLblPos val="nextTo"/><c:crossAx val="'+valAx+'"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/></c:catAx><c:valAx><c:axId val="'+valAx+'"/>'+scaling+'<c:delete val="0"/><c:axPos val="r"/><c:majorGridlines/><c:numFmt formatCode="'+xml(spec.axisFormatCode||'#,##0')+'" sourceLinked="0"/><c:tickLblPos val="nextTo"/>'+major+'<c:crossAx val="'+catAx+'"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx></c:plotArea><c:legend><c:legendPos val="b"/><c:layout/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="zero"/><c:showDLblsOverMax val="0"/></c:chart><c:printSettings><c:headerFooter/><c:pageMargins b="0.75" l="0.7" r="0.7" t="0.75" header="0.3" footer="0.3"/><c:pageSetup/></c:printSettings></c:chartSpace>';
  }
  function drawingXml(chartRelId,spec,index) {
    const a=spec.anchor||{},fc=Number.isFinite(+a.fromCol)?+a.fromCol:0,fr=Number.isFinite(+a.fromRow)?+a.fromRow:2,tc=Number.isFinite(+a.toCol)?+a.toCol:15,trr=Number.isFinite(+a.toRow)?+a.toRow:27;
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      +'<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
      +'<xdr:twoCellAnchor><xdr:from><xdr:col>'+fc+'</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>'+fr+'</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>'
      +'<xdr:to><xdr:col>'+tc+'</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>'+trr+'</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>'
      +'<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="'+(index+2)+'" name="Buyer Log Chart '+(index+1)+'"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm/>'
      +'<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="'+chartRelId+'"/></a:graphicData></a:graphic>'
      +'</xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>';
  }
  function relsXml(items) {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+items.join('')+'</Relationships>';
  }
  function nextRid(source) {
    let max=0; String(source||'').replace(/Id="rId(\d+)"/g,(_,n)=>{max=Math.max(max,+n);return _;}); return 'rId'+(max+1);
  }
  function addRelationship(source,id,type,target) {
    const rel='<Relationship Id="'+id+'" Type="'+type+'" Target="'+xml(target)+'"/>';
    if(!source)return relsXml([rel]);
    return String(source).replace(/<\/Relationships>\s*$/i,rel+'</Relationships>');
  }
  function addDrawingToWorksheet(source,rid) {
    let xmlText=String(source||'');
    xmlText=xmlText.replace(/<worksheet\b([^>]*)>/i,(whole,attrs)=>{
      return /xmlns:r=/.test(attrs)?whole:'<worksheet'+attrs+' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">';
    });
    const node='<drawing r:id="'+rid+'"/>';
    const marker=/<(?:legacyDrawing|legacyDrawingHF|picture|oleObjects|controls|webPublishItems|tableParts|extLst)\b/i.exec(xmlText);
    const at=marker?marker.index:xmlText.lastIndexOf('</worksheet>');
    if(at<0)throw new Error('Worksheet closing tag was not found for chart export.');
    return xmlText.slice(0,at)+node+xmlText.slice(at);
  }
  function addContentOverride(source,partName,contentType) {
    if(String(source).includes('PartName="'+partName+'"'))return source;
    const item='<Override PartName="'+partName+'" ContentType="'+contentType+'"/>';
    return String(source).replace(/<\/Types>\s*$/i,item+'</Types>');
  }
  function nextPartNumber(zip,prefix,re) {
    let max=0;
    Object.keys(zip.files||{}).forEach(name=>{const m=name.match(re);if(m)max=Math.max(max,+m[1]);});
    return max+1;
  }
  async function applyExcelCharts(data,specs,JSZipCtor,outputType) {
    const Zip=JSZipCtor || root.JSZip;
    if(!Zip||typeof Zip.loadAsync!=='function')throw new Error('JSZip is required for Excel charts.');
    const list=Array.isArray(specs)?specs.filter(Boolean):[];
    if(!list.length)return data;
    const zip=await Zip.loadAsync(data);
    const typesEntry=zip.file('[Content_Types].xml');
    if(!typesEntry)throw new Error('Excel content types file was not found.');
    let contentTypes=await typesEntry.async('string');
    let chartNo=nextPartNumber(zip,'xl/charts',/^xl\/charts\/chart(\d+)\.xml$/i);
    let drawingNo=nextPartNumber(zip,'xl/drawings',/^xl\/drawings\/drawing(\d+)\.xml$/i);
    for(let i=0;i<list.length;i++,chartNo++,drawingNo++){
      const spec=list[i],sheetPath=String(spec.sheetPath||'');
      const sheetEntry=zip.file(sheetPath); if(!sheetEntry)throw new Error('Excel chart worksheet was not found: '+sheetPath);
      let sheetXml=await sheetEntry.async('string');
      const fileName=sheetPath.split('/').pop();
      const relPath=sheetPath.replace(/\/[^/]+$/, '/_rels/'+fileName+'.rels');
      const relEntry=zip.file(relPath);
      let sheetRels=relEntry?await relEntry.async('string'):'';
      const drawingRid=nextRid(sheetRels);
      sheetRels=addRelationship(sheetRels,drawingRid,'http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing','../drawings/drawing'+drawingNo+'.xml');
      sheetXml=addDrawingToWorksheet(sheetXml,drawingRid);
      zip.file(sheetPath,sheetXml); zip.file(relPath,sheetRels);
      const chartPath='xl/charts/chart'+chartNo+'.xml',drawingPath='xl/drawings/drawing'+drawingNo+'.xml',drawingRelPath='xl/drawings/_rels/drawing'+drawingNo+'.xml.rels';
      zip.file(chartPath,chartXml(spec,i));
      zip.file(drawingPath,drawingXml('rId1',spec,i));
      zip.file(drawingRelPath,relsXml(['<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart'+chartNo+'.xml"/>']));
      contentTypes=addContentOverride(contentTypes,'/'+chartPath,'application/vnd.openxmlformats-officedocument.drawingml.chart+xml');
      contentTypes=addContentOverride(contentTypes,'/'+drawingPath,'application/vnd.openxmlformats-officedocument.drawing+xml');
    }
    zip.file('[Content_Types].xml',contentTypes);
    return zip.generateAsync({type:outputType||'uint8array',compression:'DEFLATE',compressionOptions:{level:6}});
  }

  function init() {
    if(initialized||!root.document)return; initialized=true; loadState();
    root.document.getElementById('backlogChartBtn')?.addEventListener('click',openSettings);
    const host=panel(); if(host&&state.enabled)host.hidden=false;
  }
  function onBacklogRendered(data) {
    invalidate();
    if(data&&state.enabled)render(true);
  }

  return Object.freeze({
    init,onBacklogRendered,openSettings,render,invalidate,
    getState,getViewRange,saveState,sanitizeState,normalizeHeaders,detectDateHeaders,inferState,
    parseDate,parseNumber,bucketFor,buildModel,appendWorkbookSheets,
    svgChart,todayKeyFor,todayPosition,axisTickLabel,chartMetrics,niceStep,niceTickScale,formatWholeValue,formatAxisValue,averageValue,clampChartRange,defaultVisibleSpan,defaultChartRange,rangeForPreset,zoomChartRange,shiftChartRange,panChartRange,sliceModel,
    chartXml,drawingXml,applyExcelCharts,
  });
});
