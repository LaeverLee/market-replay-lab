import {frames,flags,validateStrategy,parseCandles,validateCandles,computeSignals,makeAccount,onOpen,onClose,runBacktest,metrics,ledgerCsv} from './engine.mjs';

const $=id=>document.getElementById(id);
const glyph={
 grid:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
 chart:'<path d="M3 3v18h18M6 15l5-5 4 3 6-7"/>',activity:'<path d="M2 12h5l3-8 4 16 3-8h5"/>',layers:'<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5m-18 4 9 5 9-5"/>',
 shield:'<path d="m12 22-2-1C6 19 4 15 4 11V5l8-3 8 3v6c0 4-2 8-6 10l-2 1Zm-3-10 2 2 4-4"/>',
 book:'<path d="M12 6C9 3 5 3 2 5v14c4-2 7-1 10 1 3-2 6-3 10-1V5c-3-2-7-2-10 1v14"/>',
 arrow:'<path d="M4 12h15m-6-6 6 6-6 6"/>',upload:'<path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5"/>',download:'<path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4"/>',
 target:'<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',wallet:'<rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 8l3-4h11m4 6h-6v6h6"/>',
 play:'<path d="m8 4 12 8-12 8V4Z"/>',clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',file:'<path d="M5 3h9l5 5v13H5V3Zm9 0v6h5M8 13h8m-8 4h8"/>',
};
const icon=name=>'<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">'+glyph[name]+'</svg>';
document.querySelectorAll('[data-icon]').forEach(e=>e.innerHTML=icon(e.dataset.icon));
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const colors=['#287b5c','#5274a9','#a57039','#855798','#a64f54','#427e89'];
const names={overview:'研究總覽',backtest:'歷史回測',live:'即時模擬',library:'策略庫',guide:'策略格式'};
const selectedPage=()=>Object.hasOwn(names,location.hash.slice(1))?location.hash.slice(1):'overview';
const money=x=>Number(x).toLocaleString('en-US',{maximumFractionDigits:2,minimumFractionDigits:2});
const pct=x=>(x>0?'+':'')+x.toFixed(2)+'%';
const valueClass=x=>x<0?'negative':x>0?'positive':'';
const day=t=>new Date(t).toISOString().slice(0,10);
const time=t=>new Intl.DateTimeFormat('zh-TW',{timeZone:'Asia/Taipei',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(t);
const exchange='https://data-api.binance.vision/api/v3/klines';
const initial={capital:10000,allocation:100,fee:.1,slippage:.02};
const supportedIntervals=Object.keys(frames);
let saved=[];
try{saved=JSON.parse(localStorage.getItem('market-replay-strategies-v1')??'[]').map((s,i)=>({...validateStrategy(s),id:s.id,color:colors[(i+3)%colors.length]}));}catch{}
const strategies=saved;
let market=null, result=null, live=null, historyError='', busy=false, toastTimer;
const hist={source:'',symbol:'BTCUSDT',interval:'1h',from:'',to:'',...initial};
const paper={symbol:'BTCUSDT',interval:'1m',...initial};
let ledgerPage={backtest:0,live:0};

function toast(message,bad=false){
  const box=$('toast');box.hidden=false;box.textContent=message;box.className='toast'+(bad?' bad':'');
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>box.hidden=true,4500);
}
function download(filename,data,type){
  const link=document.createElement('a'), url=URL.createObjectURL(new Blob([data],{type}));
  link.href=url;link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
const template={name:'',version:1,side:'long',indicators:{},enter_long:[],exit_long:[],enter_short:[],exit_short:[]};
function openImport(){
  $('import-error').hidden=true;
  if(!$('import-dialog').open)$('import-dialog').showModal();
}
function importFailure(message){$('import-error').hidden=false;$('import-error').textContent=message;}
async function importStrategy(file){
  if(!file)return;
  try{
    if(file.size>35*1024*1024)throw new Error('檔案上限為 35 MB。');
    const page=selectedPage();
    const id=crypto.randomUUID(), color=colors[strategies.length%colors.length];
    if(/\.py$/i.test(file.name))throw new Error('請先用 Python 執行 generate_signals，將 OHLCV 和四欄訊號匯出為 CSV。');
    const data=await file.text();
    if(/\.json$/i.test(file.name)){
      const s={...validateStrategy(JSON.parse(data.replace(/^\uFEFF/,''))),id,color};
      const next=[...strategies.filter(x=>x.type!=='signals'),s];
      localStorage.setItem('market-replay-strategies-v1',JSON.stringify(next));
      strategies.push(s);
    }else if(/\.csv$/i.test(file.name)){
      const {candles,hasSignals}=parseCandles(data);
      if(!hasSignals)throw new Error('策略 CSV 需有四欄訊號。只有行情欄位時，請在歷史回測匯入行情。');
      const s={id,color,name:file.name.slice(0,-4),type:'signals',candles};
      strategies.push(s);
      setHistorySource(id);
    }else throw new Error('請選擇 .json 或 .csv。');
    $('import-dialog').close();
    location.hash=hist.source===id?'backtest':['backtest','live'].includes(page)?page:'library';
    historyError='';render();toast('已匯入 '+file.name+'。');
  }catch(e){importFailure(e.message);}
}
$('import-top').onclick=openImport;
$('dialog-close').onclick=()=>$('import-dialog').close();
$('format-guide').onclick=()=>$('import-dialog').close();
$('pick-strategy').onclick=()=>$('strategy-file').click();
$('template').onclick=()=>download('market-replay-strategy.json',JSON.stringify(template,null,2),'application/json');
$('strategy-file').onchange=e=>{importStrategy(e.target.files[0]);e.target.value='';};
const drop=$('pick-strategy');
drop.ondragover=e=>{e.preventDefault();drop.classList.add('over');};
drop.ondragleave=()=>drop.classList.remove('over');
drop.ondrop=e=>{e.preventDefault();drop.classList.remove('over');importStrategy(e.dataTransfer.files[0]);};
$('market-file').onchange=async e=>{
  const file=e.target.files[0];e.target.value='';if(!file)return;
  try{
    if(file.size>35*1024*1024)throw new Error('檔案上限為 35 MB。');
    market={name:file.name,...parseCandles(await file.text())};
    setHistorySource('csv');
    historyError='';render();toast('已載入 '+market.candles.length.toLocaleString()+' 根 K 線');
  }catch(error){historyError=error.message;render();}
};
function bar(row){return {t:row[0],open:+row[1],high:+row[2],low:+row[3],close:+row[4],volume:+row[5],end:row[6]};}
async function fetchBars(symbol,interval,limit,after,until,signal){
  if(!/^[A-Z0-9]{5,20}$/.test(symbol)||!frames[interval])throw new Error('請輸入有效的交易對與週期。');
  const params=new URLSearchParams({symbol,interval,limit:String(limit)});
  if(after!==undefined)params.set('startTime',after);
  if(until!==undefined)params.set('endTime',until);
  const response=await fetch(exchange+'?'+params,{signal:signal??AbortSignal.timeout(12000),cache:'no-store'});
  if(!response.ok)throw new Error('Binance 行情請求失敗（'+response.status+'）。請確認交易對或稍後重試。');
  const rows=(await response.json()).map(bar);
  if(!rows.length)throw new Error('所選期間沒有行情。');
  validateCandles(rows,frames[interval]);return rows;
}
function config(model){return Object.fromEntries(Object.keys(initial).map(k=>[k,Number(model[k])]));}
function matchingSignals(a,b){
  return Boolean(a&&b&&(a===b||(a.length===b.length&&a.every((c,i)=>{
    const other=b[i];
    return ['t','open','high','low','close','volume'].every(k=>c[k]===other[k]);
  }))));
}
function strategyBlockReason(s,mode,frame,sourceRows){
  if(s.type==='signals'){
    if(mode==='live')return '僅歷史回測';
    if(!matchingSignals(s.candles,sourceRows))return '請選對應行情';
  }
  if(s.interval&&s.interval!==frame)return '需要 '+s.interval+' 週期';
  if(mode==='live'&&s.side!=='long')return '即時僅支援做多';
  return '';
}
function historyCandles(source){
  return source==='csv'?market?.candles:strategies.find(s=>s.id===source)?.candles;
}
function setHistorySource(source){
  hist.source=source;
  hist.from='';hist.to='';
  const rows=historyCandles(source);
  if(rows?.length>=2){
    const step=rows[1].t-rows[0].t;
    const interval=supportedIntervals.find(key=>frames[key]===step);
    if(interval&&rows.every((bar,i)=>i===0||bar.t-rows[i-1].t===step))hist.interval=interval;
  }
}
function executionPlan(model,mode){
  const sourceRows=mode==='backtest'?historyCandles(model.source):null;
  return strategies.map(strategy=>({
    strategy,
    reason:mode==='backtest'&&!model.source?'請選擇行情來源':strategyBlockReason(strategy,mode,model.interval,sourceRows)
  }));
}
function runnableStrategies(model,mode){
  if(!strategies.length)throw new Error('請先匯入策略檔。');
  if(mode==='backtest'&&!model.source)throw new Error('請選擇行情來源或上傳行情 CSV。');
  const ready=executionPlan(model,mode).filter(entry=>!entry.reason).map(entry=>entry.strategy);
  if(!ready.length)throw new Error('目前沒有符合設定的策略，請查看清單中的原因。');
  return ready;
}
async function backtest(){
  if(busy)return;
  historyError='';busy=true;render();
  const settings=structuredClone(hist);
  try{
    const {source,interval}=settings, snapshot=strategies.find(s=>s.id===source&&s.type==='signals');
    const frame=interval, step=frames[frame];
    const ready=runnableStrategies(settings,'backtest');
    const sizing=config(settings);makeAccount(sizing);
    const from=settings.from?Date.parse(settings.from+'T00:00:00Z'):-Infinity;
    const to=settings.to?Date.parse(settings.to+'T00:00:00Z')+86400000:Infinity;
    if(from>=to)throw new Error('開始日期須早於或等於結束日期。');
    let rows,label;
    if(source==='csv'){rows=market?.candles;label=market?.name;}
    else if(snapshot){rows=snapshot.candles;label=snapshot.name+' · 訊號 CSV';}
    else{
      const symbol=settings.symbol.trim().toUpperCase(), now=Date.now();
      label='Binance '+symbol+' 現貨';
      if(Number.isFinite(from)){
        const begin=Math.max(0,from-1000*step), end=Math.min(to,now);
        if(end<=from)throw new Error('開始時間晚於目前行情。');
        if((end-from)/step>20000)throw new Error('線上回測每次最多 20,000 根 K 線。請縮短日期或上傳歷史 CSV。');
        rows=[];
        for(let t=begin;t<end;){
          const batch=await fetchBars(symbol,frame,1000,t,end-1);
          rows.push(...batch);
          if(batch.length<1000)break;
          t=batch.at(-1).t+step;
        }
        rows=rows.filter(c=>c.end<now);
      }else rows=(await fetchBars(symbol,frame,1000,undefined,Number.isFinite(to)?to-1:undefined)).filter(c=>c.end<now);
    }
    if(!rows?.length)throw new Error('請先載入歷史行情。');
    validateCandles(rows,step);
    const period=rows.filter(c=>c.t>=from&&c.t<to);
    if(period.length<2)throw new Error('所選區間至少需有兩根已收盤 K 線。');
    const accounts=ready.map(s=>({id:s.id,name:s.name,color:s.color,account:runBacktest(s.candles??rows,s,sizing,from,to)}));
    result={accounts,rows:period,label,frame};
    ledgerPage.backtest=0;toast('完成 '+accounts.length+' 個策略的回測');
  }catch(e){historyError=e.message;}finally{busy=false;render();}
}

function updateFeed(){
  const el=$('feed'),status=live?.status;
  el.className='feed '+(status==='online'?'online':status==='error'?'problem':'');
  el.innerHTML='<i></i>'+({online:'即時行情已連線',connecting:'正在連線',error:'行情連線中斷',paused:'即時模擬已暫停',stopped:'即時模擬已結束'}[status]??'即時行情未連線');
}
function schedule(session){if(live===session&&!['paused','stopped'].includes(session.status))session.timer=setTimeout(()=>poll(session),6000);}
async function poll(session,first=false){
  if(session.fetching)return;
  session.fetching=true;
  try{
    const {symbol,interval}=session, step=frames[interval];
    const rows=await fetchBars(symbol,interval,1000);
    if(live!==session||['paused','stopped'].includes(session.status))return;
    const now=Date.now(), closed=rows.filter(c=>c.end<now), active=rows.find(c=>c.t<=now&&c.end>=now);
    if(closed.length<2||now-closed.at(-1).end>step+20000)throw new Error('最新 K 線已逾時，等待交易所更新。');
    if(first||!session.history){
      session.history=closed;
      session.last=closed.at(-1).t;
      if(active)session.accounts.forEach(x=>onOpen(x.account,active));
    }else{
      if(closed.at(-1).t<session.last)throw new Error('行情回應早於上次收盤，等待交易所更新。');
      const fresh=closed.filter(c=>c.t>session.last);
      if(fresh.length&&fresh[0].t!==session.last+step){
        session.status='paused';session.error='停留時間超過行情可補範圍，已暫停。請結束此工作階段並開新場。';return;
      }
      if(fresh.length){
        session.history.push(...fresh);
        for(const entry of session.accounts){
          const signals=computeSignals(session.history,entry.strategy);
          const start=session.history.length-fresh.length;
          fresh.forEach((c,i)=>{onOpen(entry.account,c);onClose(entry.account,c,signals[start+i],entry.strategy);});
          if(active&&active.t===fresh.at(-1).t+step)onOpen(entry.account,active);
        }
        session.last=fresh.at(-1).t;
      }else if(active&&active.t===session.last+step){
        session.accounts.forEach(x=>onOpen(x.account,active));
      }
    }
    session.price=(active??closed.at(-1)).close;session.updated=now;session.status='online';session.error='';
  }catch(e){
    if(live===session&&!['paused','stopped'].includes(session.status)){session.status='error';session.error=e.message;}
  }finally{
    session.fetching=false;
    if(live===session){updateFeed();if(selectedPage()==='live')renderLiveResults();else if(selectedPage()==='overview')render();schedule(session);}
  }
}
function startLive(){
  try{
    const symbol=paper.symbol.trim().toUpperCase(), interval=paper.interval;
    if(!/^[A-Z0-9]{5,20}$/.test(symbol))throw new Error('請輸入交易所支援的交易對，例如 BTCUSDT。');
    if(!Object.hasOwn(frames,interval))throw new Error('K 線週期不受支援。');
    const ready=runnableStrategies(paper,'live');
    const sizing=config(paper);
    const accounts=ready.map(s=>({id:s.id,name:s.name,color:s.color,strategy:structuredClone(s),account:makeAccount(sizing)}));
    live={symbol,interval,accounts,status:'connecting',error:'',updated:null,price:null};
    ledgerPage.live=0;render();poll(live,true);
  }catch(e){toast(e.message,true);}
}
function toggleLive(){
  if(!live||live.status==='stopped')return;
  if(live.status==='paused'){live.status='connecting';live.error='';poll(live);}
  else{live.status='paused';clearTimeout(live.timer);}
  updateFeed();render();
}
function stopLive(){
  if(!live)return;
  clearTimeout(live.timer);live.status='stopped';live.error='';render();
}

const stat=(title,value,caption,glyphName,cls='')=>'<div class="stat"><div class="stat-top">'+title+icon(glyphName)+'</div><div class="stat-value '+cls+'">'+value+'</div><small>'+caption+'</small></div>';
function chart(accounts){
  const curves=accounts.map(a=>({...a,curve:a.account.curve})).filter(a=>a.curve.length);
  if(!curves.length)return '<div class="chart-empty">等待第一根已收盤 K 線更新權益</div>';
  const W=740,H=236,L=16,R=66,T=16,B=30;
  let lo=0,hi=0,first=Infinity,last=-Infinity;
  for(const a of curves)for(const c of a.curve){
    const v=(c.value/a.account.capital-1)*100;
    lo=Math.min(lo,v);hi=Math.max(hi,v);first=Math.min(first,c.t);last=Math.max(last,c.t);
  }
  const margin=Math.max(.16,(hi-lo)*.11);lo-=margin;hi+=margin;
  const X=t=>L+(t-first)/Math.max(1,last-first)*(W-L-R),Y=v=>T+(hi-v)/(hi-lo)*(H-T-B);
  let lines='',axis='',paths='',areas='';
  for(let i=0;i<5;i++){
    const v=hi-i*(hi-lo)/4,y=Y(v);
    lines+='<path d="M'+L+' '+y+'H'+(W-R)+'" stroke="#e8eee8"/><text x="'+(W-R+8)+'" y="'+(y+4)+'">'+v.toFixed(1)+'%</text>';
    const t=first+i*(last-first)/4;
    if(i===0||last>first)axis+='<text text-anchor="'+(i===0?'start':i===4?'end':'middle')+'" x="'+X(t)+'" y="'+(H-8)+'">'+day(t).slice(5)+'</text>';
  }
  curves.forEach((a,i)=>{
    const stride=Math.max(1,Math.floor(a.curve.length/650));
    const points=a.curve.filter((_,j)=>j%stride===0||j===a.curve.length-1).map(c=>[X(c.t).toFixed(2),Y((c.value/a.account.capital-1)*100).toFixed(2)]);
    const d='M'+points.map(p=>p.join(' ')).join('L'), tail=points.at(-1);
    if(i===0)areas='<path fill="url(#chart-fill)" d="'+d+'L'+tail[0]+' '+(H-B)+'H'+points[0][0]+'Z"/>';
    paths+='<path d="'+d+'" fill="none" stroke="'+a.color+'" stroke-width="2" vector-effect="non-scaling-stroke"/><circle cx="'+tail[0]+'" cy="'+tail[1]+'" r="3" fill="'+a.color+'"/>';
  });
  return '<div class="legend">'+accounts.map(a=>'<span><i style="background:'+a.color+'"></i>'+esc(a.name)+'</span>').join('')+'</div><svg class="chart" viewBox="0 0 '+W+' '+H+'" role="img" aria-label="策略累積報酬率折線圖"><defs><linearGradient id="chart-fill" x2="0" y2="1"><stop stop-color="#b8dec9" stop-opacity=".45"/><stop offset="1" stop-color="#edf6ed" stop-opacity="0"/></linearGradient></defs>'+lines+areas+paths+axis+'</svg>';
}
function plotPanel(accounts,label,frame){
  return '<section class="panel"><div class="panel-head"><div><h2>策略權益曲線</h2><p>'+esc(label)+'</p></div><span class="tag neutral">'+esc(frame)+'</span></div>'+chart(accounts)+'</section>';
}
function comparison(accounts){
  return '<section class="panel table-panel"><div class="panel-head"><div><h2>策略績效比較</h2><p>各策略使用獨立的虛擬帳戶</p></div><span class="tag neutral">'+accounts.length+' 策略</span></div><div class="table-scroll"><table><thead><tr><th scope="col">策略</th><th scope="col">總報酬</th><th scope="col">淨損益</th><th scope="col">最大回撤</th><th scope="col">平倉筆數</th><th scope="col">勝率</th><th scope="col">部位</th></tr></thead><tbody>'+accounts.map(x=>{
    const a=x.account,m=metrics(a);
    return '<tr><td><span class="strategy-dot" style="background:'+x.color+'"></span>'+esc(x.name)+'</td><td class="mono '+valueClass(m.net)+'">'+pct(m.returnPct)+'</td><td class="mono '+valueClass(m.net)+'">'+money(m.net)+'</td><td class="mono">'+m.dd.toFixed(2)+'%</td><td class="mono">'+m.trades+'</td><td class="mono">'+(m.win===null?'—':m.win.toFixed(1)+'%')+'</td><td>'+(a.pos?a.pos.side===1?'多單':'空單':'空手')+(a.pending?' · 待成交':'')+'</td></tr>';
  }).join('')+'</tbody></table></div></section>';
}
function ledger(accounts,kind){
  const orders=accounts.flatMap(a=>a.account.orders.map(o=>({...o,name:a.name}))).sort((a,b)=>b.t-a.t);
  const page=Math.min(ledgerPage[kind],Math.max(0,Math.ceil(orders.length/12)-1));
  const exportBtn='<button class="button ghost" data-action="export-'+kind+'" '+(orders.length?'':'disabled')+'>'+icon('download')+'匯出 CSV</button>';
  if(!orders.length)return '<section class="panel table-panel"><div class="panel-head"><h2>逐筆成交</h2>'+exportBtn+'</div><div class="empty">目前沒有模擬成交</div></section>';
  const body=orders.slice(page*12,(page+1)*12).map(o=>'<tr><td>'+esc(o.name)+'</td><td><time title="'+new Date(o.t).toISOString()+'">'+time(o.t)+'</time></td><td>'+(o.action==='entry'?'開倉':'平倉')+' / '+(o.side===1?'多':'空')+'</td><td class="mono">'+money(o.price)+'</td><td class="mono">'+o.qty.toPrecision(5)+'</td><td class="mono">'+money(o.fee)+'</td><td class="mono '+valueClass(o.pnl)+'">'+(o.pnl===null?'—':money(o.pnl))+'</td><td>'+esc(o.reason)+'</td></tr>').join('');
  return '<section class="panel table-panel"><div class="panel-head"><div><h2>逐筆成交</h2><p>成交時間顯示為台北時間</p></div>'+exportBtn+'</div><div class="table-scroll"><table><thead><tr><th>策略</th><th>成交時間</th><th>動作</th><th>成交價</th><th>數量</th><th>費用</th><th>淨損益</th><th>原因</th></tr></thead><tbody>'+body+'</tbody></table></div><div class="pagination"><button class="button ghost" data-action="prev-'+kind+'" '+(!page?'disabled':'')+'>上一頁</button><span class="muted">'+(page+1)+' / '+Math.ceil(orders.length/12)+' · '+orders.length+' 筆</span><button class="button ghost" data-action="next-'+kind+'" '+((page+1)*12>=orders.length?'disabled':'')+'>下一頁</button></div></section>';
}
function overview(){
  const lead=result?.accounts.reduce((top,a)=>!top||metrics(a.account).net>metrics(top.account).net?a:top,null);
  const leadMetrics=lead?metrics(lead.account):null;
  const watch=strategies.slice(0,4).map((s,i)=>'<div class="watch-row"><div class="watch-icon">'+icon(['chart','activity','target','file'][i])+'</div><div><b>'+esc(s.name)+'</b><small>'+esc(s.interval??(s.type==='signals'?'資料內嵌':'不限週期'))+'</small></div><span class="tag '+(s.type==='signals'?'neutral':'')+'">'+(s.type==='signals'?'訊號':'規則')+'</span></div>').join('');
  return '<section class="hero"><span class="hero-stamp">RESEARCH TERMINAL / 01</span><svg class="hero-art" viewBox="0 0 650 240" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="hero-fade"><stop stop-color="#67d7a4" stop-opacity="0"/><stop offset="1" stop-color="#67d7a4" stop-opacity=".95"/></linearGradient><linearGradient id="hero-area" x2="0" y2="1"><stop stop-color="#76e0ac" stop-opacity=".27"/><stop offset="1" stop-color="#76e0ac" stop-opacity="0"/></linearGradient></defs><path d="M0 218L45 206 76 212 105 185 132 194 170 171 200 184 227 149 260 156 284 130 315 146 352 111 384 130 414 92 441 108 465 78 497 90 532 54 555 68 583 34 615 46 650 25V240H0Z" fill="url(#hero-area)"/><path d="M0 218L45 206 76 212 105 185 132 194 170 171 200 184 227 149 260 156 284 130 315 146 352 111 384 130 414 92 441 108 465 78 497 90 532 54 555 68 583 34 615 46 650 25" fill="none" stroke="url(#hero-fade)" stroke-width="2"/><path d="M88 240l90-26 67-6 64-39 48 12 53-18 58 9 54-38 52 5 76-43" fill="none" stroke="#82d8a0" stroke-opacity=".36" stroke-dasharray="4 6"/><circle cx="532" cy="54" r="6" fill="#98eebc"/><circle cx="532" cy="54" r="13" fill="none" stroke="#98eebc" stroke-opacity=".4"/></svg><div class="hero-copy"><p class="eyebrow">STRATEGY RESEARCH WORKSPACE</p><h1>行情實驗室</h1><p class="copy">用歷史行情驗證策略，並行觀察它們在真實行情下的表現。</p><div class="hero-actions"><a class="button light" href="#backtest">'+icon('play')+'開始回測</a><a class="button hero-link" href="#live">'+icon('activity')+'即時模擬</a></div></div></section>'+
  '<div class="section-head"><h2>工作區概況</h2><span class="mono">SIMULATION / UTC+8</span></div><section class="stats" aria-label="工作區概況">'+
  stat('策略庫',String(strategies.length).padStart(2,'0'),'已匯入的策略','layers')+
  stat('最佳回測報酬',leadMetrics?pct(leadMetrics.returnPct):'—',lead?esc(lead.name):'等待回測','chart',leadMetrics?valueClass(leadMetrics.net):'')+
  stat('已完成交易',result?String(result.accounts.reduce((n,a)=>n+metrics(a.account).trades,0)).padStart(2,'0'):'—','最近一批回測的平倉筆數','target')+
  stat('即時執行策略',String(live?.status==='online'?live.accounts.length:0).padStart(2,'0'),live?esc(live.symbol+' · '+live.interval):'等待啟動即時工作階段','activity')+
  '</section><div class="grid-main">'+(result?plotPanel(result.accounts,result.label+' · '+day(result.rows[0].t)+' 至 '+day(result.rows.at(-1).t)+' UTC',result.frame):'<section class="panel"><div class="panel-head"><h2>策略權益曲線</h2><span class="tag neutral">歷史回測</span></div><div class="empty">'+'執行歷史回測後可查看權益曲線'+'</div></section>')+
  '<section class="panel"><div class="panel-head"><div><h2>策略觀察清單</h2><p>在同一行情比較不同進出場規則</p></div><span class="tag">'+strategies.length+' 策略</span></div>'+(watch||'<div class="empty">匯入策略後會顯示在這裡</div>')+'<div class="panel-foot"><span class="muted">規則 JSON / 訊號 CSV</span><a class="text-link" href="#library">管理策略 '+icon('arrow')+'</a></div></section></div>'+(result?comparison(result.accounts):'');
}
const head=(label,title,subtitle,action='')=>'<div class="page-head"><div><p class="eyebrow">'+label+'</p><h1>'+title+'</h1><p>'+subtitle+'</p></div>'+action+'</div>';
const input=(label,key,model,type='text',attrs='')=>'<label class="field">'+label+'<input name="'+key+'" type="'+type+'" value="'+esc(model[key])+'" '+attrs+'></label>';
const options=(values,current)=>values.map(([v,l])=>'<option value="'+esc(v)+'" '+(v===current?'selected':'')+'>'+esc(l)+'</option>').join('');
const select=(label,key,values,current)=>'<label class="field">'+label+'<select name="'+key+'">'+options(values,current)+'</select></label>';
const intervalInput=model=>select('K 線週期','interval',supportedIntervals.map(k=>[k,k]),model.interval);
const sizingFields=model=>'<div class="row">'+input('每個策略本金','capital',model,'number','required min="1" step="any"')+input('部位比例 %','allocation',model,'number','required min=".01" max="100" step="any"')+'</div><div class="row">'+input('單邊手續費 %','fee',model,'number','required min="0" max="4.99" step="any"')+input('單邊滑價 %','slippage',model,'number','required min="0" max="4.99" step="any"')+'</div>';
function strategyList(model,mode){
  const plan=executionPlan(model,mode);
  const running=mode==='live'&&live&&live.status!=='stopped';
  const runningIds=new Set(running?live.accounts.map(account=>account.id):[]);
  const ready=plan.filter(entry=>!entry.reason).length;
  const heading=running?'本次已啟動 '+runningIds.size+' 個':'符合設定 '+ready+' 個';
  const rows=plan.map(({strategy,reason})=>{
    const status=runningIds.has(strategy.id)?'本次已啟動':reason||(running?'下次啟動時執行':'本次會執行');
    const style=reason&&!runningIds.has(strategy.id)?' neutral':'';
    return '<li><span>'+esc(strategy.name)+'</span><small class="tag'+style+'">'+esc(status)+'</small></li>';
  }).join('');
  return '<div class="strategy-picker"><div class="picker-head"><strong>已匯入策略</strong><span class="muted">'+heading+'</span></div>'+
    '<p class="muted">執行時會使用所有符合設定的策略，各自使用一個模擬帳戶。</p>'+
    '<button type="button" class="text-link picker-import" data-action="import">'+icon('upload')+'匯入策略檔</button>'+
    (rows?'<ul class="strategy-list">'+rows+'</ul>':'<p class="picker-empty">目前沒有匯入的策略。</p>')+'</div>';
}
function backtestPage(){
  const sources=[['','請選擇行情來源'],['binance','Binance 公開歷史行情'],...(market?[['csv',market.name]]:[]),...strategies.filter(s=>s.type==='signals').map(s=>[s.id,s.name+' · 訊號 CSV'])];
  const marketFields=!hist.source?'':hist.source==='binance'?'<div class="row">'+input('交易對','symbol',hist,'text','required maxlength="20"')+intervalInput(hist)+'</div>':intervalInput(hist);
  return head('HISTORICAL REPLAY','歷史回測','選擇同一段行情，逐根比較策略的成交與權益。')+
  '<div class="tool-grid"><section class="panel"><form id="backtest-form" class="config"><h2>回測設定</h2>'+select('行情來源','source',sources,hist.source)+
  '<button type="button" class="button ghost" data-action="market-file">'+icon('upload')+'上傳行情 CSV</button>'+marketFields+
  '<div class="row">'+input('起始日 · UTC','from',hist,'date')+input('結束日 · UTC','to',hist,'date')+'</div>'+sizingFields(hist)+strategyList(hist,'backtest')+
  '<p class="hint">收盤產生訊號，下一根開盤模擬成交。區間結束時按收盤估值。</p><button class="button primary" '+(busy?'disabled':'')+'>'+icon('play')+(busy?'回測執行中…':'執行回測')+'</button>'+(historyError?'<p class="error" role="alert">'+esc(historyError)+'</p>':'')+'</form></section>'+
  '<div>'+(result?plotPanel(result.accounts,result.label+' · '+day(result.rows[0].t)+' 至 '+day(result.rows.at(-1).t)+' UTC',result.frame)+comparison(result.accounts)+ledger(result.accounts,'backtest'):'<section class="panel"><div class="empty">匯入策略並執行回測，以查看績效與逐筆成交</div></section>')+'</div></div>';
}
function livePanel(){
  if(!live)return '<section class="panel"><div class="panel-head"><h2>即時策略帳戶</h2><span class="badge"><i></i>尚未啟動</span></div><div class="empty">啟動後會使用 Binance 公開行情更新符合設定的策略</div></section>';
  const label={online:'即時行情',connecting:'連線中',paused:'已暫停',error:'連線中斷',stopped:'已結束'}[live.status];
  return '<section class="panel"><div class="panel-head"><div><h2>'+esc(live.symbol)+' <span class="muted">'+esc(live.interval)+' · Binance 現貨</span></h2><p>'+(live.updated?'最後更新 '+time(live.updated)+' 台北時間':'等待交易所回應')+'</p></div><span class="badge '+(live.status==='online'?'online':'')+'"><i></i>'+label+'</span></div><div class="stat-value">'+(live.price===null?'—':money(live.price))+'</div>'+
  (live.error?'<p class="error" role="alert">'+esc(live.error)+'</p>':'')+(live.status==='stopped'?'':'<div class="panel-foot"><span class="muted">'+live.accounts.length+' 個虛擬帳戶</span><div class="session-controls"><button class="button ghost" data-action="toggle-live">'+(live.status==='paused'?'繼續':'暫停')+'</button><button class="button ghost" data-action="stop-live">結束</button></div></div>')+'</section>'+
  '<div class="table-panel">'+plotPanel(live.accounts,'收盤估值 · 各策略獨立帳戶',live.interval)+'</div>'+comparison(live.accounts)+ledger(live.accounts,'live');
}
function livePage(){
  const locked=live&&live.status!=='stopped';
  return head('LIVE PAPER TRADING','即時模擬','使用真實市場的 K 線，同時追蹤各策略的虛擬部位。')+
  '<div class="tool-grid"><section class="panel"><form id="live-form" class="config"><h2>模擬設定</h2>'+
  '<fieldset '+(locked?'disabled':'')+' style="border:0;padding:0;margin:0;min-width:0" class="config"><div class="row">'+input('Binance 現貨交易對','symbol',paper,'text','required maxlength="20"')+intervalInput(paper)+'</div>'+sizingFields(paper)+strategyList(paper,'live')+
  '<p class="hint">請保持此頁開啟。啟動時以既有 K 線暖機，從後續收盤開始產生訊號。</p><button class="button primary">'+icon('play')+'啟動即時模擬</button></fieldset></form></section><div id="live-results">'+livePanel()+'</div></div>';
}
function library(){
  return head('STRATEGY LIBRARY','策略庫','匯入交易規則或標準訊號檔，供歷史回測與即時模擬執行。','<button class="button primary" data-action="import">'+icon('upload')+'匯入策略</button>')+
  (strategies.length?'<div class="strategy-grid">'+strategies.map(s=>'<article class="strategy-card"><div class="panel-head"><div class="watch-icon">'+icon(s.type==='signals'?'file':'layers')+'</div><span class="tag">已匯入</span></div><h2>'+esc(s.name)+'</h2><p class="muted">'+(s.type==='signals'?s.candles.length.toLocaleString()+' 根帶訊號的 K 線 · 歷史回測':esc((s.interval??'不限週期')+' · '+(s.side==='long'?'做多':'多空')+' · '+Object.keys(s.indicators).length+' 個指標'))+'</p><div class="panel-foot"><button class="danger-button" data-action="remove-strategy" data-id="'+esc(s.id)+'">移除</button>'+'</div></article>').join('')+'</div>':'<div class="empty">匯入策略檔後即可執行。</div>');
}
function guide(){
  return head('DATA & EXECUTION','策略格式與成交規則','兩種模式都執行符合設定的已匯入策略，並使用同一個成交模型。')+
  '<div class="guide-grid"><section class="panel"><h2>規則 JSON</h2><p><code>version: 1</code>、<code>name</code>、<code>side</code>（<code>long</code> 或 <code>both</code>）為必填。可選 <code>interval</code>、<code>warmup</code>、<code>stopPct</code>、<code>takePct</code>。</p><p>指標可用 <code>sma</code>、<code>ema</code>、<code>rsi</code>、<code>high</code>、<code>low</code>。每個指標指定 <code>period</code>，可選 <code>source</code>，預設 <code>close</code>。<code>high</code> / <code>low</code> 取前 N 根，不含本根。</p><p>請填寫策略名稱和至少一組進場條件。每組訊號的條件全數成立才觸發。運算子支援 <code>above</code>、<code>below</code>、<code>gte</code>、<code>lte</code>、<code>crossAbove</code>、<code>crossBelow</code>。</p><button class="button ghost" data-action="template">'+icon('download')+'下載 JSON 範本</button><pre>'+esc(JSON.stringify(template,null,2))+'</pre></section>'+
  '<div class="stack"><section class="panel"><h2>歷史行情與 Python 訊號</h2><p>行情 CSV 欄位為 <code>timestamp,open,high,low,close,volume</code>。時間戳使用含時區的 ISO 8601 或 Unix 秒／毫秒／微秒，以開盤時間標記。資料必須已收盤、遞增且符合所選週期。</p><p>現有 BTC 專案可先在 Python 呼叫 <code>generate_signals(candles)</code>，將行情和以下旗標匯出為 CSV，再從策略庫匯入。OHLCV 完全相同的訊號 CSV 可一起回測。</p><pre>'+flags.join(', ')+'</pre><p>已匯入的規則 JSON 存於此瀏覽器。CSV 資料與即時模擬帳戶在此頁工作階段內有效。</p></section>'+
  '<section class="panel"><h2>成交及帳務</h2><p>每策略單一部位。訊號於已收盤 K 線決定，下一根開盤加上滑價後模擬成交。出場後等後續收盤再評估進場。同時出現多空進場時跳過。只有匯入的規則 JSON 指定停損或停利時，才會依相對成交價的變動產生出場指令。</p><p>回測可模擬 1 倍名義部位的多空；即時模式目前支援 Binance 現貨做多。盈虧含雙邊費用，權益按收盤估值。模型不含資金費、強平、部分成交、委託簿或槓桿保證金。</p><p>暫停或短暫斷線後，恢復時會按交易所可取回的 K 線補跑；資料缺口超出可補範圍便暫停。</p><a class="text-link" href="https://github.com/binance/binance-spot-api-docs/blob/master/faqs/market_data_only.md" target="_blank" rel="noopener">Binance 行情文件 '+icon('arrow')+'</a></section></div></div>';
}

function renderLiveResults(){
  const el=$('live-results');if(el)el.innerHTML=livePanel();
}
function render(){
  const page=selectedPage();
  $('crumb').textContent=names[page];
  document.querySelectorAll('.rail nav a').forEach(a=>{
    const active=a.dataset.page===page;
    a.classList.toggle('active',active);if(active)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');
  });
  updateFeed();
  $('main').innerHTML={overview,backtest:backtestPage,live:livePage,library,guide}[page]();
}
function capture(form,model){
  const data=new FormData(form);
  for(const [key,value] of data)model[key]=value;
}
$('main').addEventListener('input',e=>{
  const form=e.target.form;
  if(!form)return;
  const model=form.id==='backtest-form'?hist:paper;
  if(e.target.name)model[e.target.name]=e.target.value;
});
$('main').addEventListener('change',e=>{
  if(e.target.name==='source'){
    setHistorySource(e.target.value);
    historyError='';render();
  }else if(e.target.name==='interval')render();
});
$('main').addEventListener('submit',e=>{
  e.preventDefault();
  if(e.target.id==='backtest-form'){capture(e.target,hist);backtest();}
  else if(e.target.id==='live-form'){capture(e.target,paper);startLive();}
});
$('main').addEventListener('click',e=>{
  const btn=e.target.closest('[data-action]');if(!btn)return;
  const {action,id}=btn.dataset;
  const s=strategies.find(x=>x.id===id);
  if(action==='import')openImport();
  else if(action==='template')$('template').click();
  else if(action==='market-file')$('market-file').click();
  else if(action==='toggle-live')toggleLive();
  else if(action==='stop-live')stopLive();
  else if(action==='remove-strategy'&&s){
    const next=strategies.filter(x=>x.id!==id);
    try{localStorage.setItem('market-replay-strategies-v1',JSON.stringify(next.filter(x=>x.type!=='signals')));}catch(err){toast(err.message,true);return;}
    strategies.splice(strategies.indexOf(s),1);
    if(hist.source===id)setHistorySource('');
    render();toast('已移除 '+s.name);
  }else if(action.startsWith('export-')){
    const kind=action.slice(7), data=kind==='live'?live:result;
    if(data)download(kind+'-trades.csv',ledgerCsv(data.accounts),'text/csv;charset=utf-8');
  }else if(/^(prev|next)-(live|backtest)$/.test(action)){
    const [op,kind]=action.split('-');
    ledgerPage[kind]=Math.max(0,ledgerPage[kind]+(op==='next'?1:-1));
    if(kind==='live')renderLiveResults();else render();
  }
});
window.addEventListener('hashchange',()=>{render();window.scrollTo(0,0);});
render();
