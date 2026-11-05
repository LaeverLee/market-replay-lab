async function request(path, method='GET', payload){
  let response;
  try{
    response=await fetch('/api/'+path,{
      method,
      ...(payload===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
    });
  }catch{throw new Error('無法連線本機後端。');}
  if(!response.headers.get('Content-Type')?.includes('application/json'))throw new Error('請透過本機後端開啟行情實驗室。');
  const data=await response.json();
  if(!response.ok)throw new Error(data.error??'後端請求失敗。');
  return data;
}
export const strategyApi={
  list:()=>request('strategies'),
  add:items=>request('strategies','POST',items),
  remove:id=>request('strategies/'+encodeURIComponent(id),'DELETE')
};
export const backtestApi=input=>request('backtests','POST',input);
