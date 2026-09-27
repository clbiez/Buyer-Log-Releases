'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(ROOT, 'public', name), 'utf8');
const JS = read('lfl.js');
const CSS = read('lfl.css');
const HTML = read('index.html');

test('LFL comparison ve manufacturer panellerinde yatay yükseklik ayırıcıları bulunur', () => {
  assert.match(HTML, /id="lflGroupHeightHandle"[^>]*aria-orientation="horizontal"/);
  assert.match(HTML, /id="lflManufacturerHeightHandle"[^>]*aria-orientation="horizontal"/);
  assert.match(HTML, /lflAnalysisResizableCard/);
});

test('LFL analiz tabloları manuel yükseklik yokken ekrana doğru gereksiz uzamaz', () => {
  assert.match(CSS, /\.lflAnalysisGrid \.lflTableWrap:not\(\.lflManualHeight\)\{[^}]*height:auto!important;[^}]*max-height:clamp\(220px,34vh,360px\)!important/s);
  assert.match(CSS, /\.lflAnalysisGrid>\.lflAnalysisResizableCard\{[^}]*align-self:start[^}]*height:auto/s);
});

test('LFL tablo yükseklikleri kullanıcı bazında kalıcıdır ve sıfırlanabilir', () => {
  assert.match(JS, /ANALYSIS_HEIGHTS_KEY='lcw\.lfl\.analysisHeights\.v1'/);
  assert.match(JS, /function initAnalysisHeightResizers\(\)/);
  assert.match(JS, /BLStorage\.setItem\(ANALYSIS_HEIGHTS_KEY,JSON\.stringify\(saved\)\)/);
  assert.match(JS, /event\.key==='Home'/);
  assert.match(JS, /handle\.addEventListener\('dblclick'/);
  assert.match(JS, /initAnalysisHeightResizers\(\);/);
});


test('LFL manuel yükseklik içerik azaldığında tabloyu pencere altına zorlamaz', () => {
  assert.match(CSS, /\.lflAnalysisGrid \.lflTableWrap\.lflManualHeight\{[^}]*height:auto!important;[^}]*max-height:var\(--lfl-manual-height\)!important;[^}]*min-height:0;/s);
  assert.doesNotMatch(CSS, /\.lflAnalysisGrid \.lflTableWrap\.lflManualHeight\{[^}]*height:var\(--lfl-manual-height\)!important/s);
});
