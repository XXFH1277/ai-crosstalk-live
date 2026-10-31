import { readFileSync } from 'node:fs';

// CPM 官方 NBTC2S 协议：无压缩命名 compound，内部为 data 字节数组。
export function modelPacket(model) {
  if (!Buffer.isBuffer(model) || model.length < 4 || model.length > 30 * 1024) throw Error('CPM 模型数据大小无效');
  const header = Buffer.from([10,0,0,7,0,4,100,97,116,97,0,0,0,0]);
  header.writeInt32BE(model.length,10);
  return Buffer.concat([header,model,Buffer.from([0])]);
}

export function attachCPM(bot, username, notify = () => {}) {
  if (!['ShenshenBot','YueyueBot'].includes(username) || !bot._client) return;
  let packet;
  try { packet=modelPacket(readFileSync(new URL(`./models/${username}.modeldata`,import.meta.url))); }
  catch { notify('CPM 模型未就绪，保留普通皮肤'); return; }
  const client=bot._client;
  let active=false, sent=0;
  const send=()=>{
    if(!active || sent>=3)return;
    client.write('custom_payload',{channel:'cpm_net:set_skin',data:packet});
    sent++; notify('已发送 CPM 本地模型，等待游戏渲染验证');
  };
  client.on('custom_payload',p=>{
    if(p.channel==='cpm_net:get_skin')send();
  });
  bot.once('spawn',()=>{
    active=true;
    client.write('custom_payload',{channel:'minecraft:register',data:Buffer.from('cpm_net:hello\0cpm_net:get_skin\0cpm_net:set_skin\0')});
    client.write('custom_payload',{channel:'cpm_net:hello',data:Buffer.from([0])});
    send();
  });
  bot.once('end',()=>{active=false;});
}
