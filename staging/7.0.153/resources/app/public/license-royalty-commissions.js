/* Buyer Log — License Royalty v2
   Tek sözleşme kaydı: Royalty + TR Komisyon + YD Komisyon + Hologram Cost.
   Eski TR / Non-TR satırları BLBusinessRules.migrateLicenseRoyaltyRules ile
   efektif fiyatları kaybetmeden birleştirilir. */
(function installLicenseRoyaltyCommissionModel(){
  const api=window.BLBusinessRules;
  if(!api||typeof api.migrateLicenseRoyaltyRules!=='function')return;

  function optionalPercent(value){
    if(value==null||String(value).trim()==='')return null;
    const n=Number(String(value).replace(',','.'));return Number.isFinite(n)?n:null;
  }
  function optionalMoney(value){
    if(value==null||String(value).trim()==='')return null;
    const n=Number(String(value).replace(',','.'));return Number.isFinite(n)?n:null;
  }
  function commission(rule,country){return api.pricingRuleCommissionForCountry(rule,country);}
  function effectiveRoyalty(rule,country){return api.pricingRuleEffectiveRoyalty(rule,country);}
  function hologramFor(rule,country){return api.pricingRuleHologramForCountry(rule,country);}
  function hasSide(rule,country){return commission(rule,country)!=null;}
  function pct(value){return value==null?'—':Number(value).toLocaleString('tr-TR',{maximumFractionDigits:3})+'%';}
  function money(value){return value==null?'—':Number(value).toLocaleString('tr-TR',{minimumFractionDigits:0,maximumFractionDigits:3});}

  normalizePricingRules=function(rules){
    const migrated=api.migrateLicenseRoyaltyRules(Array.isArray(rules)?rules:[]);
    const out=[],seen=new Set();
    migrated.forEach((r,i)=>{
      const opdStart=normalizePricingRuleDate(r&&r.opdStart),opdEnd=normalizePricingRuleDate(r&&r.opdEnd);
      const seasons=normalizePricingRuleSeasons((r&&r.seasons)!=null?r.seasons:(r&&r.season));
      const licensor=norm(r&&r.licensor)||norm(r&&r.manufacturer),license=norm(r&&r.license);
      const royalty=Number(r&&r.royalty),trCommission=optionalPercent(r&&r.trCommission),ydCommission=optionalPercent(r&&r.ydCommission),hologramCost=Number(r&&r.hologramCost);
      if(opdStart&&opdEnd&&dateOrdinal(opdStart)>dateOrdinal(opdEnd))return;
      if(!licensor||!license||!Number.isFinite(royalty)||royalty<0||royalty>100||!Number.isFinite(hologramCost)||hologramCost<0)return;
      if(trCommission==null&&ydCommission==null)return;
      if((trCommission!=null&&(trCommission<0||trCommission>100||royalty+trCommission>100))||(ydCommission!=null&&(ydCommission<0||ydCommission>100||royalty+ydCommission>100)))return;
      const key=[opdStart,opdEnd,seasons.map(turknorm).join('~'),turknorm(licensor),turknorm(license),trCommission==null?'':'TR',ydCommission==null?'':'YD'].join('|');
      if(seen.has(key))return;seen.add(key);
      const item={id:String((r&&r.id)||('rule-'+Date.now()+'-'+i)),opdStart,opdEnd,seasons,licensor,license,royalty,trCommission,ydCommission,hologramCost};
      const legacyTr=optionalMoney(r&&r.legacyTrHologramCost),legacyYd=optionalMoney(r&&r.legacyYdHologramCost);
      if(legacyTr!=null)item.legacyTrHologramCost=legacyTr;
      if(legacyYd!=null)item.legacyYdHologramCost=legacyYd;
      if(Array.isArray(r&&r.legacyRuleIds)&&r.legacyRuleIds.length)item.legacyRuleIds=r.legacyRuleIds.map(String).filter(Boolean);
      if(r&&r.migratedFromCountrySplit===true)item.migratedFromCountrySplit=true;
      out.push(item);
    });
    out.sort((a,b)=>{
      const a1=dateOrdinal(a.opdStart),b1=dateOrdinal(b.opdStart),a2=dateOrdinal(a.opdEnd),b2=dateOrdinal(b.opdEnd);
      return (a1==null?-Infinity:a1)-(b1==null?-Infinity:b1)||(a2==null?Infinity:a2)-(b2==null?Infinity:b2)||pricingRuleSeasonLabel(a).localeCompare(pricingRuleSeasonLabel(b),'tr')||a.licensor.localeCompare(b.licensor,'tr')||a.license.localeCompare(b.license,'tr');
    });
    return out;
  };

  pricingRuleMatchesValues=function(rule,opd,country,season,licensor,license){
    const day=dateOrdinal(opd),start=dateOrdinal(rule&&rule.opdStart),end=dateOrdinal(rule&&rule.opdEnd);
    const dateMatches=(start==null&&end==null)||(day!=null&&(start==null||day>=start)&&(end==null||day<=end));
    return dateMatches&&pricingRuleSeasonMatches(rule,season)&&hasSide(rule,country)&&turknorm(licensor)===turknorm(rule&&rule.licensor)&&turknorm(license)===turknorm(rule&&rule.license);
  };
  pricingRuleMatchesRow=function(rule,row){return !!row&&pricingRuleMatchesValues(rule,row.OPD,row.Country,row.Season,row.Licensor,row.License);};
  findSuppFobRule=function(opd,country,season,licensor,license){return (state.overrides.pricingRules||[]).find(r=>pricingRuleMatchesValues(r,opd,country,season,licensor,license))||null;};
  pricingRulesOverlap=function(a,b){
    if(turknorm(a&&a.licensor)!==turknorm(b&&b.licensor)||turknorm(a&&a.license)!==turknorm(b&&b.license)||!pricingRuleSeasonSetsOverlap(a,b))return false;
    if(!((hasSide(a,'TR')&&hasSide(b,'TR'))||(hasSide(a,'YD')&&hasSide(b,'YD'))))return false;
    const a1=dateOrdinal(a.opdStart),a2=dateOrdinal(a.opdEnd),b1=dateOrdinal(b.opdStart),b2=dateOrdinal(b.opdEnd);
    return (a1==null?-Infinity:a1)<=(b2==null?Infinity:b2)&&(b1==null?-Infinity:b1)<=(a2==null?Infinity:a2);
  };
  pricingRulesSameCondition=function(a,b){
    const aa=normalizePricingRuleSeasons((a&&a.seasons)!=null?a.seasons:(a&&a.season)).map(turknorm).join('|');
    const bb=normalizePricingRuleSeasons((b&&b.seasons)!=null?b.seasons:(b&&b.season)).map(turknorm).join('|');
    return normalizePricingRuleDate(a&&a.opdStart)===normalizePricingRuleDate(b&&b.opdStart)&&normalizePricingRuleDate(a&&a.opdEnd)===normalizePricingRuleDate(b&&b.opdEnd)&&aa===bb&&turknorm(a&&a.licensor)===turknorm(b&&b.licensor)&&turknorm(a&&a.license)===turknorm(b&&b.license)&&((hasSide(a,'TR')&&hasSide(b,'TR'))||(hasSide(a,'YD')&&hasSide(b,'YD')));
  };

  normalizeSuppFobMeta=function(meta){
    if(!meta||typeof meta!=='object')return null;
    const out={source:meta.source==='rule'?'rule':'manual'};
    if(meta.ruleId!=null)out.ruleId=String(meta.ruleId);
    ['opdStart','opdEnd','licensor','license','commissionGroup'].forEach(k=>{if(meta[k]!=null&&norm(meta[k]))out[k]=norm(meta[k]);});
    if(!out.licensor&&meta.manufacturer!=null&&norm(meta.manufacturer))out.licensor=norm(meta.manufacturer);
    const seasons=normalizePricingRuleSeasons(meta.seasons!=null?meta.seasons:meta.season);if(seasons.length)out.seasons=seasons;
    ['royalty','trCommission','ydCommission','commission','effectiveRoyalty','hologramCost'].forEach(k=>{if(meta[k]!=null&&String(meta[k]).trim()!==''){const n=Number(meta[k]);if(Number.isFinite(n))out[k]=n;}});
    if(meta.applied===true)out.applied=true;
    return out;
  };
  automaticSuppFobRuleMeta=function(rule,applied,country){
    if(!rule)return null;
    const group=api.pricingRuleCountryGroup(country),countryCommission=commission(rule,group),total=effectiveRoyalty(rule,group),hologram=hologramFor(rule,group);
    return {source:'rule',ruleId:String(rule.id||''),opdStart:rule.opdStart||'',opdEnd:rule.opdEnd||'',seasons:normalizePricingRuleSeasons(rule.seasons!=null?rule.seasons:rule.season),licensor:rule.licensor,license:rule.license,royalty:Number(rule.royalty),trCommission:rule.trCommission,ydCommission:rule.ydCommission,commissionGroup:group,commission:countryCommission,effectiveRoyalty:total,hologramCost:hologram,applied:applied===true};
  };
  calculateSuppFobWithRule=function(fob,rule,country){return api.calculateSuppFobWithRule(fob,rule,country);};
  calculateSuppFobFromRule=function(fob,opd,country,season,licensor,license){
    const rule=findSuppFobRule(opd,country,season,licensor,license);if(!rule)return {value:null,rule:null};
    return {value:calculateSuppFobWithRule(fob,rule,country),rule};
  };
  recalcSuppFobForRow=function(row){
    if(!row||hasManualSuppFob(row))return false;
    const prev=row['Supp. FOB'],priced=calculateSuppFobFromRule(row['FOB ($)'],row.OPD,row.Country,row.Season,row.Licensor,row.License);
    const next=priced.value!=null?priced.value:(turknorm(row.Licensor)==='DTR'?(toNum(row['FOB ($)'])??null):null);
    row['Supp. FOB']=next;row._suppFobRule=priced.rule?(priced.rule.id||true):null;row._suppFobMeta=automaticSuppFobRuleMeta(priced.rule,false,row.Country);row._suppFobOverride=false;row._suppFobManual=false;
    return !editableValuesEqual(prev,next);
  };
  suppFobHoverText=function(row){
    if(!row||turknorm(row.Licensor)==='DTR'||row['Supp. FOB']==null||row['Supp. FOB']==='')return '';
    const meta=suppFobMetaForRow(row),currentRule=findSuppFobRule(row.OPD,row.Country,row.Season,row.Licensor,row.License),rule=currentRule||(meta&&meta.source==='rule'?meta:null);
    const automatic=isSuppFobAutoCalculated(row),group=api.pricingRuleCountryGroup(row.Country),countryCommission=rule?commission(rule,group):null,total=rule?effectiveRoyalty(rule,group):null,hologram=rule?hologramFor(rule,group):null;
    const lines=[automatic?(meta&&meta.applied?'Otomatik hesaplandı (Apply)':'Otomatik hesaplandı'):'Elle girildi'];
    if(rule)lines.push('OPD: '+pricingRuleDateRangeLabel(rule),'Sezon: '+pricingRuleSeasonLabel(rule));
    if(rule&&Number.isFinite(Number(rule.royalty)))lines.push('Royalty: %'+Number(rule.royalty).toLocaleString('tr-TR',{maximumFractionDigits:3}));
    if(countryCommission!=null)lines.push((group==='TR'?'TR':'YD')+' komisyon: %'+Number(countryCommission).toLocaleString('tr-TR',{maximumFractionDigits:3}));
    if(total!=null)lines.push('Toplam: %'+Number(total).toLocaleString('tr-TR',{maximumFractionDigits:3}));
    if(hologram!=null&&Number(hologram)!==0)lines.push('Hologram maliyeti: '+money(hologram));
    return lines.join(' • ');
  };

  applySuppFobRuleToMatchingOrders=async function(rule){
    commitActiveTableEditor({refresh:false});
    const matches=(state.cp&&state.cp.rows||[]).filter(r=>pricingRuleMatchesRow(rule,r)),updates=[],seen=new Set();
    matches.forEach(r=>{
      const oc=r['Order Code'],lineKey=lineKeyOfRow(r)||String(oc);
      if(oc==null||seen.has(lineKey))return;
      const value=calculateSuppFobWithRule(r['FOB ($)'],rule,r.Country);
      if(value==null||!Number.isFinite(value))return;
      seen.add(lineKey);updates.push({orderCode:oc,...lineIdentity(r),lineKey,suppFob:value,suppFobMeta:automaticSuppFobRuleMeta(rule,true,r.Country)});
    });
    if(!updates.length){showToast('Bu kuralla eşleşen ve geçerli FOB değeri bulunan sipariş yok.');return 0;}
    if(window.SERVER_BACKED)await enqueueOverrideMutation('suppFob','/api/overrides/batch-suppfob',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items:updates})});
    updates.forEach(({orderCode,lineKey,suppFob,suppFobMeta})=>{
      const meta=normalizeSuppFobMeta(suppFobMeta)||{source:'rule',applied:true},key=lineKey||orderCode;
      state.overrides.suppfobmap[key]=suppFob;state.overrides.suppfobmetamap=state.overrides.suppfobmetamap||{};state.overrides.suppfobmetamap[key]=meta;
      [state.cp&&state.cp.rows,state.orderSummary&&state.orderSummary.rows].forEach(rows=>(rows||[]).forEach(r=>{if((lineKeyOfRow(r)||String(r['Order Code']))===key){r['Supp. FOB']=suppFob;r._suppFobMeta=meta;r._suppFobOverride=true;r._suppFobManual=false;r._suppFobRule=meta.ruleId||true;}}));
    });
    if(!window.SERVER_BACKED)matches.forEach(r=>markDirty(r._id));
    if(state.cp)renderCP();if(state.orderSummary)renderOverview();return updates.length;
  };
  applyAllSuppFobRules=async function(rules){
    commitActiveTableEditor({refresh:false});
    const clean=normalizePricingRules(rules),updates=[],seen=new Set();
    (state.cp&&state.cp.rows||[]).forEach(r=>{
      const oc=r['Order Code'],lineKey=lineKeyOfRow(r)||String(oc);if(oc==null||seen.has(lineKey))return;
      const rule=clean.find(x=>pricingRuleMatchesRow(x,r));if(!rule)return;
      const value=calculateSuppFobWithRule(r['FOB ($)'],rule,r.Country);if(value==null||!Number.isFinite(value))return;
      seen.add(lineKey);updates.push({orderCode:oc,...lineIdentity(r),lineKey,suppFob:value,suppFobMeta:automaticSuppFobRuleMeta(rule,true,r.Country)});
    });
    if(!updates.length){showToast('Kurallarla eşleşen ve geçerli FOB değeri bulunan sipariş yok.');return 0;}
    if(window.SERVER_BACKED)await enqueueOverrideMutation('suppFob','/api/overrides/batch-suppfob',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items:updates})});
    updates.forEach(({orderCode,lineKey,suppFob,suppFobMeta})=>{
      const meta=normalizeSuppFobMeta(suppFobMeta)||{source:'rule',applied:true},key=lineKey||orderCode;
      state.overrides.suppfobmap[key]=suppFob;state.overrides.suppfobmetamap=state.overrides.suppfobmetamap||{};state.overrides.suppfobmetamap[key]=meta;
      [state.cp&&state.cp.rows,state.orderSummary&&state.orderSummary.rows].forEach(rows=>(rows||[]).forEach(r=>{if((lineKeyOfRow(r)||String(r['Order Code']))===key){r['Supp. FOB']=suppFob;r._suppFobMeta=meta;r._suppFobOverride=true;r._suppFobManual=false;r._suppFobRule=meta.ruleId||true;}}));
    });
    if(!window.SERVER_BACKED)(state.cp&&state.cp.rows||[]).forEach(r=>{if(seen.has(lineKeyOfRow(r)||String(r['Order Code'])))markDirty(r._id);});
    if(state.cp)renderCP();if(state.orderSummary)renderOverview();return updates.length;
  };

  kolPricingRuleDimensionMatches=function(rule,ctx){
    return pricingRuleSeasonMatches(rule,ctx.season)&&turknorm(ctx.licensor)===turknorm(rule&&rule.licensor)&&turknorm(ctx.license)===turknorm(rule&&rule.license);
  };
  kolFindPricingRuleForCountryGroup=function(row,countryGroup){
    const ctx=kolPricingRuleContext(row),group=api.pricingRuleCountryGroup(countryGroup);
    if(!group||!ctx.licensor||!ctx.license)return null;
    const candidates=(state.overrides.pricingRules||[]).filter(rule=>kolPricingRuleDimensionMatches(rule,ctx)&&hasSide(rule,group));
    if(!candidates.length)return null;
    return [...candidates].sort((a,b)=>{const af=kolPricingRuleFreshness(a),bf=kolPricingRuleFreshness(b);return bf.start-af.start||bf.end-af.end||String(b.id||'').localeCompare(String(a.id||''),'tr');})[0]||null;
  };
  kolFindPricingRule=function(row){
    const ctx=kolPricingRuleContext(row);if(!ctx.country||!ctx.licensor||!ctx.license)return null;
    return kolFindPricingRuleForCountryGroup(row,ctx.country);
  };
  kolTrLicenseRuleMissingText=function(row){
    const unresolved=kolLicensorUnresolvedState(row);if(unresolved)return licenseLicensorWarningText(unresolved);
    const ctx=kolPricingRuleContext(row),missing=[];if(!ctx.license)missing.push('License');if(!ctx.licensor)missing.push('Licensor');
    if(missing.length)return appLang==='en'?('TR royalty cannot be resolved: '+missing.join(', ')+' is empty. TR Landed is not calculated.'):('TR Royalty çözülemiyor: bu satırda '+missing.join(', ')+' boş. TR Landed hesaplanmadı.');
    return appLang==='en'?'The matching License Royalty contract has no TR commission. TR Landed is not calculated — define TR Commission under License Royalty Calculations.':'Eşleşen License Royalty sözleşmesinde TR Komisyon tanımlı değil. TR Landed hesaplanmadı — License Royalty Calculations altında TR Komisyon değerini tanımlayın.';
  };
  kolPricingRuleTitle=function(row){
    const rule=kolFindPricingRule(row);if(!rule)return L('Eşleşen CP fiyat kuralı bulunamadı');
    const ctx=kolPricingRuleContext(row),group=api.pricingRuleCountryGroup(ctx.country),countryCommission=commission(rule,group),total=effectiveRoyalty(rule,group);
    return `${L('License Royalty hesabından')} (${L('Koleksiyon için OPD dikkate alınmaz')}): ${pricingRuleDateRangeLabel(rule)} · ${pricingRuleSeasonLabel(rule)} · ${rule.licensor} · ${rule.license} · Royalty %${rule.royalty} + ${group==='TR'?'TR':'YD'} Kom. %${countryCommission??'—'} = %${total??'—'}`;
  };
  kolApplyRulePricing=function(row){
    if(!row)return false;
    const rule=kolFindPricingRule(row),country=kolPricingRuleContext(row).country,total=rule?effectiveRoyalty(rule,country):null,hologram=rule?hologramFor(rule,country):null;
    const royalty=total!=null?kolFormatPercentDisplay(String(total)):'',hologramDisplay=hologram!=null?kolFormatHologramDisplay(String(hologram)):'',fobSource=kolSuppFob(row);
    const ruleMissing=kolLicensorUnresolvedState(row)!=null||(kolLandedIsNonDtr(row)&&!rule),fob=(fobSource&&!ruleMissing)?kolComputeFobFromConfirmed(fobSource.price,royalty,hologramDisplay):'';
    let changed=false;
    if(!editableValuesEqual(row.royalty,royalty)){row.royalty=royalty;changed=true;}
    if(!editableValuesEqual(row.hologramCost,hologramDisplay)){row.hologramCost=hologramDisplay;changed=true;}
    if(!editableValuesEqual(row.fob,fob)){row.fob=fob;changed=true;}
    const ruleId=rule?String(rule.id||''):'';if(row._pricingRuleId!==ruleId){row._pricingRuleId=ruleId;changed=true;}
    if(Object.prototype.hasOwnProperty.call(row,'suppFob')){delete row.suppFob;changed=true;}
    return changed;
  };
  kolLandedPriceWithRule=function(basePrice,row,rule,countryGroup='TR'){
    const base=Number(basePrice);if(!Number.isFinite(base)||base<=0)return null;if(!kolLandedIsNonDtr(row))return base;if(!rule)return null;
    return api.calculateFinalFobWithRule(base,rule,countryGroup);
  };
  kolLandedCalc=function(row){
    const trPrice=kolParseMoneyNum(row&&row.trPrice),defaults=typeof kolDefaultLandedMultipliers==='function'?kolDefaultLandedMultipliers():{tr:KOL_TR_LANDED_MULT,overseas:KOL_YD_LANDED_MULT};
    const trMultRaw=kolParseMoneyNum(row&&row.trLandedMult),trMultIsManual=Number.isFinite(trMultRaw)&&trMultRaw>0,trMult=trMultIsManual?trMultRaw:defaults.tr;
    const fxManual=kolParseMoneyNum(row&&row.trFx),fxAuto=kolAutoFx(row),fx=Number.isFinite(fxManual)&&fxManual>0?fxManual:fxAuto,trBaseUsd=(Number.isFinite(trPrice)&&trPrice>0&&Number.isFinite(fx)&&fx>0)?trPrice/fx:null;
    const trRule=kolFindPricingRuleForCountryGroup(row,'TR'),trRuleMissing=kolTrLicenseRuleMissing(row),trCostedUsd=(trBaseUsd==null||trRuleMissing)?null:kolLandedPriceWithRule(trBaseUsd,row,trRule,'TR'),trLanded=trCostedUsd==null?null:trCostedUsd*trMult;
    const supp=kolSuppFob(row),ydBaseFob=supp?supp.price:null,ydCostedFob=ydBaseFob==null?null:kolLandedPriceWithCosts(ydBaseFob,row);
    const ydMultRaw=kolParseMoneyNum(row&&row.ydLandedMult),ydMultIsManual=Number.isFinite(ydMultRaw)&&ydMultRaw>0,ydMult=ydMultIsManual?ydMultRaw:defaults.overseas,ydLanded=ydCostedFob==null?null:ydCostedFob*ydMult;
    const nonDtr=kolLandedIsNonDtr(row),ruleMissing=kolLicenseRuleMissing(row),royaltyRaw=kolParseMoneyNum(row&&row.royalty),hologramRaw=kolParseMoneyNum(row&&row.hologramCost);
    const royaltyPct=Number.isFinite(royaltyRaw)&&royaltyRaw>0?royaltyRaw:0,hologramCost=Number.isFinite(hologramRaw)&&hologramRaw>0?hologramRaw:0;
    const trRoyaltyRaw=effectiveRoyalty(trRule,'TR'),trHologramRaw=hologramFor(trRule,'TR'),trRoyaltyPct=Number.isFinite(trRoyaltyRaw)&&trRoyaltyRaw>0?trRoyaltyRaw:0,trHologramCost=Number.isFinite(trHologramRaw)&&trHologramRaw>0?trHologramRaw:0;
    const profitPct=(trLanded!=null&&ydLanded!=null&&trLanded>0)?((trLanded-ydLanded)/trLanded)*100:null;
    return {trPrice,trMult,trMultIsManual,defaultTrMult:defaults.tr,fx,fxAuto,fxIsManual:Number.isFinite(fxManual)&&fxManual>0,trBaseUsd,trRule,trRuleMissing,trCostedUsd,trLanded,trRoyaltyPct,trHologramCost,supp,ydBaseFob,ydCostedFob,ydMult,ydMultIsManual,defaultYdMult:defaults.overseas,ydLanded,nonDtr,royaltyPct,hologramCost,profitPct,ruleMissing};
  };
  endeksmatikRoyaltyRule=function(mode,row){
    try{
      const rule=mode==='orders'?findSuppFobRule(row&&row.OPD,row&&row.Country,row&&row.Season,row&&row.Licensor,row&&row.License):kolFindPricingRule(row);
      if(!rule)return null;
      const country=mode==='orders'?(row&&row.Country):kolPricingRuleContext(row).country,total=effectiveRoyalty(rule,country),hologram=hologramFor(rule,country);
      if(!Number.isFinite(total)||total<0||total>=100||!Number.isFinite(hologram)||hologram<0)return null;
      return {license:rule.license||'',licensor:rule.licensor||'',royalty:total,hologramCost:hologram,baseRoyalty:Number(rule.royalty),commission:commission(rule,country)};
    }catch(_){return null;}
  };

  openSuppFobRulesModal=function(){
    commitActiveTableEditor({refresh:false});
    document.getElementById('_suppFobRulesModal')?.remove();
    let working=normalizePricingRules(state.overrides.pricingRules).map(r=>({...r,seasons:[...(r.seasons||[])]})),editingId=null,editingOriginal=null,selectedSeasons=new Set(),sort={key:'opdRange',dir:'asc'};
    const filters={opdRange:'',seasons:'',licensor:'',license:'',royalty:'',trCommission:'',ydCommission:'',hologramCost:'',matches:''};
    const cpRows=state.cp&&state.cp.rows||[],orderRows=overviewSummaryRows(),asasRows=state.asasOrders||[];
    const licensors=[...new Set(cpRows.map(r=>norm(r.Licensor)).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'tr')),licenses=[...new Set(cpRows.map(r=>norm(r.License)).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'tr'));
    const seasonOptions=[...new Set([...cpRows.map(r=>norm(r.Season)),...orderRows.map(r=>norm(r.Season)),...asasRows.map(r=>norm(r.season)),...working.flatMap(r=>r.seasons||[])].filter(Boolean))].sort((a,b)=>a.localeCompare(b,'tr'));
    const modal=document.createElement('div');modal.id='_suppFobRulesModal';modal.className='warnOverlay';
    modal.innerHTML=`<div class="modalCard" role="dialog" aria-modal="true" style="width:min(98vw,1480px);max-height:94vh;display:flex;flex-direction:column;padding:0;">
      <div style="padding:16px 20px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:16px"><div><div class="modalTitle">License Royalty Calculations</div><div style="margin-top:4px;color:var(--muted);font-size:11.5px">OPD + sezon + Licensor + License tek sözleşmedir. Royalty sabit; TR/YD komisyonu sipariş ülkesine göre eklenir.</div></div><button class="pricingRuleBtn ghost iconOnly _rulesClose"><svg class="ic"><use href="#i-x"/></svg></button></div>
      <div style="padding:16px 20px;overflow:auto;display:flex;flex-direction:column;gap:14px">
        <div class="pricingRuleFormula">Supp. FOB = (Final FOB − Hologram Cost) × (1 − (Royalty % + Ülke Komisyonu %)) <small>Eski TR / Non-TR kayıtları otomatik birleştirilir; efektif fiyatlar korunur.</small></div>
        <div class="pricingRuleCheck"><div class="pricingRuleCheckHead"><strong>Fiyat Kontrolü</strong><small>Bir alana yazın; Supp. FOB, Final FOB YD ve Final FOB TR birlikte çözülür.</small></div><div class="pricingRuleCheckGrid royaltyV2CheckGrid">
          <div class="pricingRuleField pricingRuleCheckRuleField"><label>Kural</label><input id="_ruleCheckSearch" type="search" placeholder="Kural ara…"><select id="_ruleCheckRule"></select></div>
          <div class="pricingRuleField"><label>Supp. FOB (USD)</label><input id="_ruleCheckSupp" inputmode="decimal" placeholder="1,00"></div><div class="pricingRuleField pricingRuleCheckArrow"><span>⇄</span></div>
          <div class="pricingRuleField"><label>Final FOB YD</label><input id="_ruleCheckFinalYd" inputmode="decimal"></div><div class="pricingRuleField"><label>Final FOB TR</label><input id="_ruleCheckFinalTr" inputmode="decimal"></div>
          <div class="pricingRuleField"><label>&nbsp;</label><button class="pricingRuleBtn ghost" id="_ruleCheckClear"><svg class="ic"><use href="#i-x"/></svg> Temizle</button></div>
        </div><div class="pricingRuleCheckOut" id="_ruleCheckOut"></div></div>
        <div class="pricingRuleGrid royaltyV2Grid">
          <div class="pricingRuleField"><label>OPD Başlangıç <span style="font-weight:400;color:var(--muted)">(boş = −∞)</span></label><input id="_ruleOpdStart" type="date"></div>
          <div class="pricingRuleField"><label>OPD Bitiş <span style="font-weight:400;color:var(--muted)">(boş = +∞)</span></label><input id="_ruleOpdEnd" type="date"></div>
          <div class="pricingRuleField"><label>Sezon</label><div class="pricingRuleSeasonPicker"><button type="button" class="pricingRuleSeasonBtn" id="_ruleSeasonBtn"><span>Tüm Sezonlar</span><span>▾</span></button><div class="pricingRuleSeasonPanel" id="_ruleSeasonPanel"></div></div></div>
          <div class="pricingRuleField"><label>Licensor</label><input id="_ruleLicensor" list="_ruleLicensorList"><datalist id="_ruleLicensorList">${licensors.map(v=>`<option value="${escapeHtml(v)}">`).join('')}</datalist></div>
          <div class="pricingRuleField"><label>License</label><input id="_ruleLicense" list="_ruleLicenseList"><datalist id="_ruleLicenseList">${licenses.map(v=>`<option value="${escapeHtml(v)}">`).join('')}</datalist></div>
          <div class="pricingRuleField"><label>Royalty %</label><input id="_ruleRoyalty" inputmode="decimal"></div><div class="pricingRuleField"><label>TR Komisyon %</label><input id="_ruleTrCommission" inputmode="decimal"></div>
          <div class="pricingRuleField"><label>YD Komisyon %</label><input id="_ruleYdCommission" inputmode="decimal"></div><div class="pricingRuleField"><label>Hologram Cost</label><input id="_ruleHologram" inputmode="decimal"></div>
        </div>
        <div class="pricingRuleFormActions"><button class="pricingRuleBtn ghost" id="_ruleFormClear"><svg class="ic"><use href="#i-x"/></svg> Formu Temizle</button><button class="pricingRuleBtn primary" id="_ruleAdd"><svg class="ic"><use href="#i-copy-plus"/></svg><span>Kural Ekle</span></button></div>
        <div class="pricingRulesTableWrap"><table class="pricingRulesTable royaltyV2Table"><thead><tr class="pricingRuleHeadRow">
          ${[['opdRange','OPD Aralığı'],['seasons','Sezon'],['licensor','Licensor'],['license','License'],['royalty','Royalty %'],['trCommission','TR Komisyon %'],['ydCommission','YD Komisyon %'],['hologramCost','Hologram'],['matches','Eşleşen']].map(([k,l])=>`<th><button class="pricingRuleSortBtn" data-sort="${k}"><span>${l}</span><span class="pricingRuleSortMark"></span></button></th>`).join('')}<th style="text-align:right;padding:0 8px">İşlemler</th></tr><tr class="pricingRuleFilterRow">
          ${[['opdRange','Tarih'],['seasons','Sezon'],['licensor','Licensor'],['license','License'],['royalty','Royalty'],['trCommission','TR Kom.'],['ydCommission','YD Kom.'],['hologramCost','Hologram'],['matches','Adet']].map(([k,l])=>`<th><input class="pricingRuleFilter" data-filter="${k}" placeholder="${l}"></th>`).join('')}<th><button class="pricingRuleBtn ghost pricingRuleFilterClear" id="_rulesClearFilters"><svg class="ic"><use href="#i-x"/></svg> Temizle</button></th></tr></thead><tbody id="_rulesBody"></tbody></table></div><div id="_rulesEmpty" style="display:none;padding:18px;text-align:center;color:var(--muted)">Henüz License Royalty hesabı eklenmedi.</div>
      </div>
      <div class="pricingRuleFooter"><span id="_rulesStatus" style="font-size:11.5px;color:var(--muted)"></span><span style="flex:1"></span><button class="pricingRuleBtn tonal" id="_rulesApplyAll"><svg class="ic"><use href="#i-refresh"/></svg> Tümüne Uygula</button><button class="pricingRuleBtn ghost _rulesClose">Vazgeç</button><button class="pricingRuleBtn primary" id="_rulesSave"><svg class="ic"><use href="#i-device-floppy"/></svg> Kuralları Kaydet</button></div>
    </div>`;
    document.body.appendChild(modal);
    const $=id=>modal.querySelector('#'+id),opdStart=$('_ruleOpdStart'),opdEnd=$('_ruleOpdEnd'),seasonBtn=$('_ruleSeasonBtn'),seasonPanel=$('_ruleSeasonPanel'),licensor=$('_ruleLicensor'),license=$('_ruleLicense'),royalty=$('_ruleRoyalty'),trCommission=$('_ruleTrCommission'),ydCommission=$('_ruleYdCommission'),hologram=$('_ruleHologram');
    function renderSeasonPicker(){const opts=[...new Set([...seasonOptions,...selectedSeasons])].sort((a,b)=>a.localeCompare(b,'tr'));seasonPanel.innerHTML=opts.length?opts.map(v=>`<label class="pricingRuleSeasonOption"><input type="checkbox" value="${escapeHtml(v)}" ${selectedSeasons.has(v)?'checked':''}> <span>${escapeHtml(v)}</span></label>`).join(''):'<div style="padding:8px;color:var(--muted)">Sezon verisi bulunamadı.</div>';seasonPanel.querySelectorAll('input').forEach(inp=>inp.addEventListener('change',()=>{if(inp.checked)selectedSeasons.add(inp.value);else selectedSeasons.delete(inp.value);updateSeasonButton();}));updateSeasonButton();}
    function updateSeasonButton(){const label=seasonBtn.querySelector('span');label.textContent=!selectedSeasons.size?'Tüm Sezonlar':selectedSeasons.size===1?[...selectedSeasons][0]:selectedSeasons.size+' sezon seçili';}
    function setSeasons(values){selectedSeasons=new Set(normalizePricingRuleSeasons(values));renderSeasonPicker();}
    seasonBtn.addEventListener('click',e=>{e.stopPropagation();seasonPanel.classList.toggle('open');});seasonPanel.addEventListener('click',e=>e.stopPropagation());
    function clearForm(){editingId=null;editingOriginal=null;[opdStart,opdEnd,licensor,license,royalty,hologram].forEach(x=>x.value='');trCommission.value='0';ydCommission.value='0';setSeasons([]);modal.querySelector('#_ruleAdd span').textContent='Kural Ekle';}
    const numericFilter=(value,q)=>!norm(q)||(value!=null&&String(value).replace('.',',').includes(norm(q).replace('.',',')));
    function visibleRules(counts){const q={};Object.keys(filters).forEach(k=>q[k]=norm(filters[k]).toLocaleLowerCase('tr-TR'));return working.filter(r=>{const mc=counts.get(r.id)||0;if(q.opdRange&&!pricingRuleDateRangeLabel(r).toLocaleLowerCase('tr-TR').includes(q.opdRange))return false;if(q.seasons&&!pricingRuleSeasonLabel(r).toLocaleLowerCase('tr-TR').includes(q.seasons))return false;if(q.licensor&&!norm(r.licensor).toLocaleLowerCase('tr-TR').includes(q.licensor))return false;if(q.license&&!norm(r.license).toLocaleLowerCase('tr-TR').includes(q.license))return false;if(!numericFilter(r.royalty,filters.royalty)||!numericFilter(r.trCommission,filters.trCommission)||!numericFilter(r.ydCommission,filters.ydCommission)||!numericFilter(r.hologramCost,filters.hologramCost))return false;if(q.matches&&!String(mc).includes(q.matches))return false;return true;}).sort((a,b)=>{let cmp=0;if(sort.key==='opdRange'){cmp=(dateOrdinal(a.opdStart)??-Infinity)-(dateOrdinal(b.opdStart)??-Infinity)||(dateOrdinal(a.opdEnd)??Infinity)-(dateOrdinal(b.opdEnd)??Infinity);}else if(sort.key==='seasons')cmp=pricingRuleSeasonLabel(a).localeCompare(pricingRuleSeasonLabel(b),'tr');else if(['licensor','license'].includes(sort.key))cmp=norm(a[sort.key]).localeCompare(norm(b[sort.key]),'tr');else if(sort.key==='matches')cmp=(counts.get(a.id)||0)-(counts.get(b.id)||0);else cmp=(a[sort.key]==null?Infinity:Number(a[sort.key]))-(b[sort.key]==null?Infinity:Number(b[sort.key]));return (sort.dir==='desc'?-cmp:cmp)||String(a.id).localeCompare(String(b.id));});}
    function ruleLabel(r){return [r.license,r.licensor,pricingRuleSeasonLabel(r),'Royalty '+pct(r.royalty),'TR +'+pct(r.trCommission),'YD +'+pct(r.ydCommission)].filter(Boolean).join(' · ');}
    const checkRule=$('_ruleCheckRule'),checkSearch=$('_ruleCheckSearch'),checkSupp=$('_ruleCheckSupp'),checkYd=$('_ruleCheckFinalYd'),checkTr=$('_ruleCheckFinalTr'),checkOut=$('_ruleCheckOut');let checkSource='supp';
    function renderCheckOptions(){const prev=checkRule.value,q=norm(checkSearch.value).toLocaleLowerCase('tr-TR'),items=prioritizePricingRuleCheckCandidates(working.filter(r=>!q||ruleLabel(r).toLocaleLowerCase('tr-TR').includes(q)));checkRule.innerHTML=items.length?items.map(r=>`<option value="${escapeHtml(r.id)}">${escapeHtml(ruleLabel(r)+(pricingRuleIsExpired(r)?' · Süresi geçmiş':''))}</option>`).join(''):'<option value="">Tanımlı kural yok</option>';if(prev&&items.some(r=>r.id===prev))checkRule.value=prev;}
    const parse=v=>{const t=String(v||'').trim();if(!t)return null;const n=Number(t.replace(',','.'));return Number.isFinite(n)?n:null;},format=v=>Number(v).toLocaleString('tr-TR',{minimumFractionDigits:2,maximumFractionDigits:3});
    function setVal(el,v){el.value=v==null?'':format(v);}
    function runCheck(){const r=working.find(x=>x.id===checkRule.value);if(!r){checkOut.textContent='Önce bir kural tanımlayın.';return;}const src=checkSource==='yd'?checkYd:checkSource==='tr'?checkTr:checkSupp,v=parse(src.value);if(v==null||v<0){checkOut.textContent='';return;}let supp=v;if(checkSource==='yd')supp=api.calculateSuppFobWithRule(v,r,'YD');if(checkSource==='tr')supp=api.calculateSuppFobWithRule(v,r,'TR');if(supp==null){checkOut.textContent='Seçilen ülke komisyonu tanımlı değil veya toplam oran geçersiz.';return;}const yd=api.calculateFinalFobWithRule(supp,r,'YD'),tr=api.calculateFinalFobWithRule(supp,r,'TR');if(checkSource!=='supp')setVal(checkSupp,supp);if(checkSource!=='yd')setVal(checkYd,yd);if(checkSource!=='tr')setVal(checkTr,tr);checkOut.textContent=`Royalty ${pct(r.royalty)} · YD Kom. ${pct(commission(r,'YD'))} → ${pct(effectiveRoyalty(r,'YD'))} · TR Kom. ${pct(commission(r,'TR'))} → ${pct(effectiveRoyalty(r,'TR'))} · Hologram YD ${money(hologramFor(r,'YD'))} / TR ${money(hologramFor(r,'TR'))}`;}
    checkSupp.addEventListener('input',()=>{checkSource='supp';runCheck();});checkYd.addEventListener('input',()=>{checkSource='yd';runCheck();});checkTr.addEventListener('input',()=>{checkSource='tr';runCheck();});checkSearch.addEventListener('input',()=>{renderCheckOptions();runCheck();});checkRule.addEventListener('change',runCheck);$('_ruleCheckClear').addEventListener('click',()=>{checkSupp.value=checkYd.value=checkTr.value=checkOut.textContent='';checkSource='supp';});
    function renderRules(){renderCheckOptions();const counts=new Map(working.map(r=>[r.id,pricingRuleMatchCount(r)])),visible=visibleRules(counts),body=$('_rulesBody');body.innerHTML=visible.map(r=>{const legacy=r.legacyTrHologramCost!=null||r.legacyYdHologramCost!=null;return `<tr data-id="${escapeHtml(r.id)}" class="${pricingRuleIsExpired(r)?'pricingRuleExpired':''}"><td>${escapeHtml(pricingRuleDateRangeLabel(r))}</td><td>${escapeHtml(pricingRuleSeasonLabel(r))}</td><td>${escapeHtml(r.licensor)}</td><td>${escapeHtml(r.license)}</td><td class="num">${pct(r.royalty)}</td><td class="num">${pct(r.trCommission)}</td><td class="num">${pct(r.ydCommission)}</td><td class="num" ${legacy?`title="Eski hologram değerleri korunuyor: TR ${money(hologramFor(r,'TR'))} · YD ${money(hologramFor(r,'YD'))}"`:''}>${money(r.hologramCost)}${legacy?' *':''}</td><td class="num">${counts.get(r.id)||0}</td><td><div class="pricingRuleActions"><button class="pricingRuleBtn tonal small applyRule"><svg class="ic"><use href="#i-refresh"/></svg> Uygula</button><button class="pricingRuleBtn small iconOnly editRule"><svg class="ic"><use href="#i-pencil"/></svg></button><button class="pricingRuleBtn danger small iconOnly deleteRule"><svg class="ic"><use href="#i-trash"/></svg></button></div></td></tr>`;}).join('');$('_rulesEmpty').style.display=visible.length?'none':'block';$('_rulesStatus').textContent=`${working.length} kural · ${[...counts.values()].reduce((a,b)=>a+b,0)} CP satırı eşleşiyor`;
      body.querySelectorAll('.editRule').forEach(btn=>btn.addEventListener('click',()=>{const r=working.find(x=>x.id===btn.closest('tr').dataset.id);if(!r)return;editingId=r.id;editingOriginal={...r};opdStart.value=r.opdStart||'';opdEnd.value=r.opdEnd||'';setSeasons(r.seasons||[]);licensor.value=r.licensor;license.value=r.license;royalty.value=String(r.royalty).replace('.',',');trCommission.value=r.trCommission==null?'':String(r.trCommission).replace('.',',');ydCommission.value=r.ydCommission==null?'':String(r.ydCommission).replace('.',',');hologram.value=String(r.hologramCost).replace('.',',');modal.querySelector('#_ruleAdd span').textContent='Kuralı Güncelle';}));
      body.querySelectorAll('.deleteRule').forEach(btn=>btn.addEventListener('click',()=>{const id=btn.closest('tr').dataset.id;working=working.filter(x=>x.id!==id);if(editingId===id)clearForm();renderRules();}));
      body.querySelectorAll('.applyRule').forEach(btn=>btn.addEventListener('click',async()=>{const id=btn.closest('tr').dataset.id,r=working.find(x=>x.id===id);if(!r)return;btn.disabled=true;try{await persistPricingRules(working);working=normalizePricingRules(state.overrides.pricingRules);const current=working.find(x=>x.id===id)||r;const count=await applySuppFobRuleToMatchingOrders(current);$('_rulesStatus').textContent=count+' sipariş güncellendi.';}catch(err){$('_rulesStatus').textContent='Uygulanamadı: '+err.message;}finally{btn.disabled=false;renderRules();}}));
    }
    modal.querySelectorAll('.pricingRuleSortBtn').forEach(btn=>btn.addEventListener('click',()=>{const key=btn.dataset.sort;sort=sort.key===key?{key,dir:sort.dir==='asc'?'desc':'asc'}:{key,dir:'asc'};renderRules();}));
    modal.querySelectorAll('.pricingRuleFilter').forEach(el=>el.addEventListener('input',()=>{filters[el.dataset.filter]=el.value;renderRules();}));$('_rulesClearFilters').addEventListener('click',()=>{Object.keys(filters).forEach(k=>filters[k]='');modal.querySelectorAll('.pricingRuleFilter').forEach(el=>el.value='');renderRules();});
    $('_ruleAdd').addEventListener('click',()=>{const parsePct=input=>{const t=String(input.value||'').trim();if(!t)return null;const n=Number(t.replace(',','.'));return Number.isFinite(n)?n:NaN;};const r={id:editingId||('rule-'+Date.now()+'-'+Math.round(Math.random()*10000)),opdStart:normalizePricingRuleDate(opdStart.value),opdEnd:normalizePricingRuleDate(opdEnd.value),seasons:normalizePricingRuleSeasons([...selectedSeasons]),licensor:norm(licensor.value),license:norm(license.value),royalty:Number(royalty.value.replace(',','.')),trCommission:parsePct(trCommission),ydCommission:parsePct(ydCommission),hologramCost:Number(hologram.value.replace(',','.'))};
      if(r.opdStart&&r.opdEnd&&dateOrdinal(r.opdStart)>dateOrdinal(r.opdEnd))return showToast('OPD bitiş tarihi başlangıç tarihinden önce olamaz.');
      if(!r.licensor||!r.license)return showToast('Licensor ve License zorunludur.');if(!Number.isFinite(r.royalty)||r.royalty<0||r.royalty>100)return showToast('Royalty % 0–100 arasında olmalıdır.');
      if(r.trCommission==null&&r.ydCommission==null)return showToast('TR Komisyon veya YD Komisyon alanlarından en az biri tanımlı olmalıdır.');
      if((r.trCommission!=null&&(!Number.isFinite(r.trCommission)||r.trCommission<0||r.trCommission>100))||(r.ydCommission!=null&&(!Number.isFinite(r.ydCommission)||r.ydCommission<0||r.ydCommission>100)))return showToast('Komisyon değerleri % cinsinden 0–100 arasında olmalıdır.');
      if((r.trCommission!=null&&r.royalty+r.trCommission>100)||(r.ydCommission!=null&&r.royalty+r.ydCommission>100))return showToast('Royalty + Komisyon toplamı %100’ü geçemez.');
      if(!Number.isFinite(r.hologramCost)||r.hologramCost<0)return showToast('Hologram Cost geçerli bir sayı olmalıdır.');
      if(editingOriginal&&Number(r.hologramCost)===Number(editingOriginal.hologramCost)){['legacyTrHologramCost','legacyYdHologramCost','legacyRuleIds','migratedFromCountrySplit'].forEach(k=>{if(Object.prototype.hasOwnProperty.call(editingOriginal,k))r[k]=editingOriginal[k];});}
      if(working.find(x=>x.id!==editingId&&pricingRulesSameCondition(x,r)))return showToast('Aynı koşullara sahip bir kayıt zaten var.');
      const overlap=working.find(x=>x.id!==editingId&&pricingRulesOverlap(x,r));if(overlap)return showToast('Tarih/sezon kapsamı '+pricingRuleDateRangeLabel(overlap)+' hesabıyla çakışıyor.');
      const idx=working.findIndex(x=>x.id===r.id);if(idx>=0)working[idx]=r;else working.push(r);working=normalizePricingRules(working);clearForm();renderRules();
    });
    $('_ruleFormClear').addEventListener('click',clearForm);$('_rulesApplyAll').addEventListener('click',async()=>{const btn=$('_rulesApplyAll'),clean=normalizePricingRules(working);if(!clean.length)return showToast('Uygulanacak kural yok.');btn.disabled=true;try{await persistPricingRules(clean);working=normalizePricingRules(state.overrides.pricingRules);const count=await applyAllSuppFobRules(working);$('_rulesStatus').textContent='Tümüne Uygula: '+count+' sipariş güncellendi.';renderRules();}catch(err){$('_rulesStatus').textContent='Uygulanamadı: '+err.message;}finally{btn.disabled=false;}});
    $('_rulesSave').addEventListener('click',async()=>{const btn=$('_rulesSave');btn.disabled=true;try{const result=await persistPricingRules(working);modal.remove();showToast(`${working.length} License Royalty hesabı kaydedildi; CP ${result.cpChanged||0}, Koleksiyon ${result.collectionChanged||0} kayıt güncellendi.`);}catch(err){btn.disabled=false;$('_rulesStatus').textContent='Kaydedilemedi: '+err.message;}});
    modal.querySelectorAll('._rulesClose').forEach(b=>b.addEventListener('click',()=>modal.remove()));modal.addEventListener('click',e=>{if(!e.target.closest('.pricingRuleSeasonPicker'))seasonPanel.classList.remove('open');if(e.target===modal)modal.remove();});modal.addEventListener('keydown',e=>{if(e.key==='Escape')modal.remove();});
    renderSeasonPicker();renderRules();setTimeout(()=>opdStart.focus(),0);
  };

  const style=document.createElement('style');style.textContent='.royaltyV2Grid{grid-template-columns:repeat(5,minmax(0,1fr))}.royaltyV2Table{min-width:1280px}.royaltyV2CheckGrid{grid-template-columns:minmax(240px,2fr) 1fr 34px 1fr 1fr auto}.pricingRuleFormula small{display:block;margin-top:4px;color:var(--muted);font-family:inherit;font-weight:500}@media(max-width:1050px){.royaltyV2Grid{grid-template-columns:repeat(3,minmax(0,1fr))}.royaltyV2CheckGrid{grid-template-columns:1fr 1fr}.royaltyV2CheckGrid .pricingRuleCheckArrow{display:none}}';document.head.appendChild(style);

  // app-main eski localStorage kopyasını bu script yüklenmeden önce okuduğu için
  // bir kez yeni şemaya geçir. Sunucu hidrasyonu geldiğinde aynı normalizer
  // tekrar güvenle çalışır.
  try{
    const migrated=normalizePricingRules(state.overrides&&state.overrides.pricingRules||[]);
    state.overrides.pricingRules=migrated;saveLocalPricingRules(migrated);
    syncPricingRulesToAllLoadedViews({saveCollection:false,renderCollection:false});
  }catch(error){console.warn('License Royalty v2 migration failed',error);}
})();