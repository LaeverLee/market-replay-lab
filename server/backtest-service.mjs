import {frames, flags, validateCandles, runBacktest, makeAccount} from '../dist/engine.mjs';

export function runHistoricalBacktest(input, rules) {
  const {frame, rows, strategyIds, signalStrategies, sizing}=input;
  const from=input.from??-Infinity, to=input.to??Infinity;
  if(!Object.hasOwn(frames,frame)||!Array.isArray(rows)||rows.length>100000||
     !(from<to)||(input.from!=null&&!Number.isSafeInteger(from))||(input.to!=null&&!Number.isSafeInteger(to))){
    throw new Error('回測週期、區間或行情資料無效。');
  }
  makeAccount(sizing);
  validateCandles(rows,frames[frame]);
  const period=rows.filter(row=>row.t>=from&&row.t<to);
  if(period.length<2)throw new Error('所選區間至少需有兩根已收盤 K 線。');
  if(!Array.isArray(strategyIds)||!Array.isArray(signalStrategies)||
     strategyIds.length+signalStrategies.length<1)throw new Error('請選擇適用策略。');

  const byId=new Map(rules.map(rule=>[rule.id,rule]));
  const selected=strategyIds.map(id=>{
    const rule=byId.get(id);
    const allowed=rule?.intervals??(rule?.interval?[rule.interval]:Object.keys(frames));
    if(!rule||!allowed.includes(frame))throw new Error('策略已移除或不支援本次週期，請更新策略庫。');
    return {strategy:rule,candles:rows};
  });
  for(const {id,name,color,signals} of signalStrategies) {
    if(typeof id!=='string'||typeof name!=='string'||typeof color!=='string'||!Array.isArray(signals)||
       signals.length!==rows.length||signals.some(entry=>!entry||flags.some(flag=>typeof entry[flag]!=='boolean'))){
      throw new Error('訊號 CSV 必須與回測 K 線一一對應。');
    }
    selected.push({strategy:{id,name,color,type:'signals'},candles:rows.map((row,i)=>({...row,signals:signals[i]}))});
  }
  return selected.map(({strategy,candles})=>({
    id:strategy.id,name:strategy.name,color:strategy.color,
    account:runBacktest(candles,strategy,sizing,from,to)
  }));
}
