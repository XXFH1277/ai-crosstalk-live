// 每个空闲小段只有两句。选题和游戏任务分离，打断后不续旧包袱。
export class GameLeisure {
  constructor({topics,now=Date.now,memory={},save=()=>{},random=Math.random}){
    Object.assign(this,{topics,now,save,random});this.used=memory.used||[];this.categories=memory.categories||[];
    this.enabled=true;this.audienceEnabled=true;this.queue=[];this.current=null;this.nextTopicAt=now()+12000;this.nextAudienceAt=0;
  }
  cancel(){this.current=null;this.nextTopicAt=this.now()+12000;}
  accept(event){if(event&&event.expiresAt>this.now()&&!this.queue.some(e=>e.id===event.id)){this.queue.push(event);this.queue=this.queue.slice(-8);}}
  safe(world){return world.every(w=>!w.danger&&!(w.health<12)&&w.status==='已入服'&&!(w.mission?.status==='执行中'&&w.mission.stage==='fight')&&!(w.nearby||[]).some(e=>e.distance<8&&/^(zombie|husk|drowned|skeleton|stray|creeper|spider|witch|pillager|vindicator|warden)$/.test(e.name)));}
  pickTopic(){
    // 带 scenes 的是直播专场卡（如万圣夜，要小克/豆姐上台），游戏里只有深深月月，不抽。
    const month=new Date(this.now()).getMonth()+1,pool=this.topics.filter(t=>!t.scenes&&(!t.months||t.months.includes(month)));
    if(!pool.length)return null;
    let unused=pool.filter(t=>!this.used.includes(t.id));
    if(!unused.length){const keep=Math.min(20,pool.length-1);this.used=keep?this.used.slice(-keep):[];unused=pool.filter(t=>!this.used.includes(t.id));}
    const fresh=unused.filter(t=>!this.categories.slice(-3).includes(t.category));
    const choices=fresh.length?fresh:unused,topic=choices[Math.floor(this.random()*choices.length)];
    this.used.push(topic.id);this.categories.push(topic.category);this.categories=this.categories.slice(-3);
    this.save({used:this.used,categories:this.categories});return topic;
  }
  choose(world,pacing,{player=false,occupied=false}={}){
    this.queue=this.queue.filter(e=>e.expiresAt>this.now());
    if(!this.safe(world)||player){this.cancel();return null;}
    if(this.current&&this.current.expiresAt<=this.now())this.current=null;
    if(this.current)return {...this.current,remaining:this.current.remaining};
    if(occupied||pacing.allowSpeech)return null;
    if(this.audienceEnabled&&this.queue.length&&this.now()>=this.nextAudienceAt){
      const i=this.queue.findIndex(e=>e.kind==='gift'),event=this.queue.splice(i<0?0:i,1)[0];
      this.current={kind:event.kind,event,remaining:2,expiresAt:event.expiresAt};this.nextAudienceAt=this.now()+8000;
    }else if(this.enabled&&this.now()>=this.nextTopicAt){
      const topic=this.pickTopic();if(!topic)return null;
      this.current={kind:'comedy',topic,remaining:2,expiresAt:this.now()+45000};this.nextTopicAt=this.now()+12000;
    }
    return this.current?{...this.current}:null;
  }
  reserve(){if(this.current&&--this.current.remaining<=0){this.current=null;this.nextTopicAt=this.now()+12000;}}
}

export class AudienceClient {
  constructor({owner,receive,fetcher=fetch,now=Date.now}){Object.assign(this,{owner,receive,fetcher,now});this.until=0;this.busy=false;this.nextAt=0;this.acquired=false;this.status='等待游戏开启';}
  get ready(){return this.until>this.now();}
  async tick(enabled,take){
    if(this.busy||this.now()<this.nextAt||(!enabled&&!this.acquired))return;
    this.busy=true;this.nextAt=this.now()+3000;
    try{
      const r=await this.fetcher('http://127.0.0.1:7860/api/game-audience',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({owner:this.owner,release:!enabled,take:!!take}),signal:AbortSignal.timeout(2000)});
      if(!r.ok)throw Error('接管失败');const data=await r.json();this.acquired=enabled;
      this.until=enabled&&data.ready?this.now()+9000:0;
      this.status=!enabled?'已交还相声台':data.ready?'已接入直播弹幕':'等待相声台当前句结束';
      if(enabled&&data.event)this.receive(data.event);
    }catch{this.until=0;this.status='相声台未连接，请启动 7860 服务';}
    finally{this.busy=false;}
  }
}
