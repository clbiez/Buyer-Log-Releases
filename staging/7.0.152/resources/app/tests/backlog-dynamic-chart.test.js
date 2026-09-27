'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');
const JSZip = require('../public/vendor/jszip.min.js');
const dateDimension = require('../public/date-dimension.js');

global.BLDateDimension = dateDimension;
const ROOT = path.join(__dirname, '..');
const chart = require(path.join(ROOT, 'public', 'backlog-chart.js'));
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'public', 'app-main.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'app.css'), 'utf8');

const headers = ['Model Bütçe Tarihi','Adet','Buyer','MAG'];
const rows = [
  {'Model Bütçe Tarihi':'31.08.2026',Adet:10,Buyer:'A',MAG:'M1'},
  {'Model Bütçe Tarihi':'01.09.2026',Adet:5,Buyer:'A',MAG:'M1'},
  {'Model Bütçe Tarihi':'02.09.2026',Adet:7,Buyer:'B',MAG:'M2'},
  {'Model Bütçe Tarihi':'08.09.2026',Adet:3,Buyer:'A',MAG:'M2'},
];

function state(extra={}) {
  return Object.assign({
    enabled:true,timeField:'Model Bütçe Tarihi',timeField2:'',granularity:'week',
    metricField:'Adet',aggregation:'sum',seriesField:'Buyer',
    chartType:'line',seriesLimit:'20',title:'',showAverage:false,showSubtotal:false,
  },extra);
}

test('Backlog chart uses the shared Collection month/week date dimension', () => {
  const model = chart.buildModel(rows, headers, state());
  assert.equal(model.categories.length, 2);
  assert.equal(model.categories[0].label, '36. Hafta Eylül 2026');
  assert.equal(model.categories[1].label, '37. Hafta Eylül 2026');
  const a = model.series.find(item => item.name === 'A');
  const b = model.series.find(item => item.name === 'B');
  assert.deepEqual(a.values, [15,3]);
  assert.deepEqual(b.values, [7,0]);

  const month = chart.buildModel(rows, headers, state({granularity:'month'}));
  assert.deepEqual(month.categories.map(item=>item.label), ['Eylül 2026']);
  assert.deepEqual(month.series.find(item=>item.name==='A').values, [18]);
  assert.deepEqual(month.series.find(item=>item.name==='B').values, [7]);
  assert.equal(chart.bucketFor(chart.parseDate('31.08.2026'),'month').label,'Eylül 2026');
});

test('Backlog chart filters series inside the chart before applying the series limit', () => {
  const filtered=chart.buildModel(rows,headers,state({seriesFilter:['B'],seriesLimit:'5'}));
  assert.deepEqual(filtered.availableSeriesNames,['A','B']);
  assert.deepEqual(filtered.series.map(item=>item.name),['B']);
  assert.equal(filtered.filteredOutSeriesCount,1);
  assert.deepEqual(filtered.series[0].values,[7,0]);

  const sanitized=chart.sanitizeState(Object.assign({},state(),{seriesFilter:[' A ','A','B','']}));
  assert.deepEqual(sanitized.seriesFilter,['A','B']);
});

test('Backlog chart TradingView-style ranges open at a readable window and support presets', () => {
  const categories=Array.from({length:60},(_,i)=>{
    const d=new Date(2026,0,5+i*7);
    return {key:chart.bucketFor(d,'week').key,label:chart.bucketFor(d,'week').label};
  });
  const fake={state:state({granularity:'week'}),categories,series:[]};
  assert.equal(chart.defaultVisibleSpan('week',60),16);
  const initial=chart.defaultChartRange(fake,new Date(2026,8,25));
  assert.equal(initial.end-initial.start,16);
  const fourWeeks=chart.rangeForPreset(fake,'4w',new Date(2026,8,25));
  assert.equal(fourWeeks.end-fourWeeks.start,4);
  const threeMonths=chart.rangeForPreset(fake,'3m',new Date(2026,8,25));
  assert.equal(threeMonths.end-threeMonths.start,13);
  assert.deepEqual(chart.rangeForPreset(fake,'all',new Date(2026,8,25)),{start:0,end:60});
});

test('Backlog chart zoom range helpers clamp, zoom and pan without losing the data window', () => {
  assert.deepEqual(chart.clampChartRange({start:-5,end:50},12),{start:0,end:12});
  const zoomed=chart.zoomChartRange({start:0,end:12},12,-1,.5);
  assert.ok(zoomed.end-zoomed.start<12);
  assert.ok(zoomed.end-zoomed.start>=4);
  const panned=chart.panChartRange(zoomed,12,1);
  assert.equal(panned.end-panned.start,zoomed.end-zoomed.start);
  const sliced=chart.sliceModel(chart.buildModel(rows,headers,state()),{start:0,end:1});
  assert.equal(sliced.categories.length,1);
  assert.equal(sliced.series[0].values.length,1);
});

test('Backlog chart renders a current-date marker when today falls inside the visible range', () => {
  const model=chart.buildModel(rows,headers,state());
  const svg=chart.svgChart(model,{today:new Date(2026,8,2)});
  assert.match(svg,/backlogChartTodayLine/);
  assert.match(svg,/backlogChartTodayBadge/);
  assert.match(svg,/backlogChartPriceAxis/);
  assert.match(svg,/Bugün/);
  assert.doesNotMatch(chart.svgChart(model,{today:new Date(2030,0,1)}),/backlogChartTodayLine/);
});

test('Backlog chart supports a second time field as an overlaid dashed series', () => {
  const overlayHeaders=[...headers,'Retail Tarihi'];
  const overlayRows=rows.map((row,index)=>({...row,'Retail Tarihi':['07.09.2026','08.09.2026','09.09.2026','15.09.2026'][index]}));
  const model=chart.buildModel(overlayRows,overlayHeaders,state({timeField2:'Retail Tarihi'}));
  assert.equal(model.fieldSpecs.length,2);
  assert.equal(model.series.length,4);
  assert.ok(model.series.some(item=>item.timeFieldIndex===2&&item.dash===true));
  assert.ok(model.series.some(item=>item.name.includes('Retail Tarihi')));
});

test('Backlog chart uses whole-number nice ticks and compact time labels', () => {
  assert.equal(chart.niceStep(149000,5),30000);
  assert.equal(chart.niceStep(249000,5),50000);
  assert.equal(chart.niceStep(499000,5),100000);
  assert.equal(chart.formatWholeValue(12205.25),'12.205');
  assert.equal(chart.axisTickLabel({key:'2026-W33',label:'33. Hafta Ağustos 2026'},'week'),'33');
  assert.equal(chart.axisTickLabel({key:'2026-05',label:'May 2026'},'month'),'MAY 26');
});

test('Backlog chart average line is calculated from visible plotted data points', () => {
  const model=chart.buildModel(rows,headers,state({showAverage:true}));
  assert.equal(chart.averageValue(model),6.25);
  const svg=chart.svgChart(model,{today:new Date(2030,0,1)});
  assert.match(svg,/backlogChartAverageLine/);
  assert.match(svg,/Ort\.|Avg\./);
});

test('Backlog chart average follows the visible window and subtotal is a toggleable dashed line', () => {
  const full=chart.buildModel(rows,headers,state({showAverage:true,showSubtotal:true}));
  const visible=chart.sliceModel(full,{start:0,end:1});
  assert.equal(chart.averageValue(visible),11);
  const svg=chart.svgChart(visible,{today:new Date(2030,0,1)});
  assert.match(svg,/backlogChartSubtotalLine/);
  assert.match(svg,/backlogChartPanLayer/);
  assert.match(svg,/backlogChartPlotMask/);
  assert.match(svg,/(?:Ort\.|Avg\.) 11/);
  assert.ok(chart.chartMetrics(visible).max>=22);
});

test('Backlog chart supports count, distinct count, sum and average aggregations', () => {
  assert.deepEqual(chart.buildModel(rows,headers,state({aggregation:'count'})).series.find(s=>s.name==='A').values,[2,1]);
  assert.deepEqual(chart.buildModel(rows,headers,state({aggregation:'distinct',metricField:'MAG'})).series.find(s=>s.name==='A').values,[1,1]);
  assert.deepEqual(chart.buildModel(rows,headers,state({aggregation:'avg'})).series.find(s=>s.name==='A').values,[7.5,3]);
  const records=chart.buildModel(rows,headers,state({metricField:'__records',aggregation:'count',seriesField:''}));
  assert.deepEqual(records.series[0].values,[3,1]);
});

test('Chart builder detects date columns and can infer Buyer / quantity defaults', () => {
  assert.ok(chart.detectDateHeaders(headers,rows).includes('Model Bütçe Tarihi'));
  const inferred=chart.inferState(headers,rows,{enabled:false});
  assert.equal(inferred.timeField,'Model Bütçe Tarihi');
  assert.equal(inferred.metricField,'Adet');
  assert.equal(inferred.aggregation,'sum');
  assert.equal(inferred.seriesField,'Buyer');
});

test('Backlog page exposes chart toolbar control, panel, styles and module', () => {
  const section=INDEX.slice(INDEX.indexOf('<section id="view-backlog">'),INDEX.indexOf('<section id="view-automations">'));
  assert.match(section,/id="backlogChartBtn"/);
  assert.match(section,/id="backlogChartPanel"/);
  assert.match(INDEX,/src="date-dimension\.js\?v=__BL_ASSET_VERSION__/);
  assert.match(INDEX,/src="backlog-chart\.js\?v=__BL_ASSET_VERSION__/);
  assert.match(CSS,/\.backlogChartPanel/);
  assert.match(CSS,/\.backlogChartSettingsGrid/);
  assert.match(CSS,/\.backlogChartTradingToolbar/);
  assert.match(CSS,/\.backlogChartViewport/);
  assert.match(CSS,/\.backlogChartPanLayer/);
  assert.match(CSS,/\.backlogChartSubtotalLine/);
  assert.match(CSS,/\.backlogChartCrosshair/);
  assert.match(CSS,/\.backlogChartLegendItem/);
  assert.match(CSS,/\.backlogChartTodayLine/);
  const chartSource=fs.readFileSync(path.join(ROOT,'public','backlog-chart.js'),'utf8');
  assert.match(chartSource,/data-backlog-chart-filter/);
  assert.match(chartSource,/data-backlog-chart-range/);
  assert.match(chartSource,/data-backlog-chart-crosshair/);
  assert.match(chartSource,/data-backlog-chart-legend-name/);
  assert.match(chartSource,/addEventListener\('wheel'/);
  assert.match(chartSource,/addEventListener\('pointerdown'/);
  assert.match(chartSource,/addEventListener\('pointermove'/);
  assert.match(chartSource,/addEventListener\('dblclick'/);
  assert.match(chartSource,/data-backlog-chart-today/);
  assert.match(chartSource,/data-backlog-chart-average/);
  assert.match(chartSource,/data-backlog-chart-subtotal/);
  assert.match(chartSource,/data-backlog-chart-pan-layer/);
  assert.doesNotMatch(chartSource,/svg\.style\.transform='translate3d/);
  assert.match(chartSource,/data-backlog-chart-export="svg"/);
  assert.match(chartSource,/data-backlog-chart-export="png"/);
  assert.match(chartSource,/timeField2/);
  assert.match(chartSource,/backlogChartTooltipTotal/);
  assert.match(chartSource,/tooltip\?\.addEventListener\('wheel'/);
  assert.match(CSS,/\.backlogChartTooltip\{[^}]*pointer-events:auto/);
});

test('Backlog render refreshes chart and Excel export appends chart sheets', () => {
  assert.match(APP,/window\.BLBacklogChart\?\.onBacklogRendered\?\.\(data\)/);
  assert.match(APP,/window\.BLBacklogChartContext=/);
  assert.match(APP,/prepareQuery:\(\)=>fetchBacklogSourceColumns\(\)/);
  assert.match(APP,/appendWorkbookSheets\?\.\(/);
  assert.match(APP,/const chartSpecs=chartExport&&Array\.isArray\(chartExport\.charts\)\?chartExport\.charts:\[\]/);
  assert.match(APP,/charts:chartSpecs/);
  assert.match(APP,/window\.BLBacklogChart\.applyExcelCharts\(patched,charts,JSZip,'blob'\)/);
  assert.match(APP,/backlogExpandDateDimensions\(exportHeaders,data\.rows\|\|\[\]\)/);
  assert.match(APP,/viewRange:window\.BLBacklogChart\?\.getViewRange\?\.\(\)/);
  assert.match(APP,/liveSource:detailSheet\.__backlogChartLiveSource/);
  assert.match(APP,/_BL_CHART_BUCKET1/);
});

test('Excel chart export keeps the selected visible time range and whole-number axis', () => {
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['BACKLOG']]),'BACKLOG');
  const result=chart.appendWorkbookSheets(wb,rows,headers,{XLSX,state:state({showAverage:true}),viewRange:{start:1,end:2}});
  assert.equal(result.model.categories.length,1);
  assert.deepEqual(result.viewRange,{start:1,end:2});
  const data=wb.Sheets[result.dataSheetName];
  assert.equal(data['!ref'],'A1:F2');
  const generated=chart.chartXml(result.charts[0],0);
  assert.match(generated,/formatCode="#,##0"/);
  assert.doesNotMatch(generated,/formatCode="#,##0\.00"/);
  assert.match(generated,/<c:majorUnit val="/);
});

test('Excel chart data stays live against the exported BACKLOG sheet', () => {
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['BACKLOG']]),'BACKLOG');
  const liveSource={sheetName:'BACKLOG',firstRow:2,lastRow:5,bucket1Col:'AZ',metricCol:'BA',seriesCol:'BB'};
  const result=chart.appendWorkbookSheets(wb,rows,headers,{XLSX,state:state(),liveSource,viewRange:{start:0,end:2}});
  assert.equal(result.live,true);
  const data=wb.Sheets[result.dataSheetName];
  assert.match(data.C2.f,/SUMIFS\('BACKLOG'!\$BA\$2:\$BA\$5,'BACKLOG'!\$AZ\$2:\$AZ\$5,\$B2,'BACKLOG'!\$BB\$2:\$BB\$5,"A"\)/);
  assert.match(data.D2.f,/SUMIFS\(/);
  assert.match(data.E2.f,/SUM\(C2:D2\)/);
  assert.equal(data.B2.v,result.model.categories[0].key);
});

test('Excel live chart uses the second time-field bucket for overlay series', () => {
  const overlayHeaders=[...headers,'Retail Tarihi'];
  const overlayRows=rows.map((row,index)=>({...row,'Retail Tarihi':['07.09.2026','08.09.2026','09.09.2026','15.09.2026'][index]}));
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['BACKLOG']]),'BACKLOG');
  const result=chart.appendWorkbookSheets(wb,overlayRows,overlayHeaders,{
    XLSX,
    state:state({timeField2:'Retail Tarihi'}),
    liveSource:{sheetName:'BACKLOG',firstRow:2,lastRow:5,bucket1Col:'AZ',bucket2Col:'AY',metricCol:'BA',seriesCol:'BB'},
  });
  const data=wb.Sheets[result.dataSheetName];
  const overlayColumnIndex=result.model.series.findIndex(item=>item.timeFieldIndex===2);
  assert.ok(overlayColumnIndex>=0);
  const cell=XLSX.utils.encode_cell({r:1,c:2+overlayColumnIndex});
  assert.match(data[cell].f,/'BACKLOG'!\$AY\$2:\$AY\$5/);
});

test('Excel export creates Grafik and Grafik Verisi sheets with native chart formulas', () => {
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['BACKLOG']]),'BACKLOG');
  const result=chart.appendWorkbookSheets(wb,rows,headers,{XLSX,state:state()});
  assert.ok(result);
  assert.ok(wb.SheetNames.includes('Grafik'));
  assert.ok(wb.SheetNames.includes('Grafik Verisi'));
  assert.equal(result.charts.length,1);
  assert.match(result.charts[0].categoriesFormula,/'Grafik Verisi'!\$A\$2:\$A\$3/);
  assert.equal(result.charts[0].series.length,2);
  const generated=chart.chartXml(result.charts[0],0);
  assert.match(generated,/<c:lineChart>/);
  assert.match(generated,/<c:strRef><c:f>&apos;Grafik Verisi&apos;!\$A\$2:\$A\$3<\/c:f>/);
  assert.match(generated,/<c:numRef>/);
});

test('native Excel chart package contains drawing relationships and reopens as XLSX', async () => {
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['BACKLOG'],['sample']]),'BACKLOG');
  const result=chart.appendWorkbookSheets(wb,rows,headers,{XLSX,state:state()});
  const raw=XLSX.write(wb,{type:'buffer',bookType:'xlsx',cellStyles:true});
  const patched=await chart.applyExcelCharts(raw,result.charts,JSZip,'nodebuffer');
  const zip=await JSZip.loadAsync(patched);
  assert.ok(zip.file('xl/charts/chart1.xml'));
  assert.ok(zip.file('xl/drawings/drawing1.xml'));
  assert.ok(zip.file('xl/drawings/_rels/drawing1.xml.rels'));
  const sheet=await zip.file(result.charts[0].sheetPath).async('string');
  assert.match(sheet,/<drawing r:id="rId\d+"\/>/);
  const relPath=result.charts[0].sheetPath.replace(/\/[^/]+$/, '/_rels/'+result.charts[0].sheetPath.split('/').pop()+'.rels');
  const rels=await zip.file(relPath).async('string');
  assert.match(rels,/relationships\/drawing/);
  const chartXml=await zip.file('xl/charts/chart1.xml').async('string');
  assert.match(chartXml,/<c:lineChart>/);
  assert.match(chartXml,/Grafik Verisi/);
  const reopened=XLSX.read(patched,{type:'buffer'});
  assert.ok(reopened.SheetNames.includes('Grafik'));
  assert.ok(reopened.SheetNames.includes('Grafik Verisi'));
});


test('Backlog chart uses compact k axis labels in app and Excel', () => {
  assert.equal(chart.formatAxisValue(30000),'30k');
  assert.equal(chart.formatAxisValue(150000),'150k');
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['BACKLOG']]),'BACKLOG');
  const result=chart.appendWorkbookSheets(wb,rows,headers,{XLSX,state:state(),viewRange:{start:0,end:2}});
  assert.match(chart.chartXml(result.charts[0],0),/formatCode="0,&quot;k&quot;"/);
});
