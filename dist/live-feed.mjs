const spotSocket='wss://data-stream.binance.vision/stream?streams=';
const futuresSocket='wss://fstream.binance.com/market/stream?streams=';
const historyLimit=1000;
const idleMs=20000;

export function connectMarketFeed({symbol,interval,market='spot',step,lastClosed,fetchHistory,onBars,onTrade,onStatus,warmupLimit=historyLimit}){
  let socket,retryTimer,watchdog,request,stopped=false,retries=0;

  function disconnect(){
    clearTimeout(watchdog);
    request?.abort();
    request=null;
    const old=socket;
    socket=null;
    old?.close();
  }

  function retry(message){
    disconnect();
    if(stopped)return;
    onStatus('error',message);
    retryTimer=setTimeout(connect,Math.min(30000,1000*2**Math.min(retries++,5)));
  }

  function connect(){
    onStatus('connecting','');
    const stream=symbol.toLowerCase();
    const futures=market==='futures';
    const tradeType=futures?'aggTrade':'trade';
    const kline=stream+'@kline_'+interval;
    const streams=onTrade?stream+'@'+tradeType+'/'+kline:kline;
    const ws=new WebSocket((futures?futuresSocket:spotSocket)+streams);
    socket=ws;
    let synced=false,buffer=null;

    function armWatchdog(){
      clearTimeout(watchdog);
      watchdog=setTimeout(()=>retry('行情更新逾時，正在重連。'),idleMs);
    }

    function emit(events,warmup=null){
      const closed=[];
      let active=null,last=warmup?.at(-1)?.t??lastClosed();
      for(const row of events){
        if(row.t<=last)continue;
        if(row.t!==last+step)throw new Error('偵測到 K 線缺口，正在重新同步。');
        if(row.closed){
          closed.push(row);
          last=row.t;
          active=null;
        }else active=row;
      }
      onBars(warmup,closed,active);
    }

    async function sync(first){
      buffer=new Map([[first.t,first]]);
      const previous=lastClosed();
      const missing=previous===null?warmupLimit:(first.t-previous)/step-1;
      if(previous!==null&&missing>historyLimit){
        disconnect();
        onStatus('paused','行情缺口超過 1,000 根 K 線。請結束本次模擬並重新啟動。');
        return;
      }
      try{
        if(previous!==null&&first.t<=previous){
          buffer=null;
          return;
        }
        if(!Number.isInteger(missing)||missing<0)throw new Error('無法對齊即時 K 線。');
        request=new AbortController();
        const signal=AbortSignal.any([request.signal,AbortSignal.timeout(12000)]);
        const rows=missing?await fetchHistory(missing,previous===null?undefined:previous+step,first.t-1,signal):[];
        if(socket!==ws||stopped)return;
        request=null;
        if(missing&&(rows.at(-1)?.t!==first.t-step||
          (previous===null?rows.length<2:rows.length!==missing||rows[0].t!==previous+step))){
          throw new Error('補齊 K 線尚未完成，正在重試。');
        }
        const events=[...buffer.values()].sort((a,b)=>a.t-b.t);
        if(previous===null)emit(events,rows);
        else emit([...rows.map(row=>({...row,closed:true})),...events]);
        buffer=null;
        synced=true;
        retries=0;
        onStatus('online','');
      }catch(error){
        if(socket===ws&&!stopped)retry(error.message);
      }
    }

    armWatchdog();
    ws.addEventListener('message',event=>{
      if(socket!==ws||stopped)return;
      let payload;
      try{payload=JSON.parse(event.data);}catch{return;}
      payload=payload?.data??payload;
      if(payload?.e==='serverShutdown'){retry('交易所即將關閉連線，正在重連。');return;}
      if(onTrade&&payload?.e===tradeType&&payload.s===symbol){
        const price=Number(payload.p), id=futures?payload.a:payload.t;
        if(Number.isFinite(price)&&price>0&&Number.isSafeInteger(id)&&id>=0&&
          Number.isSafeInteger(payload.T)&&Math.abs(payload.T)<=8640000000000000){
          onTrade({id,price,time:payload.T});
        }
        return;
      }
      const k=payload?.k;
      if(payload?.e!=='kline'||k?.s!==symbol||k.i!==interval||typeof k.x!=='boolean')return;
      const row={t:k.t,open:+k.o,high:+k.h,low:+k.l,close:+k.c,volume:+k.v,closed:k.x};
      if(!Number.isSafeInteger(row.t)||![row.open,row.high,row.low,row.close,row.volume].every(Number.isFinite)||
        row.low<=0||row.high<Math.max(row.open,row.close)||row.low>Math.min(row.open,row.close)||row.volume<0)return;
      armWatchdog();
      if(buffer){
        if(!buffer.get(row.t)?.closed)buffer.set(row.t,row);
      }else if(!synced)void sync(row);
      else{
        try{emit([row]);}catch(error){retry(error.message);}
      }
    });
    ws.addEventListener('error',()=>{if(socket===ws&&!stopped)retry('WebSocket 行情連線中斷，正在重連。');});
    ws.addEventListener('close',()=>{if(socket===ws&&!stopped)retry('WebSocket 行情連線已關閉，正在重連。');});
  }

  connect();
  return ()=>{
    stopped=true;
    clearTimeout(retryTimer);
    disconnect();
  };
}
