export const frames = {'1m':60000,'5m':300000,'15m':900000,'30m':1800000,'1h':3600000,'4h':14400000,'1d':86400000};
export const flags = ['enter_long','exit_long','enter_short','exit_short'];
const fields = ['open','high','low','close','volume'];
const ops = ['above','below','gte','lte','crossAbove','crossBelow'];
export const builtins = [
  {name:'雙均線趨勢',id:'trend',version:1,side:'long',warmup:26,indicators:{fast:{type:'ema',period:9},slow:{type:'ema',period:26}},enter_long:[['fast','crossAbove','slow']],exit_long:[['fast','crossBelow','slow']]},
  {name:'RSI 均值回歸',id:'rsi',version:1,side:'long',warmup:15,indicators:{rsi:{type:'rsi',period:14}},enter_long:[['rsi','crossAbove',30]],exit_long:[['rsi','crossAbove',60]],stopPct:3,takePct:6},
  {name:'區間突破',id:'breakout',version:1,side:'long',warmup:21,indicators:{top:{type:'high',period:20,source:'high'},floor:{type:'low',period:10,source:'low'}},enter_long:[['close','above','top']],exit_long:[['close','below','floor']]}
];
const fail = message => { throw new Error(message); };
export function validateStrategy(s) {
  if (!s || s.version !== 1 || typeof s.name !== 'string' || !s.name.trim() || s.name.length > 80 || !['long','both'].includes(s.side)) fail('策略需包含 version: 1、name（1–80 字）與 side（long / both）。');
  const allowed = ['name','version','side','interval','warmup','indicators','stopPct','takePct','id','color','builtin',...flags];
  const unknown = Object.keys(s).find(key=>!allowed.includes(key));
  if (unknown) fail('不支援的策略欄位：'+unknown);
  if (s.warmup !== undefined && (!Number.isInteger(s.warmup) || s.warmup < 0 || s.warmup > 500)) fail('warmup 必須為 0–500 的整數。');
  if (s.interval !== undefined && !Object.hasOwn(frames,s.interval)) fail('策略 interval 不受支援。');
  const indicators = s.indicators ?? {};
  if (!indicators || typeof indicators !== 'object' || Array.isArray(indicators) || Object.keys(indicators).length > 20) fail('indicators 必須為物件，最多 20 個。');
  for (const [id,d] of Object.entries(indicators)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,30}$/.test(id) || fields.includes(id) || !d || !['sma','ema','rsi','high','low'].includes(d.type) || !Number.isInteger(d.period) || d.period < 2 || d.period > 500 || !fields.includes(d.source ?? 'close')) fail('指標設定有誤：'+id);
  }
  const operand = value => Number.isFinite(value) || fields.includes(value) || Object.hasOwn(indicators,value);
  const out = {name:s.name.trim(),version:1,side:s.side,warmup:s.warmup??0,indicators,...(s.interval ? {interval:s.interval} : {})};
  for (const key of flags) {
    const rules = s[key] ?? [];
    if (!Array.isArray(rules) || rules.length > 16 || rules.some(r=>!Array.isArray(r)||r.length!==3||!operand(r[0])||!ops.includes(r[1])||!operand(r[2]))) fail('條件格式有誤：'+key);
    if (s.side==='long' && key.endsWith('short') && rules.length) fail('含空單條件時 side 需設為 both。');
    out[key]=rules;
  }
  if (!out.enter_long.length && !out.enter_short.length) fail('請設定至少一組進場條件。');
  for (const key of ['stopPct','takePct']) {
    if (s[key]!==undefined && (!Number.isFinite(s[key]) || s[key]<=0 || s[key]>=100)) fail(key+' 需大於 0 且小於 100。');
    if (s[key]!==undefined) out[key]=s[key];
  }
  return out;
}
function csvRows(source) {
  const rows=[]; let row=[], value='', quoted=false;
  for(let i=0;i<source.length;i++){
    const c=source[i];
    if(quoted){if(c==='"'&&source[i+1]==='"'){value+='"';i++;}else if(c==='"'){quoted=false;}else{value+=c;}continue;}
    if(c==='"'&&!value){quoted=true;continue;}
    if(c===','){row.push(value.trim());value='';continue;}
    if(c==='\r'||c==='\n'){row.push(value.trim());if(row.some(Boolean))rows.push(row);row=[];value='';if(c==='\r'&&source[i+1]==='\n')i++;continue;}
    value+=c;
  }
  if(quoted) fail('CSV 有未關閉的引號。');
  row.push(value.trim());if(row.some(Boolean))rows.push(row);
  return rows;
}
function timestamp(value) {
  if (/^\d{10}$|^\d{13}$|^\d{16}$/.test(value)) return Number(value) * (value.length===10?1000:value.length===16?0.001:1);
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return NaN;
  return Date.parse(value);
}
export function parseCandles(source) {
  const [columns,...rows] = csvRows(source.replace(/^\uFEFF/,''));
  if(!columns || !rows.length || rows.length>100000) fail('CSV 需要 1–100,000 根 K 線。');
  const header=columns.map(x=>x.toLowerCase());
  if(new Set(header).size!==header.length) fail('CSV 欄名重複。');
  const required=['timestamp',...fields];
  if(required.some(x=>!header.includes(x))) fail('CSV 需有 timestamp, open, high, low, close, volume。');
  const n=flags.filter(x=>header.includes(x)).length;
  if(n && n!==4) fail('訊號 CSV 須含完整四欄進出場旗標。');
  const candles=rows.map((row,i)=>{
    const label='第 '+(i+2)+' 列';
    if(row.length!==header.length) fail(label+' 欄數不一致。');
    const get=k=>row[header.indexOf(k)];
    const c={t:timestamp(get('timestamp'))};
    for(const k of fields)c[k]=get(k)===''?NaN:Number(get(k));
    if(header.includes('is_closed')&&!['true','1'].includes(get('is_closed').toLowerCase())) fail(label+' 尚未收盤。');
    if(n)c.signals=Object.fromEntries(flags.map(k=>{
      const v=get(k).toLowerCase();
      if(!['true','false','1','0'].includes(v)) fail(label+' 訊號需為 true / false 或 1 / 0。');
      return [k,v==='true'||v==='1'];
    }));
    return c;
  });
  validateCandles(candles);
  return {candles,hasSignals:!!n};
}
export function validateCandles(rows,step=0) {
  for(let i=0;i<rows.length;i++){
    const c=rows[i], prev=rows[i-1];
    if(!Number.isSafeInteger(c.t)||fields.some(k=>!Number.isFinite(c[k]))||c.low<=0||c.volume<0||c.high<Math.max(c.open,c.close,c.low)||c.low>Math.min(c.open,c.close)) fail('無效 OHLCV 或 timestamp，第 '+(i+1)+' 根。');
    if(prev&&(c.t<=prev.t||(step&&c.t-prev.t!==step))) fail('時間戳重複、倒序或行情缺根，第 '+(i+1)+' 根。');
  }
}
export function computeSignals(rows,strategy) {
  if(strategy.type==='signals') return rows.map(c=>c.signals);
  const series=Object.fromEntries(fields.map(k=>[k,rows.map(c=>c[k])]));
  for(const [id,d] of Object.entries(strategy.indicators)){
    const src=series[d.source??'close'], values=new Array(rows.length), n=d.period;
    let sum=0, gain=0, loss=0, ema;
    for(let i=0;i<src.length;i++){
      const x=src[i];
      if(d.type==='rsi'){
        if(!i)continue;
        const diff=x-src[i-1], up=Math.max(diff,0), down=Math.max(-diff,0);
        if(i<=n){gain+=up/n;loss+=down/n;}else{gain=(gain*(n-1)+up)/n;loss=(loss*(n-1)+down)/n;}
        if(i>=n)values[i]=gain+loss===0?50:100*gain/(gain+loss);
      }else if(d.type==='high'||d.type==='low'){
        if(i>=n){let value=src[i-n];for(let j=i-n+1;j<i;j++)value=d.type==='high'?Math.max(value,src[j]):Math.min(value,src[j]);values[i]=value;}
      }else{
        sum+=x-(i>=n?src[i-n]:0);
        if(i>=n-1){
          if(d.type==='ema')ema=ema===undefined?sum/n:ema+2/(n+1)*(x-ema);
          values[i]=d.type==='ema'?ema:sum/n;
        }
      }
    }
    series[id]=values;
  }
  const read=(x,i)=>typeof x==='number'?x:series[x]?.[i];
  return rows.map((_,i)=>Object.fromEntries(flags.map(key=>{
    const rules=strategy[key]??[];
    return [key,i>=strategy.warmup&&rules.length>0&&rules.every(([left,op,right])=>{
      const a=read(left,i),b=read(right,i);
      if(!Number.isFinite(a)||!Number.isFinite(b))return false;
      switch(op){
        case 'above':return a>b;
        case 'below':return a<b;
        case 'gte':return a>=b;
        case 'lte':return a<=b;
        case 'crossAbove':return a>b&&read(left,i-1)<=read(right,i-1);
        case 'crossBelow':return a<b&&read(left,i-1)>=read(right,i-1);
      }
    })];
  })));
}
export function makeAccount(config) {
  const {capital,fee,slippage,allocation}=config;
  if(![capital,fee,slippage,allocation].every(Number.isFinite)||capital<1||fee<0||fee>=5||slippage<0||slippage>=5||allocation<=0||allocation>100) fail('本金、部位比例、手續費或滑價超出範圍。');
  return {capital,cash:capital,fee:fee/100,slip:slippage/100,allocation:allocation/100,pos:null,orders:[],curve:[],equity:capital,peak:capital,drawdown:0,lastClose:null,lastOpen:null,pending:null};
}
export function onOpen(a,c) {
  if(a.lastOpen!==null&&c.t<=a.lastOpen)return;
  a.lastOpen=c.t;
  const order=a.pending;
  a.pending=null;
  if(!order)return;
  if(order.action==='exit'&&a.pos){
    const p=a.pos, price=c.open*(1-p.side*a.slip), pnl=p.side*(price-p.price)*p.qty, fee=price*p.qty*a.fee;
    a.cash+=pnl-fee;
    a.orders.push({...order,t:c.t,side:p.side,price,qty:p.qty,fee,pnl:pnl-fee-p.fee});
    a.pos=null;
  }else if(order.action==='entry'&&!a.pos&&a.cash>0){
    const price=c.open*(1+order.side*a.slip), notional=a.cash*a.allocation/(1+a.fee), qty=notional/price, fee=notional*a.fee;
    a.cash-=fee;
    a.pos={side:order.side,price,qty,fee,t:c.t};
    a.orders.push({...order,t:c.t,price,qty,fee,pnl:null});
  }
}
export function onClose(a,c,signals={},strategy={}) {
  if(a.lastClose!==null&&c.t<=a.lastClose)return;
  a.lastClose=c.t;
  const p=a.pos;
  a.equity=a.cash+(p?p.side*(c.close-p.price)*p.qty:0);
  a.peak=Math.max(a.peak,a.equity);
  a.drawdown=Math.max(a.drawdown,(a.peak-a.equity)/a.peak);
  a.curve.push({t:c.t,value:a.equity});
  if(p){
    const move=p.side*(c.close/p.price-1)*100;
    const reason=move<=-(strategy.stopPct??Infinity)?'收盤停損':move>=(strategy.takePct??Infinity)?'收盤停利':(p.side===1?signals.exit_long:signals.exit_short)?'策略出場':null;
    if(reason)a.pending={action:'exit',signal:c.t,reason};
  }else if(Boolean(signals.enter_long)!==Boolean(signals.enter_short)){
    a.pending={action:'entry',side:signals.enter_long?1:-1,signal:c.t,reason:'策略進場'};
  }
}
export function runBacktest(rows,strategy,config,from=-Infinity,to=Infinity) {
  const a=makeAccount(config), signals=computeSignals(rows,strategy);
  for(let i=0;i<rows.length;i++){
    const c=rows[i];
    if(c.t<from||c.t>=to)continue;
    onOpen(a,c);onClose(a,c,signals[i],strategy);
  }
  return a;
}
export function metrics(a) {
  const exits=a.orders.filter(o=>o.action==='exit');
  return {returnPct:(a.equity/a.capital-1)*100,net:a.equity-a.capital,trades:exits.length,win:exits.length?100*exits.filter(x=>x.pnl>0).length/exits.length:null,dd:a.drawdown*100};
}
export function ledgerCsv(accounts) {
  const header='strategy,timestamp,signal_bar_timestamp,action,side,price,quantity,fee,net_closed_pnl,reason';
  const quote=x=>'"'+String(x).replaceAll('"','""')+'"';
  return [header,...accounts.flatMap(a=>a.account.orders.map(o=>[quote(/^[=+\-@\t\r\n]/.test(a.name)?"'"+a.name:a.name),new Date(o.t).toISOString(),new Date(o.signal).toISOString(),o.action,o.side===1?'long':'short',o.price,o.qty,o.fee,o.pnl??'',quote(o.reason)].join(',')))].join('\r\n');
}

