import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateStrategy} from '../dist/engine.mjs';
import {fileStrategyRepository} from './strategy-repository.mjs';
import {runHistoricalBacktest} from './backtest-service.mjs';

const port=Number(process.env.MARKET_REPLAY_PORT??8783);
const host='127.0.0.1';
const origin='http://'+host+':'+port;
const frontend=fileURLToPath(new URL('../dist/',import.meta.url));
const repository=fileStrategyRepository(join(process.env.MARKET_REPLAY_DATA_DIR??
  join(process.env.LOCALAPPDATA??homedir(),'MarketReplayLab'),'strategies.json'));
const assets=new Map([
  ['/','index.html'],['/index.html','index.html'],['/style.css','style.css'],
  ['/icon.svg','icon.svg'],['/app.mjs','app.mjs'],['/api.mjs','api.mjs'],
  ['/engine.mjs','engine.mjs'],['/live-feed.mjs','live-feed.mjs']
]);
const types={html:'text/html; charset=utf-8',css:'text/css; charset=utf-8',svg:'image/svg+xml',mjs:'text/javascript; charset=utf-8'};
const strategyId=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function json(response,status,body){
  response.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});
  response.end(JSON.stringify(body));
}
async function body(request,max){
  if(!/^application\/json(?:;|$)/i.test(request.headers['content-type']??''))throw new Error('只接受 JSON。');
  const chunks=[];
  let size=0;
  for await(const chunk of request){
    size+=chunk.length;
    if(size>max)throw new Error('請求超過資料上限。');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

createServer(async(request,response)=>{
  response.setHeader('Cache-Control','no-store');
  response.setHeader('X-Content-Type-Options','nosniff');
  if(request.headers.host!==host+':'+port)return json(response,403,{error:'請使用本機網址。'});
  const path=new URL(request.url,origin).pathname;
  const method=request.method;
  if(method!=='GET'&&method!=='HEAD'&&request.headers.origin&&request.headers.origin!==origin){
    return json(response,403,{error:'來源不符。'});
  }
  try{
    if(path==='/api/health'&&method==='GET')return json(response,200,{ok:true});
    if(path==='/api/strategies'&&method==='GET')return json(response,200,repository.list());
    if(path==='/api/strategies'&&method==='POST'){
      const items=await body(request,8*1024*1024);
      if(!Array.isArray(items)||items.length>1000)throw new Error('策略清單格式有誤。');
      const rules=items.map(item=>{
        if(!strategyId.test(item?.id??'')||!/^#[0-9a-f]{6}$/i.test(item.color??''))throw new Error('策略識別碼或顏色有誤。');
        return {...validateStrategy(item),id:item.id,color:item.color};
      });
      return json(response,200,repository.addMissing(rules));
    }
    if(path.startsWith('/api/strategies/')&&method==='DELETE'){
      const id=path.slice('/api/strategies/'.length);
      if(!strategyId.test(id))throw new Error('策略識別碼有誤。');
      repository.remove(id);
      return json(response,200,{ok:true});
    }
    if(path==='/api/backtests'&&method==='POST'){
      const input=await body(request,96*1024*1024);
      return json(response,200,{accounts:runHistoricalBacktest(input,repository.list())});
    }
    const asset=assets.get(path);
    if(!asset||!['GET','HEAD'].includes(method))return json(response,404,{error:'找不到資源。'});
    const content=await readFile(join(frontend,asset));
    response.writeHead(200,{'Content-Type':types[asset.split('.').at(-1)]});
    response.end(method==='GET'?content:undefined);
  }catch(error){
    const internal=Boolean(error.code);
    if(internal)console.error(error);
    if(!response.headersSent)json(response,internal?500:400,{error:internal?'本機伺服器讀寫失敗。':error.message});
  }
}).listen(port,host,()=>console.log('Market Replay Lab: '+origin));
