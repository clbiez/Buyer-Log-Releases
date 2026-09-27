'use strict';

/* Sunucu kaynak sözleşmesi testleri için tek okuma noktası.
   Route grupları server.js'ten server/routes/*.js modüllerine taşındıkça,
   "bu uç şu yetkiyle korunur" türü sözleşmeler kodun hangi dosyada
   durduğundan bağımsız kalmalı. Her modülün gövdesi, server.js'teki
   require('./routes/x')(app, {...}); kayıt çağrısının yerine satır içi
   yerleştirilir; böylece metin sırası (indexOf/slice kullanan testler)
   taşımadan önceki server.js ile aynı kalır. Kayıt çağrısı bulunamayan
   modül sona eklenir (hiçbir kaynak sessizce kaybolmaz). */
const fs = require('node:fs');
const path = require('node:path');

const SERVER_ROOT = path.join(__dirname, '..', '..', 'server');
const REGISTRATION_RE = /^require\('\.\/routes\/([\w-]+)'\)\(app, \{[\s\S]*?\n\}\);$/gm;

function moduleBody(source) {
  // Başlık + deps destructure atlanır; taşınan gövde birebir döner.
  const start = source.search(/^ *\} = deps;\n/m);
  let body = start >= 0 ? source.slice(source.indexOf('\n', start) + 1) : source;
  body = body.replace(/^ {2}const get\w+ = deps\.get\w+;\n/gm, '');
  return body.replace(/\n\};\s*$/, '\n');
}

module.exports = function readServerSource() {
  const server = fs.readFileSync(path.join(SERVER_ROOT, 'server.js'), 'utf8');
  const routesDir = path.join(SERVER_ROOT, 'routes');
  const modules = new Map();
  if (fs.existsSync(routesDir)) {
    for (const name of fs.readdirSync(routesDir).filter(file => file.endsWith('.js')).sort()) {
      modules.set(name.replace(/\.js$/, ''), fs.readFileSync(path.join(routesDir, name), 'utf8'));
    }
  }
  const inlined = new Set();
  const merged = server.replace(REGISTRATION_RE, (call, name) => {
    if (!modules.has(name)) return call;
    inlined.add(name);
    return moduleBody(modules.get(name)).replace(/\n$/, '');
  });
  const rest = [...modules].filter(([name]) => !inlined.has(name)).map(([, source]) => source);
  return [merged, ...rest].join('\n');
};
