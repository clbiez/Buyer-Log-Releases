'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function checkedPath(root,relative){
  if(typeof relative!=='string'||!relative||relative.includes('\\')||relative.split('/').some(p=>!p||p==='.'||p==='..')||path.isAbsolute(relative))throw Error('Unsafe relative path');
  let current=root;
  for(const part of relative.split('/')){current=path.join(current,part);const info=fs.lstatSync(current);if(info.isSymbolicLink())throw Error('Symbolic links are not supported');}
  return current;
}
function prepare(installRoot,folder=__dirname){
  const root=path.resolve(installRoot),pin=JSON.parse(fs.readFileSync(path.join(folder,'recovery-base.json'),'utf8'));
  if(fs.lstatSync(root).isSymbolicLink()||!fs.statSync(path.join(root,'BuyerLog.exe')).isFile())throw Error('BuyerLog.exe installation folder required');
  let core=path.join(root,'resources/app');
  const pointer=path.join(root,'data/local/updater/current.json');
  if(fs.existsSync(pointer)){
    const current=JSON.parse(fs.readFileSync(pointer,'utf8'));
    if(current.version!==pin.version||typeof current.appCoreRoot!=='string')throw Error('Installed version does not match '+pin.version);
    core=path.resolve(current.appCoreRoot);
  }
  const relative=path.relative(root,core);
  if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('Application core must be inside the installation');
  checkedPath(root,relative.split(path.sep).join('/'));
  if(JSON.parse(fs.readFileSync(path.join(core,'package.json'),'utf8')).version!==pin.version)throw Error('This recovery is only for '+pin.version);
  // Pin the protected installed verifier before requiring any installed code.
  // These identities come from the independently signature/SHA-verified full release.
  for(const file of pin.verifierFiles){const bytes=fs.readFileSync(checkedPath(core,file.path));if(bytes.length!==file.size||sha(bytes)!==file.sha256)throw Error('Installed verifier mismatch: '+file.path);}
  const F=require(path.join(core,'electron/manual-patch/files.js'));
  const anchor=F.readBootstrap(core);
  if(anchor.sourceCommit!==pin.sourceCommit)throw Error('Unexpected full installation source');
  require(path.join(core,'electron/manual-patch/core-verification.js')).verifyPackagedCore(core,pin.version);
  const manifest=F.readJsonStrict(path.join(folder,pin.patchManifest));
  const manager=require(path.join(core,'electron/manual-patch/manager.js')).createInstalledManager({bootstrapCore:path.join(root,'resources/app'),trustRoot:core,portableRoot:root});
  const preview=manager.preview(manifest);
  console.log('Verified publisher signature / Yayinci imzasi dogrulandi: '+preview.baseVersion+' #'+preview.sequence);
  fs.mkdirSync(path.join(root,'.buyerlog-versions'),{recursive:true});
  const result=manager.apply(manifest,path.join(folder,manifest.artifact.name));
  if(!result.ok)throw Error('Patch was not prepared');
  console.log('Patch staged by the installed signed-patch manager / Imzali yama hazirlandi.');
  console.log('Start BuyerLog.exe normally / BuyerLog.exe uygulamasini normal acin.');
  return result;
}
if(require.main===module){try{if(process.argv.length!==3)throw Error('Installation folder required');prepare(process.argv[2]);}catch(error){console.error('DURDURULDU / STOPPED: '+(error.code?error.code+' - ':'')+error.message);process.exitCode=1;}}
module.exports={prepare};
