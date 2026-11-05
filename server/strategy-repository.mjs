import {readFileSync, writeFileSync, renameSync, mkdirSync} from 'node:fs';
import {dirname} from 'node:path';

export function fileStrategyRepository(path) {
  mkdirSync(dirname(path), {recursive:true});
  function list() {
    try { return JSON.parse(readFileSync(path,'utf8')); }
    catch (error) { if(error.code==='ENOENT')return []; throw error; }
  }
  function save(items) {
    writeFileSync(path+'.tmp',JSON.stringify(items,null,2)+'\n',{mode:0o600});
    renameSync(path+'.tmp',path);
  }
  return {
    list,
    addMissing(items) {
      const current=new Map(list().map(item=>[item.id,item]));
      for(const item of items)if(!current.has(item.id))current.set(item.id,item);
      const all=[...current.values()];
      save(all);
      return all;
    },
    remove(id) { save(list().filter(item=>item.id!==id)); }
  };
}
