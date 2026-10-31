import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { GameLeisure, AudienceClient } from './leisure.mjs';
import mineflayer from 'mineflayer';
import navigation from 'mineflayer-pathfinder';
import { MinecraftBridge } from './bridge.mjs';
import { attachCPM } from './cpm.mjs';
import { observe, act } from './play.mjs';
import { GameAI } from './ai.mjs';
import { GameTasks, parseTask, validateTask } from './tasks.mjs';
import { SurvivalGoals } from './goals.mjs';
import { GamePlanner } from './planner.mjs';
import { SkillMemory } from './skill-memory.mjs';
import { executeSkill } from './skills.mjs';
import { fileURLToPath } from 'node:url';
import { taskOptions, executeTask } from './task-world.mjs';
import { GameInput } from './input.mjs';
import { generate, planGame, voice, prepareCues, audioDir, audioMemory, cues, playbackRate } from './services.mjs';
const instance=randomUUID(),port=7861,origin='http://127.0.0.1:7861',clients=new Set(),events=[];
let ai,input,cueStatus='准备受击短音中';
const controller='YourMCName';
function publish(event){
 event={at:Date.now(),...event};events.push(event);if(events.length>60)events.shift();
 if(event.type==='reaction'||event.type==='connection')ai?.invalidate(event);
 if(event.type==='mission'&&['失败','已停止','已完成'].includes(event.status))say(event.who,event.text);
 for(const c of clients)c.write('data: '+JSON.stringify(event)+'\n\n');
 if(event.text)console.log((event.who||'')+'：'+event.text);
}
const bridges=['深深','月月'].map((who,i)=>new MinecraftBridge({
 createBot:options=>{const bot=mineflayer.createBot(options);attachCPM(bot,options.username,text=>publish({type:'model',who,text}));return bot;},pathfinder:navigation.pathfinder,Movements:navigation.Movements,
 GoalFollow:navigation.goals.GoalFollow,who,username:i?'YueyueBot':'ShenshenBot',publish,onChat:(player,text)=>input?.receive(player,text)
}));
const planner=new GamePlanner({think:planGame,execute:executeSkill,observe,bridges,memory:new SkillMemory(fileURLToPath(new URL('../runtime/minecraft-skills.json',import.meta.url)))});
const tasks=new GameTasks({bridges,observe,planner,goals:new SurvivalGoals({agent:true}),options:taskOptions,execute:(b,c,s)=>executeTask(b,c,s,navigation.goals.GoalNear),publish});
function say(who,text){const b=bridges.find(b=>b.who===who)||bridges[0];if(b.bot&&b.state.status==='已入服')b.bot.chat('['+b.who+'] '+String(text).replace(/[\r\n]/g,' ').slice(0,150));}
const topicFile=new URL('../主题库.json',import.meta.url),memoryFile=new URL('../runtime/minecraft-topics.json',import.meta.url);
let topicMemory={};try{topicMemory=JSON.parse(readFileSync(memoryFile,'utf8'));}catch{}
const leisure=new GameLeisure({topics:JSON.parse(readFileSync(topicFile,'utf8')).topics,memory:topicMemory,save:data=>writeFileSync(memoryFile,JSON.stringify(data))});
const audience=new AudienceClient({owner:instance,receive:event=>leisure.accept(event)});
ai=new GameAI({bridges,observe,act:(b,c)=>act(b,c,navigation.goals.GoalNear),generate,voice,publish,tasks,leisure,audience,
 onSpeech:line=>{if(line.replyTo||ai.textOnly)say(line.who,line.text);}});
function handleInput(text,player,command,client){
 if(typeof text!=='string'||!text.trim()||text.length>180||text.startsWith('/'))throw Error('请输入 1～180 字聊天或任务');
 if(command?.mode==='stop'){
  if(command.actors.length===2)ai.stop();else{tasks.stop(command.actors);ai.invalidate();}
  publish({type:'input',who:player,text:'已停止：'+command.actors.join('、')});if(!client)say(command.actors[0],'收到，已停止。');return;
 }
 if(command)validateTask(command);
 if(!ai.enabled)ai.start(client||'game:'+player,{textOnly:!client,player});
 if(command){tasks.assign(command);ai.invalidate();}
 ai.hear(player,text);publish({type:'input',who:player,text});
 if(!client&&command)say(command.actors[0],'收到任务，实际进度以任务栏和背包为准。');
}
input=new GameInput({controller,bots:bridges.map(b=>b.username),onInput:(text,player,command)=>{try{handleInput(text,player,command);}catch{say('深深','暂时无法执行，请确认两人在线；任务数量为 1 到 16。');}}});
const snapshot=()=>({instance,bots:bridges.map(b=>({...b.snapshot(),inventory:observe(b).inventory||[]})),ai:ai.snapshot(),tasks:tasks.snapshot(),goal:tasks.goalSnapshot(),planner:planner.snapshot(),controller,entertainment:{enabled:leisure.enabled,audienceEnabled:leisure.audienceEnabled,status:audience.status,topics:leisure.topics.length},events,cueStatus,cues,playbackRate});
const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));};
const server=createServer(async(req,res)=>{
 try{
  if(req.headers.host!=='127.0.0.1:7861'||(req.headers.origin&&req.headers.origin!==origin))return json(res,403,{error:'只允许本机同源请求'});
  if(req.method==='GET'){
   if(req.url==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});return res.end(await readFile(new URL('./index.html',import.meta.url)));}
   if(req.url==='/api/state')return json(res,200,snapshot());
   if(req.url==='/events'){res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache',connection:'keep-alive'});res.write(': 已连接\n\n');clients.add(res);req.on('close',()=>clients.delete(res));return;}
   if(/^\/audio\/(line-\d+|cue-[01]-(hurt|danger|death|recovered)-\d+)\.wav$/.test(req.url)){
    const id=req.url.slice(7),buffer=audioMemory.get(id)||(id.startsWith('cue-')?await readFile(new URL(id,audioDir)):null);
    if(!buffer)return json(res,404,{error:'声音已过期'});res.writeHead(200,{'content-type':'audio/wav'});return res.end(buffer);
   }
   if(req.url.startsWith('/assets/')){
    const name=decodeURIComponent(req.url.slice(8));
    if(!/^(深深|月月)-(基础|脸|脸-(嘴-(半张|张大)|表情-(惊讶|开心|无语|得意))|动作-(抱头|扶额))\.(png|json)$/.test(name))return json(res,404,{});
    const buffer=await readFile(new URL('../../素材/透明/'+name,import.meta.url));
    res.writeHead(200,{'content-type':name.endsWith('.png')?'image/png':'application/json'});return res.end(buffer);
   }
  }
  if(req.method!=='POST'||req.url!=='/api/command')return json(res,404,{error:'未找到'});
  if(!req.headers['content-type']?.startsWith('application/json'))return json(res,415,{error:'需要 JSON 请求'});
  let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>4096)return json(res,413,{error:'请求过大'});}
  const data=JSON.parse(raw);if(!data||typeof data!=='object')throw Error('请求无效');
  const selected=bridges.find(b=>b.who===data.who)||bridges[0];
  switch(data.action){
   case 'connect':if(!Number.isInteger(data.port)||data.port<1024||data.port>65535)throw Error('端口无效');for(const b of bridges)if(!b.bot)b.connect(data.port);break;
   case 'follow':ai.stop();selected.follow(data.target);break;
   case 'stop':ai.stop();break;
   case 'respawn':ai.stop();selected.respawn();break;
   case 'disconnect':ai.stop();for(const b of bridges)b.disconnect();break;
   case 'ai-start':if(cueStatus!=='短音已就绪')throw Error('短音未就绪');ai.start(data.client);break;
   case 'input':handleInput(data.text,controller,parseTask(data.text,controller),data.client);break;
   case 'entertainment':leisure.enabled=data.enabled===true;leisure.audienceEnabled=data.audienceEnabled===true;leisure.queue=[];ai.invalidate();break;
   case 'heartbeat':ai.heartbeat(data.client);break;
   case 'ack':ai.acknowledge(data.client,data.id,data.status);break;
   default:throw Error('未知动作');
  }json(res,200,snapshot());
 }catch{if(!res.headersSent)json(res,400,{error:'操作未完成，请确认两人在线、短音就绪及输入有效'});else res.end();}
});
const timer=setInterval(()=>{for(const b of bridges)b.tick();audience.tick(ai.enabled,ai.enabled&&leisure.audienceEnabled&&leisure.safe(ai.world())&&leisure.queue.length<2);ai.tick().catch(()=>ai.stop());},250);
server.listen(port,'127.0.0.1',()=>console.log('双人游戏导演台：'+origin));
prepareCues().then(()=>{cueStatus='短音已就绪';publish({type:'notice',text:cueStatus});}).catch(()=>{cueStatus='短音准备失败，请检查 Breeze F16 后重启接入台';publish({type:'notice',text:cueStatus});});
function shutdown(){clearInterval(timer);ai.stop();audience.nextAt=0;audience.tick(false,false);for(const b of bridges)b.disconnect();for(const c of clients)c.end();server.close();}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
