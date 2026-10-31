import assert from 'node:assert/strict';
import {GameAI} from '../minecraft/ai.mjs';
import {GamePacing} from '../minecraft/pacing.mjs';
import {GameLeisure} from '../minecraft/leisure.mjs';
import {observe} from '../minecraft/play.mjs';
globalThis.fetch=()=>{throw Error('离线测试禁止联网');};
let now=1000,calls=0,taskTicks=0;
const pacing=new GamePacing(()=>now),world=[{who:'深深',inventory:[],mission:{id:1,mode:'auto',stage:'wood',status:'执行中',count:0}}];
pacing.update(world);world[0].mission.stage='explore';assert.equal(pacing.update(world),false,'自主换点不能取消尚未生成完的台词');
world[0].inventory=[{name:'oak_log',count:1}];assert.equal(pacing.update(world),true,'真实背包变化仍应更新事实');
world[0].mission.id=2;assert.equal(pacing.update(world),true,'新任务仍使旧计划失效');
const bridges=['深深','月月'].map(who=>({who,session:1,state:{status:'已入服'},rules:{states:new Map([[who,{revision:1}]])},stop(){}}));
const ai=new GameAI({bridges,tasks:{snapshot:()=>[],startDefault(){},stop(){},tick(){taskTicks++;}},now:()=>now,observe:b=>({who:b.who,status:'已入服',choices:[{id:'wait',type:'wait'}]}),act(){},publish(){},generate:async()=>{calls++;return {action:'wait',text:''};},voice:async()=>{throw Error('安静决策不得配音');}});
ai.start('test-client');ai.pacing.remaining=0;
for(let i=0;i<30;i++){now+=1000;ai.heartbeat('test-client');await ai.tick();}
assert.equal(calls,0,'任务执行器已经在行动，不应每四秒额外请求模型选择等待');assert.equal(taskTicks,30);ai.stop();
const leisure=new GameLeisure({topics:[{id:'a',title:'新题',category:'日常'}],now:()=>now});
const safe=[{status:'已入服',health:20,mission:{stage:'mine',status:'执行中'}}];
now+=12001;assert.equal(leisure.choose(safe,{allowSpeech:false}).kind,'comedy');leisure.reserve();leisure.reserve();
now+=11000;assert.equal(leisure.choose(safe,{allowSpeech:false}),null);now+=1001;assert.equal(leisure.choose(safe,{allowSpeech:false}).kind,'comedy','十二秒后可准备下一小段，不强制冷场一分钟');
class Position{constructor(x,y,z){Object.assign(this,{x,y,z});}offset(x,y,z){return new Position(this.x+x,this.y+y,this.z+z);}floored(){return new Position(Math.floor(this.x),Math.floor(this.y),Math.floor(this.z));}distanceTo(p){return Math.hypot(this.x-p.x,this.y-p.y,this.z-p.z);}}
const bot={entity:{position:new Position(.5,64,.5)},entities:{},inventory:{items:()=>[]},blockAt:p=>({name:p.y<=(p.x>0?64:63)?'stone':'air',boundingBox:p.y<=(p.x>0?64:63)?'block':'empty'})};
const view=observe({bot,who:'深深',events:[],now:()=>now,snapshot:()=>({who:'深深',status:'已入服',players:[]})});
assert.ok(view.choices.some(c=>c.type==='walk'&&c.position.y===65),'探索可选择一格台阶上的安全地面，不困在同一高度');
console.log('PASS 连续探索与聊天：自主换点不打断生成、真实进度更新、取消无效模型空转、十二秒接话、台阶落脚点');
