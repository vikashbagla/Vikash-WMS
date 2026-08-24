// ============================================================================
// accounting-bank-import.js — Bank Import (Master workspace tab)
// Loaded by app.html after accounting.js. Namespace abi* / #abi* / .abi-*.
// Parses a multi-sheet bank workbook (SheetJS), matches each sheet to its bank
// ledger by the BANK_<sheet> role, resolves the free-text "Ledger" column via
// acc_narr_map, diffs vs existing BANK_TXN vouchers, posts selected rows as
// manual vouchers (source_kind='BANK_TXN').
// ============================================================================
var abiBankLedgers=null, abiNarrMap=null, abiLedgerById=null, abiParsed=null;
var abiActiveAcct=0, abiFilter='new', abiSelected={};
var abiSplitCtrl=null, abiSplitTarget=null, abiSplitLegsData=[], abiMapCtrl=null, abiMapTarget=null;
var ABI_IGNORE=['others','ppf_ssy'];

function abiAmt(n){ n=Number(n)||0; return n.toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function abiNum(v){ if(v===null||v===undefined||v==='')return 0; if(typeof v==='number')return v; var s=String(v).replace(/[, ]/g,''); var f=parseFloat(s); return isFinite(f)?f:0; }
function abiCyrb128(str){
  var h1=1779033703,h2=3144134277,h3=1013904242,h4=2773480762;
  for(var i=0,k;i<str.length;i++){ k=str.charCodeAt(i);
    h1=h2^Math.imul(h1^k,597399067); h2=h3^Math.imul(h2^k,2869860233);
    h3=h4^Math.imul(h3^k,951274213); h4=h1^Math.imul(h4^k,2716044179); }
  h1=Math.imul(h3^(h1>>>18),597399067); h2=Math.imul(h4^(h2>>>22),2869860233);
  h3=Math.imul(h1^(h3>>>17),951274213); h4=Math.imul(h2^(h4>>>19),2716044179);
  h1^=(h2^h3^h4); h2^=h1; h3^=h1; h4^=h1;
  function hx(n){ return (n>>>0).toString(16).padStart(8,'0'); }
  var h=hx(h1)+hx(h2)+hx(h3)+hx(h4);
  return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20,32);
}
async function abiLoadRefs(){
  var leds=await wmsFetchAllRaw(acctUrl('acct_ledgers?select=id,name,posting_role,scope_investor_ids&posting_role=like.BANK*'));
  abiBankLedgers={};
  (leds||[]).forEach(function(l){ if(!l.posting_role||l.posting_role.indexOf('BANK_')!==0)return;
    var suffix=l.posting_role.slice(5); var bookId=(l.scope_investor_ids&&l.scope_investor_ids[0])||null;
    abiBankLedgers[suffix.toLowerCase()]={id:l.id,name:l.name,role:l.posting_role,bookId:bookId}; });
  var books=(typeof acctOwnBooks==='function')?(acctOwnBooks()||[]):[];
  Object.keys(abiBankLedgers).forEach(function(k){ var b=books.filter(function(x){return String(x.id)===String(abiBankLedgers[k].bookId);})[0]; abiBankLedgers[k].book=b?(b.short_name||b.name):'?'; });
  abiNarrMap=await wmsFetchAllRaw(acctUrl('acc_narr_map?select=*'))||[];
  abiLedgerById={}; (typeof acctLedgers!=='undefined'?acctLedgers:[]).forEach(function(l){ abiLedgerById[l.id]=l.name; });
}
function abiResolveNarr(name,bookId){
  if(!name)return null; var lc=String(name).trim().toLowerCase();
  var cand=(abiNarrMap||[]).filter(function(m){return String(m.excel_ledger_name).trim().toLowerCase()===lc;});
  var book=cand.filter(function(m){return !m.is_global&&(m.scope_investor_ids||[]).map(String).indexOf(String(bookId))>=0;});
  var glob=cand.filter(function(m){return m.is_global;});
  var pick=book[0]||glob[0]; if(!pick)return null;
  return {id:pick.ledger_id,name:(abiLedgerById&&abiLedgerById[pick.ledger_id])||'(ledger)'};
}
function abiHeaderRow(aoa){ for(var i=0;i<Math.min(aoa.length,6);i++){ var vals=(aoa[i]||[]).map(function(x){return String(x==null?'':x).trim().toLowerCase();}); if(vals.indexOf('ledger')>=0)return i; } return -1; }
function abiColMap(hdr){ var m={}; hdr.forEach(function(h,i){ var k=String(h==null?'':h).trim().toLowerCase();
  if(k==='sl#'||k==='no'||k==='sr#'||k==='s.no')m.slno=i;
  else if(k==='txn date'||(k.indexOf('txn')>=0&&k.indexOf('date')>=0))m.date=i;
  else if(k==='ledger')m.ledger=i; else if(k==='narration')m.narr=i;
  else if(k==='withdrawn'||k==='withdrawl'||k==='withdrawal')m.wd=i; else if(k==='deposit')m.dep=i;
  else if(k==='expense')m.exp=i; else if(k==='payment')m.pay=i; else if(k==='balance')m.bal=i;
  else if(m.date===undefined&&k==='date')m.dateAlt=i; });
  if(m.date===undefined&&m.dateAlt!==undefined)m.date=m.dateAlt; return m; }
function abiToYmd(v){ if(v==null||v==='')return null;
  if(v instanceof Date&&!isNaN(v))return v.getFullYear()+'-'+String(v.getMonth()+1).padStart(2,'0')+'-'+String(v.getDate()).padStart(2,'0');
  if(typeof v==='number'){ var d=new Date(Date.UTC(1899,11,30)+v*86400000); return d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0')+'-'+String(d.getUTCDate()).padStart(2,'0'); }
  var d2=new Date(v); if(!isNaN(d2))return d2.getFullYear()+'-'+String(d2.getMonth()+1).padStart(2,'0')+'-'+String(d2.getDate()).padStart(2,'0'); return null; }
function abiDisp(ymd){ if(!ymd)return ''; try{ return (typeof formatDate==='function')?formatDate(ymd):ymd; }catch(e){ return ymd; } }
function abiParseSheet(ws,acct){
  var aoa=XLSX.utils.sheet_to_json(ws,{header:1,raw:true,cellDates:true,defval:null});
  var hr=abiHeaderRow(aoa); if(hr<0)return []; var cm=abiColMap(aoa[hr]); var isCC=(cm.exp!==undefined||cm.pay!==undefined); var rows=[];
  for(var r=hr+1;r<aoa.length;r++){ var row=aoa[r]||[];
    var slno=cm.slno!==undefined?row[cm.slno]:null; var ymd=abiToYmd(cm.date!==undefined?row[cm.date]:null);
    var excelName=cm.ledger!==undefined?(row[cm.ledger]==null?'':String(row[cm.ledger]).trim()):'';
    var narr=cm.narr!==undefined?(row[cm.narr]==null?'':String(row[cm.narr]).trim()):'';
    var wd=isCC?abiNum(row[cm.exp]):abiNum(row[cm.wd]); var dp=isCC?abiNum(row[cm.pay]):abiNum(row[cm.dep]);
    var bal=cm.bal!==undefined?abiNum(row[cm.bal]):null;
    if(slno==null||slno==='')continue; if(/opening balance/i.test(excelName)||/opening balance/i.test(narr))continue; if(wd<=0&&dp<=0)continue;
    var dir=dp>0?'in':'out'; var amount=dp>0?dp:wd; var res=abiResolveNarr(excelName,acct.bookId);
    var o={slno:String(slno),ymd:ymd,disp:abiDisp(ymd),excelName:excelName,narr:narr,wd:wd,dp:dp,bal:bal,dir:dir,amount:amount,isCC:isCC,mappedId:res?res.id:null,mappedName:res?res.name:null,split:null};
    o.identity=abiCyrb128([acct.ledgerId,o.slno,(o.mappedId||excelName),amount.toFixed(2)].join('|')); rows.push(o); }
  return rows;
}
async function abiHandleWorkbook(wb){
  if(!abiBankLedgers)await abiLoadRefs();
  var accounts=[],unmatched=[],ignored=[];
  (wb.SheetNames||[]).forEach(function(sn){
    if(ABI_IGNORE.indexOf(sn.trim().toLowerCase())>=0){ ignored.push(sn); return; }
    var led=abiBankLedgers[sn.trim().toLowerCase()]; if(!led){ unmatched.push(sn); return; }
    var acct={sheet:sn,ledgerId:led.id,ledgerName:led.name,bookId:led.bookId,book:led.book};
    acct.rows=abiParseSheet(wb.Sheets[sn],acct); accounts.push(acct); });
  abiParsed={accounts:accounts,unmatched:unmatched,ignored:ignored}; abiActiveAcct=0; abiSelected={};
  await abiComputeDiff(); abiRender();
}
function abiSig(lines){ return (lines||[]).map(function(l){
  var d=Math.round((Number(l.debit_amount!==undefined?l.debit_amount:l.debit)||0)*100)/100;
  var c=Math.round((Number(l.credit_amount!==undefined?l.credit_amount:l.credit)||0)*100)/100;
  return String(l.ledger_id)+'|'+d+'|'+c; }).sort().join(';'); }
function abiLines(row,acct){
  var bankDr=(row.dir==='in'); var legs=(row.split&&row.split.length)?row.split:[{ledger_id:row.mappedId,amount:row.amount,narration:row.narr}];
  var lines=[{ledger_id:acct.ledgerId,debit_amount:bankDr?row.amount:0,credit_amount:bankDr?0:row.amount,narration:null,sort_order:0}];
  legs.forEach(function(lg,i){ lines.push({ledger_id:lg.ledger_id,debit_amount:bankDr?0:lg.amount,credit_amount:bankDr?lg.amount:0,narration:lg.narration||null,sort_order:i+1}); });
  return lines;
}
async function abiComputeDiff(){
  var books={}; abiParsed.accounts.forEach(function(a){ if(a.bookId)books[a.bookId]=1; });
  var bookIds=Object.keys(books); var existing={};
  if(bookIds.length){
    var rows=await wmsFetchAllRaw(acctUrl('acct_voucher_full?select=voucher_id,source_id,is_cancelled,ledger_id,debit_amount,credit_amount&source_kind=eq.BANK_TXN&investor_id=in.('+bookIds.join(',')+')'));
    var byV={}; (rows||[]).forEach(function(r){ if(!r.source_id)return; (byV[r.source_id]=byV[r.source_id]||{vid:r.voucher_id,cancelled:r.is_cancelled,lines:[]}).lines.push(r); });
    Object.keys(byV).forEach(function(k){ if(byV[k].cancelled)return; existing[k]={vid:byV[k].vid,sig:abiSig(byV[k].lines)}; });
  }
  abiParsed.accounts.forEach(function(a){ a.rows.forEach(function(row){ var ex=existing[row.identity];
    if(!ex){ row.status='new'; row.voucherId=null; } else { row.voucherId=ex.vid; row.status=(abiSig(abiLines(row,a))===ex.sig)?'existing':'changed'; } }); });
}
function abiRowKey(ai,ri){ return ai+'::'+ri; }
function abiRowFromKey(key){ var p=key.split('::'); return {a:abiParsed.accounts[+p[0]],r:abiParsed.accounts[+p[0]].rows[+p[1]]}; }
function abiRender(){ var el=document.getElementById('abiBody'); if(!el)return; if(typeof acctSetCmdFilters==='function')acctSetCmdFilters(''); if(!abiParsed){ abiRenderUpload(el); return; } abiRenderReview(el); }
function abiClear(){ abiParsed=null; abiSelected={}; abiRender(); }
async function abiRenderUpload(el){
  el.classList.remove('abi-review');
  el.innerHTML='<div class="abi-drop" id="abiDrop"><input type="file" id="abiFile" accept=".xlsx,.xls" style="display:none;">'+
    '<div class="abi-drop-main">Upload a bank statement workbook (.xlsx)</div>'+
    '<div class="abi-drop-sub">Each sheet matches a bank ledger by its BANK_&lt;sheet&gt; role. Others / PPF_SSY ignored. Re-upload anytime — only new / changed rows are picked up.</div></div>'+
    '<div class="acct-ex-count" style="margin-top:14px;">Last import</div><div id="abiLog"><div class="acct-empty">Loading…</div></div>';
  var drop=document.getElementById('abiDrop'),file=document.getElementById('abiFile');
  drop.onclick=function(){ file.click(); };
  file.onchange=function(e){ var f=e.target.files[0]; if(f)abiReadFile(f); };
  drop.ondragover=function(e){ e.preventDefault(); drop.classList.add('abi-drop-over'); };
  drop.ondragleave=function(){ drop.classList.remove('abi-drop-over'); };
  drop.ondrop=function(e){ e.preventDefault(); drop.classList.remove('abi-drop-over'); var f=e.dataTransfer.files[0]; if(f)abiReadFile(f); };
  abiRenderLog();
}
async function abiRenderLog(){
  var el=document.getElementById('abiLog'); if(!el)return;
  try{ var rows=await wmsFetchAllRaw(acctUrl("import_log?select=*&import_type=eq.BANK_STATEMENT&order=created_at.desc&limit=40"));
    if(!rows||!rows.length){ el.innerHTML='<div class="acct-empty">No bank imports yet.</div>'; return; }
    var seen={},latest=[]; rows.forEach(function(r){ var k=(r.details&&r.details.ledger)||r.id; if(!seen[k]){ seen[k]=1; latest.push(r); } });
    var body=latest.map(function(r){ var d=r.details||{};
      return '<tr><td>'+wmsEsc(d.ledger||'—')+'</td><td class="c-date">'+wmsEsc(abiDisp(r.import_date))+'</td><td class="c-date">'+wmsEsc(abiDisp(d.last_entry||''))+'</td><td class="text-right">'+(r.new_rows||0)+'</td><td class="text-right">'+(r.updated_rows||0)+'</td><td>'+wmsEsc(r.status||'')+'</td></tr>'; }).join('');
    el.innerHTML='<table class="acct-table"><thead><tr><th>Account</th><th class="c-date">Import date</th><th class="c-date">Last entry</th><th class="text-right">New</th><th class="text-right">Updated</th><th>Status</th></tr></thead><tbody>'+body+'</tbody></table>';
  }catch(e){ el.innerHTML='<div class="acct-empty">Could not load log.</div>'; }
}
function abiReadFile(f){ var reader=new FileReader();
  reader.onload=function(e){ try{ var wb=XLSX.read(new Uint8Array(e.target.result),{type:'array',cellDates:true}); abiHandleWorkbook(wb); }catch(err){ acctToast('Could not read file: '+(err.message||err),true); } };
  reader.readAsArrayBuffer(f); }
function abiRenderReview(el){
  el.classList.add('abi-review');
  var accts=abiParsed.accounts;
  if(!accts.length){ el.innerHTML='<div class="acct-empty">No mapped bank sheets found.'+(abiParsed.unmatched.length?' Unmatched (need a BANK_ role): '+abiParsed.unmatched.map(wmsEsc).join(', '):'')+'</div><div style="margin-top:10px;"><button class="wms-btn wms-btn-secondary" onclick="abiClear()">Back to upload</button></div>'; return; }
  if(abiActiveAcct>=accts.length)abiActiveAcct=0; var a=accts[abiActiveAcct];
  var tabs=accts.map(function(x,i){ return '<span class="abi-acct-tab'+(i===abiActiveAcct?' active':'')+'" data-ai="'+i+'">'+wmsEsc(x.book+' · '+x.sheet)+'</span>'; }).join('');
  var cnt={all:a.rows.length,new:0,existing:0,changed:0}; a.rows.forEach(function(r){ cnt[r.status]++; });
  var chips=['all','new','existing','changed'].map(function(f){ return '<span class="abi-chip'+(abiFilter===f?' active':'')+'" data-f="'+f+'">'+(f.charAt(0).toUpperCase()+f.slice(1))+' ('+cnt[f]+')</span>'; }).join('');
  var showBal=(abiFilter==='all');
  var vis=a.rows.map(function(r,ri){return {r:r,ri:ri};}).filter(function(o){ return abiFilter==='all'||o.r.status===abiFilter; });
  var head='<tr><th style="width:26px;"></th><th>Sl#</th><th class="c-date">Txn Date</th><th>Ledger → WMS ledger</th><th>Narration</th><th class="text-right">Withdrawn</th><th class="text-right">Deposit</th>'+(showBal?'<th class="text-right">Balance</th>':'')+'<th></th></tr>';
  var body=vis.map(function(o){ var r=o.r,ri=o.ri,key=abiRowKey(abiActiveAcct,ri);
    var mapped=r.split&&r.split.length?('Split ×'+r.split.length):(r.mappedName||'— map name —');
    var mappedCls=(r.mappedId||(r.split&&r.split.length))?'#16a34a':'#dc2626';
    var canSel=r.status==='new'||r.status==='changed';
    var chk=canSel?'<input type="checkbox" class="abi-chk" data-key="'+key+'"'+(abiSelected[key]?' checked':'')+'>':'<span class="acct-ex-note">✓</span>';
    var sev=r.status==='changed'?' <span class="acct-ex-sev warn" style="font-size:9px;">changed</span>':'';
    var act=''; if(canSel){ act='<button class="wms-btn wms-btn-secondary abi-mini" data-split="'+key+'">Split</button>'; if(!r.mappedId&&!(r.split&&r.split.length))act+=' <button class="wms-btn wms-btn-secondary abi-mini" data-map="'+key+'">map…</button>'; }
    return '<tr class="'+(r.status==='existing'?'acct-ex-resolved-row':'')+'"><td>'+chk+'</td><td>'+wmsEsc(r.slno)+sev+'</td><td class="c-date">'+wmsEsc(r.disp)+'</td>'+
      '<td><div class="acct-ex-note">'+wmsEsc(r.excelName||'—')+'</div><div style="color:'+mappedCls+';font-weight:600;">'+wmsEsc(mapped)+'</div></td>'+
      '<td>'+wmsEsc(r.narr||'')+'</td><td class="text-right">'+(r.wd>0?abiAmt(r.wd):'')+'</td><td class="text-right" style="color:#16a34a;font-weight:600;">'+(r.dp>0?abiAmt(r.dp):'')+'</td>'+
      (showBal?'<td class="text-right acct-ex-note">'+(r.bal!=null?abiAmt(r.bal):'')+'</td>':'')+'<td>'+act+'</td></tr>'; }).join('');
  var selCount=Object.keys(abiSelected).filter(function(k){return abiSelected[k];}).length;
  el.innerHTML='<div class="abi-acct-tabs">'+tabs+'<span style="flex:1;"></span><button class="wms-btn wms-btn-secondary" onclick="abiClear()">Clear screen</button></div>'+
    '<div class="abi-chips">'+chips+'<span style="flex:1;"></span><span class="acct-ex-note">'+wmsEsc(a.ledgerName)+' · '+wmsEsc(a.book)+'</span></div>'+
    '<div class="abi-grid"><table class="acct-table"><thead>'+head+'</thead><tbody>'+(body||'<tr><td colspan="9"><div class="acct-empty">No rows in this filter.</div></td></tr>')+'</tbody></table></div>'+
    '<div class="abi-foot"><button class="wms-btn wms-btn-secondary" id="abiSelAll">Select all shown</button><span style="flex:1;"></span><button class="wms-btn wms-btn-primary" id="abiAdd">Add selected ('+selCount+')</button></div>';
  el.querySelectorAll('.abi-acct-tab').forEach(function(t){ t.onclick=function(){ abiActiveAcct=+t.dataset.ai; abiFilter='new'; abiRender(); }; });
  el.querySelectorAll('.abi-chip').forEach(function(c){ c.onclick=function(){ abiFilter=c.dataset.f; abiRender(); }; });
  el.querySelectorAll('.abi-chk').forEach(function(c){ c.onchange=function(){ abiSelected[c.dataset.key]=c.checked; var b=document.getElementById('abiAdd'); if(b){ var n=Object.keys(abiSelected).filter(function(k){return abiSelected[k];}).length; b.textContent='Add selected ('+n+')'; } }; });
  el.querySelectorAll('[data-split]').forEach(function(b){ b.onclick=function(){ abiOpenSplit(b.dataset.split); }; });
  el.querySelectorAll('[data-map]').forEach(function(b){ b.onclick=function(){ abiOpenMap(b.dataset.map); }; });
  var sa=document.getElementById('abiSelAll'); if(sa)sa.onclick=function(){ vis.forEach(function(o){ if(o.r.status==='new'||o.r.status==='changed')abiSelected[abiRowKey(abiActiveAcct,o.ri)]=true; }); abiRender(); };
  var add=document.getElementById('abiAdd'); if(add)add.onclick=abiAddSelected;
}
function abiAttachLedgerPick(input,onPick){ input.onblur=function(){ var q=input.value.trim().toLowerCase(); if(!q){ input.dataset.lid=''; onPick(null); return; }
  var cat=(typeof acctLedgers!=='undefined'?acctLedgers:[]);
  var match=cat.filter(function(l){return l.name.toLowerCase()===q;})[0]||cat.filter(function(l){return l.name.toLowerCase().indexOf(q)>=0;})[0];
  if(match){ input.value=match.name; input.dataset.lid=match.id; onPick(match.id); } else { input.dataset.lid=''; onPick(null); } }; }
function abiOpenSplit(key){ abiSplitTarget=key; var r=abiRowFromKey(key).r;
  var legs=(r.split&&r.split.length)?r.split.slice():[{ledger_id:r.mappedId,amount:r.amount,narration:r.narr}];
  document.getElementById('abiSplitInfo').innerHTML='<b>'+wmsEsc(r.disp)+' · '+wmsEsc(r.narr||r.excelName)+'</b><br><span class="acct-ex-note">Allocate '+abiAmt(r.amount)+' ('+(r.dir==='in'?'Deposit':'Withdrawn')+')</span>';
  abiRenderSplitLegs(legs); if(abiSplitCtrl)abiSplitCtrl.open(); }
function abiRenderSplitLegs(legs){ var body=document.getElementById('abiSplitLegs');
  body.innerHTML=legs.map(function(lg,i){ return '<tr><td><input class="wms-input abi-sp-led" data-i="'+i+'" placeholder="WMS ledger" value="'+wmsEsc((abiLedgerById&&abiLedgerById[lg.ledger_id])||'')+'" data-lid="'+(lg.ledger_id||'')+'"></td>'+
    '<td><input class="wms-input abi-sp-amt" data-i="'+i+'" value="'+(lg.amount||'')+'" style="text-align:right;"></td>'+
    '<td><input class="wms-input abi-sp-nar" data-i="'+i+'" value="'+wmsEsc(lg.narration||'')+'"></td>'+
    '<td><button class="wms-btn-close abi-sp-del" data-i="'+i+'">✕</button></td></tr>'; }).join('');
  abiSplitLegsData=legs.map(function(l){return {ledger_id:l.ledger_id,amount:Number(l.amount)||0,narration:l.narration||''};}); abiWireSplitLegs(); abiUpdateSplitTotal(); }
function abiWireSplitLegs(){ var body=document.getElementById('abiSplitLegs');
  body.querySelectorAll('.abi-sp-amt').forEach(function(inp){ inp.oninput=function(){ abiSplitLegsData[+inp.dataset.i].amount=abiNum(inp.value); abiUpdateSplitTotal(); }; });
  body.querySelectorAll('.abi-sp-nar').forEach(function(inp){ inp.oninput=function(){ abiSplitLegsData[+inp.dataset.i].narration=inp.value; }; });
  body.querySelectorAll('.abi-sp-led').forEach(function(inp){ abiAttachLedgerPick(inp,function(lid){ abiSplitLegsData[+inp.dataset.i].ledger_id=lid; abiUpdateSplitTotal(); }); });
  body.querySelectorAll('.abi-sp-del').forEach(function(b){ b.onclick=function(){ abiSplitLegsData.splice(+b.dataset.i,1); abiRenderSplitLegs(abiSplitLegsData); }; }); }
function abiUpdateSplitTotal(){ var t=abiRowFromKey(abiSplitTarget).r; var sum=abiSplitLegsData.reduce(function(s,l){return s+(Number(l.amount)||0);},0);
  var el=document.getElementById('abiSplitTotal'); var ok=Math.abs(sum-t.amount)<0.005;
  el.innerHTML='Total '+abiAmt(sum)+' / '+abiAmt(t.amount)+' '+(ok?'<span class="acct-ex-sev" style="background:#16a34a;color:#fff;">matches</span>':'<span class="acct-ex-sev warn">off by '+abiAmt(t.amount-sum)+'</span>');
  var save=document.getElementById('abiSplitSave'); if(save)save.disabled=!ok||abiSplitLegsData.some(function(l){return !l.ledger_id;}); }
function abiAddSplitLeg(){ abiSplitLegsData.push({ledger_id:null,amount:0,narration:''}); abiRenderSplitLegs(abiSplitLegsData); }
function abiSaveSplit(){ var t=abiRowFromKey(abiSplitTarget); var legs=abiSplitLegsData.filter(function(l){return (Number(l.amount)||0)>0&&l.ledger_id;});
  t.r.split=legs.length>1?legs.map(function(l){return {ledger_id:l.ledger_id,amount:Number(l.amount),narration:l.narration||null};}):null;
  if(legs.length===1){ t.r.mappedId=legs[0].ledger_id; t.r.mappedName=(abiLedgerById&&abiLedgerById[legs[0].ledger_id])||t.r.mappedName; }
  t.r.identity=abiCyrb128([t.a.ledgerId,t.r.slno,(t.r.split?('split:'+t.r.split.map(function(l){return l.ledger_id+':'+l.amount;}).join(',')):t.r.mappedId),t.r.amount.toFixed(2)].join('|'));
  if(abiSplitCtrl)abiSplitCtrl.close(); abiComputeDiff().then(abiRender); }
function abiOpenMap(key){ abiMapTarget=key; var t=abiRowFromKey(key);
  document.getElementById('abiMapName').textContent=t.r.excelName; document.getElementById('abiMapBook').textContent=t.a.book;
  var led=document.getElementById('abiMapLedger'); led.value=''; led.dataset.lid=''; abiAttachLedgerPick(led,function(){});
  document.getElementById('abiMapGlobal').checked=true; if(abiMapCtrl)abiMapCtrl.open(); }
async function abiSaveMap(){ var t=abiRowFromKey(abiMapTarget); var r=t.r; var led=document.getElementById('abiMapLedger'); var lid=led.dataset.lid;
  if(!lid){ acctToast('Pick an existing WMS ledger.',true); return; } var glob=document.getElementById('abiMapGlobal').checked;
  var body={excel_ledger_name:r.excelName,ledger_id:lid,is_global:glob,scope_investor_ids:glob?[]:[t.a.bookId]};
  try{ var resp=await fetch(acctUrl('acc_narr_map'),{method:'POST',headers:wmsHeaders({'Content-Type':'application/json','Prefer':'return=minimal'}),body:JSON.stringify(body)});
    if(!resp.ok)throw new Error(await resp.text()); abiNarrMap.push(body);
    abiParsed.accounts.forEach(function(a){ a.rows.forEach(function(row){ if(row.excelName===r.excelName&&!row.mappedId){ var res=abiResolveNarr(row.excelName,a.bookId); if(res){ row.mappedId=res.id; row.mappedName=res.name; row.identity=abiCyrb128([a.ledgerId,row.slno,res.id,row.amount.toFixed(2)].join('|')); } } }); });
    await abiComputeDiff(); if(abiMapCtrl)abiMapCtrl.close(); acctToast('Mapping saved.'); abiRender();
  }catch(e){ acctToast('Could not save mapping: '+(e.message||e),true); } }
async function abiAddSelected(){
  var keys=Object.keys(abiSelected).filter(function(k){return abiSelected[k];}); if(!keys.length){ acctToast('Nothing selected.',true); return; }
  var add=document.getElementById('abiAdd'); if(add)add.disabled=true;
  var perAcct={},posted=0,updated=0,failed=0,blocked=0,firstErr=null;
  for(var i=0;i<keys.length;i++){ var t=abiRowFromKey(keys[i]),a=t.a,r=t.r;
    if(!r.mappedId&&!(r.split&&r.split.length)){ blocked++; continue; }
    var lines=abiLines(r,a); var header={investor_id:a.bookId,voucher_type:'JOURNAL',voucher_date:r.ymd,narration:(r.narr||r.excelName||'Bank')+' [Sl# '+r.slno+']',source_kind:'BANK_TXN',source_id:r.identity};
    try{ if(r.status==='changed'&&r.voucherId){ var c=await fetch(acctUrl('rpc/acct_cancel_voucher'),{method:'POST',headers:wmsHeaders({'Content-Type':'application/json'}),body:JSON.stringify({p_voucher_id:r.voucherId,p_reason:'bank re-import — row changed'})}); if(!c.ok){ failed++; if(!firstErr)firstErr=await c.text(); continue; } }
      var resp=await fetch(acctUrl('rpc/acct_post_voucher'),{method:'POST',headers:wmsHeaders({'Content-Type':'application/json'}),body:JSON.stringify({p_header:header,p_lines:lines})});
      if(!resp.ok){ failed++; if(!firstErr)firstErr=await resp.text(); continue; }
      var wasChanged=(r.status==='changed'); if(wasChanged)updated++; else posted++;
      var pa=perAcct[a.bookId]=perAcct[a.bookId]||{a:a,newN:0,updN:0,last:null,total:a.rows.length}; if(wasChanged)pa.updN++; else pa.newN++; if(!pa.last||(r.ymd&&r.ymd>pa.last))pa.last=r.ymd;
      r.status='existing'; abiSelected[keys[i]]=false;
    }catch(e){ failed++; if(!firstErr)firstErr=String(e.message||e); } }
  for(var bk in perAcct){ var p=perAcct[bk]; try{ await fetch(acctUrl('import_log'),{method:'POST',headers:wmsHeaders({'Content-Type':'application/json','Prefer':'return=minimal'}),
    body:JSON.stringify({import_type:'BANK_STATEMENT',import_date:new Date().toISOString().slice(0,10),investor_id:p.a.bookId,total_rows:p.total,new_rows:p.newN,updated_rows:p.updN,status:'posted',details:{ledger:p.a.ledgerName,sheet:p.a.sheet,last_entry:p.last}})}); }catch(e){} }
  if(add)add.disabled=false;
  acctToast('Posted '+posted+(updated?(' · updated '+updated):'')+(blocked?(' · '+blocked+' need mapping'):'')+(failed?(' · '+failed+' failed'):''), failed>0);
  if(failed&&firstErr)console.error('[bank-import] first error:',firstErr);
  try{ if(typeof acctLoadBook==='function')await acctLoadBook(); }catch(e){}
  abiRender();
}
window.abiRender=abiRender; window.abiClear=abiClear; window.abiHandleWorkbook=abiHandleWorkbook;
window.abiSaveSplit=abiSaveSplit; window.abiAddSplitLeg=abiAddSplitLeg; window.abiSaveMap=abiSaveMap;
window.abiWireModals=function(){
  var sp=document.getElementById('abiSplitModal'); if(sp&&typeof wmsModal==='function')abiSplitCtrl=wmsModal(sp,{backdropClose:false});
  var mp=document.getElementById('abiMapModal'); if(mp&&typeof wmsModal==='function')abiMapCtrl=wmsModal(mp,{backdropClose:false});
  var x; if((x=document.getElementById('abiSplitClose')))x.onclick=function(){abiSplitCtrl&&abiSplitCtrl.close();};
  if((x=document.getElementById('abiSplitCancel')))x.onclick=function(){abiSplitCtrl&&abiSplitCtrl.close();};
  if((x=document.getElementById('abiSplitSave')))x.onclick=abiSaveSplit;
  if((x=document.getElementById('abiSplitAdd')))x.onclick=abiAddSplitLeg;
  if((x=document.getElementById('abiMapClose')))x.onclick=function(){abiMapCtrl&&abiMapCtrl.close();};
  if((x=document.getElementById('abiMapCancel')))x.onclick=function(){abiMapCtrl&&abiMapCtrl.close();};
  if((x=document.getElementById('abiMapSave')))x.onclick=abiSaveMap;
};
