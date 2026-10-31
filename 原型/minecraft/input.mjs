import { parseTask } from './tasks.mjs';
// 两只 bot 会收到同一条游戏聊天；只接收指定玩家，且去重，绝不把 bot 回声当指令。
export class GameInput {
  constructor({controller,bots,onInput,now=Date.now}){Object.assign(this,{controller,bots,onInput,now});this.seen=new Map();}
  receive(player,text){
    if(player!==this.controller||this.bots.includes(player)||typeof text!=='string'||!text.trim()||text.length>180||text.startsWith('/'))return false;
    for(const [key,time] of this.seen)if(this.now()-time>=2000)this.seen.delete(key);
    const key=player+'\n'+text;if(this.seen.has(key))return false;this.seen.set(key,this.now());
    this.onInput(text,player,parseTask(text,player));return true;
  }
}
