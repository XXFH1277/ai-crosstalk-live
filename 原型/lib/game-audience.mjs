// 游戏接管的是已审核队列；评论不会成为游戏指令，也不启动第二条配音流水线。
export class GameAudience {
  constructor(director, now = Date.now) { this.director=director;this.now=now;this.owner=null;this.until=0;this.sequence=0;this.lastGift=0; }
  get active(){return !!this.owner&&this.now()<this.until;}
  exchange(owner,{release=false,take=false}={}){
    if(typeof owner!=='string'||owner.length<8||owner.length>100)throw Error('接管标识无效');
    if(this.active&&this.owner!==owner)throw Error('游戏弹幕已由另一实例接管');
    if(release){if(this.owner===owner){this.owner=null;this.until=0;this.director.sendNext();this.director.wake();}return {ready:false};}
    this.owner=owner;this.until=this.now()+15000;
    const d=this.director;
    // 正在说的一句自然结束后才交接；新台词的派发已由 active 阻止。
    if(d.playing)return {ready:false};
    let event=null;
    if(take){
      const gifts=d.gifts;
      const tier=gifts.big.length?'big':gifts.medium.length?'medium':gifts.small.length?'small':null;
      if(tier&&(tier==='big'||this.now()-this.lastGift>=30000)){
        const items=gifts[tier].splice(0,8);this.lastGift=this.now();
        event={kind:'gift',users:items.map(g=>d.guard.safeName(g.user)),text:'谢谢这些朋友的礼物，简短致谢，不念礼物名、数量或金额。',expiresAt:this.now()+45000};
      }else if(d.replyDanmaku){
        d.pruneDanmaku();
        const candidates=d.danmaku.filter(e=>e.safe===true&&e.modelReviewed===true&&!d.guard.blockedUsers.has(e.raw)&&e.score>=(d.d.minDanmakuScore??3));
        candidates.sort((a,b)=>(b.score+(b.question?2:0))-(a.score+(a.question?2:0))||b.at-a.at);
        const ev=candidates[0];
        if(ev){
          d.danmaku=d.danmaku.filter(e=>e!==ev);
          if(ev.topicRequest)d.topicRequests=d.topicRequests.filter(t=>t.title!==ev.topicRequest);
          event={kind:'danmaku',user:d.guard.safeName(ev.user),text:ev.text,expiresAt:ev.at+Math.min(45,d.d.audience?.maxReplyAgeSeconds??45)*1000};
        }
      }
      if(event)event.id=++this.sequence;
    }
    return {ready:true,event};
  }
}
