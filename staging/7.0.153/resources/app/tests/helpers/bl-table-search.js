'use strict';

/* Ortak tablo araması (window.BLTableSearch) app-main.js içinde tanımlanır ve
 * lazy yüklenen modüller (oab.js, lfl.js, quotations.js) onu global üzerinden
 * okur. Tarayıcıda sıra güvenlidir — app-main.js eager, o modüller UI_READY
 * sonrası yüklenir — ama sahte bir window ile çalışan testlerde bu global
 * kurulmuş olmaz ve modül yüklenirken patlar.
 *
 * Burada STUB üretmiyoruz: fonksiyonlar app-main.js'ten olduğu gibi çıkarılır,
 * böylece test gerçek üretim davranışını doğrular ve app-main.js'teki bir
 * değişiklik testlere yansır.
 */
const fs = require('node:fs');
const path = require('node:path');

const APP_MAIN = path.join(__dirname, '..', '..', 'public', 'app-main.js');

function extract(source, name) {
  const match = source.match(new RegExp(`\\nfunction ${name}\\([^)]*\\)\\{[^]*?\\n\\}`));
  if (!match) throw new Error(`app-main.js içinde ${name} bulunamadı; yardımcı güncellenmeli.`);
  return match[0];
}

function createTableSearch() {
  const source = fs.readFileSync(APP_MAIN, 'utf8');
  return Function(`
    const norm = value => String(value == null ? '' : value).trim();
    ${extract(source, 'parseTableSearchTerms')}
    ${extract(source, 'tableSearchMatches')}
    return { parseTerms: parseTableSearchTerms, matches: tableSearchMatches };
  `)();
}

module.exports = { createTableSearch };
