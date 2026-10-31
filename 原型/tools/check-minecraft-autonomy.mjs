import assert from 'node:assert/strict';
import {GameTasks,parseTask} from '../minecraft/tasks.mjs';
import {chooseActivity,explorationChoices,inActivityArea,AUTO_RADIUS} from '../minecraft/autonomy.mjs';
import {GameLeisure} from '../minecraft/leisure.mjs';
globalThis.fetch=()=>{throw Error('离线测试禁止联网');};
let now=1000,followed=0,moves=[],resourceAvailable=true;
const settle=()=>new Promise(r=>setImmediate(r));
const bridges=['深深','月月'].map((who,i)=>({who,session:1,state:{status:'已入服',position:{x:i*2,y:64,z:0},players:['player']},items:[],rules:{states:new Map()},stop(){this.state.target=null;},follow(){followed++;this.state.target='player';}}));
const observe=b=>({...b.state,who:b.who,health:20,food:20,inventory:b.items,choices:[{type:'wait',id:'wait'},...[3,-3].map((dx,i)=>({type:'walk',id:'walk:'+i,position:{x:b.state.position.x+dx,y:64,z:0}}))]});
const tasks=new GameTasks({bridges,observe,now:()=>now,publish(){},options:(b,j)=>({choices:resourceAvailable?[{key:'tree:'+b.who,kind:'dig',position:{...b.state.position},label:'附近原木'}]:[]}),execute:async(b,c)=>{moves.push(c.kind);if(c.kind==='walk')b.state.position={...c.position};else b.items=[{name:'oak_log',count:2}];return {text:'动作完成'};}});
assert.equal(parseTask('两人自由活动','player').mode,'auto');assert.equal(parseTask('月月各玩各的','player').mode,'auto');
assert.equal(parseTask('两人别跟着我了，自己玩','player').mode,'auto');assert.equal(parseTask('别跟着我去挖矿好吗？','player'),null);
tasks.startDefault('player');assert.ok(tasks.snapshot().every(j=>j.mode==='auto'&&j.stage!=='follow'));
tasks.tick();await settle();now+=1100;tasks.tick();assert.ok(tasks.snapshot().every(j=>j.stage==='rest'),'采集完成短暂选点，不返回跟随');assert.equal(followed,0);
// 玩家离开可见范围不影响自主任务；资源不够时也会换活动。
bridges.forEach(b=>b.state.players=[]);resourceAvailable=false;now+=1501;tasks.tick();await settle();
assert.ok(moves.includes('walk'),'约 1.5 秒即继续巡视，不长时间原地休息');assert.equal(followed,0);
const original=tasks.snapshot().map(j=>({...j.anchor}));
for(let i=0;i<70;i++){now+=5000;tasks.tick();await settle();}
assert.ok(tasks.snapshot().every(j=>j.status==='执行中'&&j.stage!=='follow'),'没有资源、超时和休息都不会自动跟随');
assert.ok(tasks.snapshot().every((j,i)=>j.anchor.x>original[i].x+18),'活动中心随自己完成的探索前移，不能永远困在最初范围');assert.equal(followed,0);
tasks.assign({mode:'follow',actors:['深深','月月'],player:'player'});bridges.forEach(b=>b.state.players=['player']);tasks.tick();assert.equal(followed,2,'显式跟随指令仍可用');
tasks.assign(parseTask('两人自由活动','player'));assert.ok(bridges.every(b=>b.state.target===null),'切自主模式先清除旧跟随目标');
tasks.tick();await settle();tasks.stop();assert.equal(tasks.snapshot().length,0);

const job={anchor:{x:0,y:64,z:0},round:0,lastAuto:{},visited:[]};
const view={position:{x:0,y:64,z:0},inventory:[{name:'oak_log',count:8},{name:'stone_pickaxe',count:1}],food:20};
assert.equal(chooseActivity(view,job,now).stage,'mine','有镐且原木足够时可少量采矿');
assert.equal(chooseActivity(view,job,now).stage,'explore','采集尝试有冷却，不无限刷同一任务');
assert.equal(chooseActivity({...view,food:3},job,now).stage,'rest');
const choices=[{type:'walk',position:{x:21,y:64,z:0}},{type:'walk',position:{x:15,y:64,z:0}}];
assert.deepEqual(explorationChoices({...view,position:{x:18,y:64,z:0},choices},job).map(c=>c.position.x),[15],'不离开自身活动半径');
assert.equal(inActivityArea({position:{x:AUTO_RADIUS+1,y:64,z:0}},job,{}),false,'自动采集也不能越界');
assert.equal(inActivityArea({position:{x:4,y:64,z:0}},job,{}),true);
const leisure=new GameLeisure({topics:[],now:()=>now});assert.equal(leisure.safe([{status:'已入服',health:20,mission:{status:'执行中',stage:'rest'}}]),true,'自主休息时仍能接观众和说短段子');
console.log('PASS 自主活动：不默认跟随、活动区随探索前移、少量采集、连续换点、无资源换活动、玩家离开、显式跟随和暂停');
