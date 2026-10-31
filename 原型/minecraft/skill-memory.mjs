import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {validatePlan} from './skill-knowledge.mjs';

// 保存经过实际执行的步骤经验，不保存坐标、凭据或“旧世界已建成”的标记。
export class SkillMemory {
  constructor(file=null){this.file=file;this.entries=[];try{const data=JSON.parse(readFileSync(file,'utf8'));for(const e of data.entries||[]){
    const plan=validatePlan(e);if(plan.lookup)continue;
    this.entries.push({...plan,successes:Math.max(0,Math.min(10000,Number(e.successes)||0)),failures:Math.max(0,Math.min(10000,Number(e.failures)||0)),result:String(e.result||'').slice(0,200)});
  }this.entries=this.entries.slice(-40);}catch{}}
  record(plan,ok,result){
    if(plan.steps.every(s=>['wait','explore'].includes(s.skill)))return;
    const clean=validatePlan(plan),key=JSON.stringify(clean.steps);
    let e=this.entries.find(e=>JSON.stringify(e.steps)===key);
    if(!e){e={...clean,successes:0,failures:0};this.entries.push(e);}
    e[ok?'successes':'failures']++;e.result=String(result).slice(0,200);this.entries=this.entries.slice(-40);
    if(this.file){mkdirSync(dirname(this.file),{recursive:true});const tmp=this.file+'.tmp';writeFileSync(tmp,JSON.stringify({version:1,entries:this.entries},null,2));renameSync(tmp,this.file);}
  }
  context(){return this.entries.slice(-10);}
  snapshot(){return {verified:this.entries.filter(e=>e.successes>0).length,attempted:this.entries.length,recent:this.entries.slice(-4)};}
}
