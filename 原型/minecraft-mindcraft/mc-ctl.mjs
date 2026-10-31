// 鲸云社：从命令行查看 mindcraft 两人状态、给她们发话
// 用法：node mc-ctl.mjs state
//       node mc-ctl.mjs say <ShenshenBot|YueyueBot> "<消息>"
import { createRequire } from 'module';
const require = createRequire(new URL('../../工具/mindcraft/package.json', import.meta.url));
const { io } = require('socket.io-client');

const port = process.env.MINDSERVER_PORT || 8091;
const [cmd, agent, ...rest] = process.argv.slice(2);
const socket = io(`http://localhost:${port}`);

socket.on('connect', () => {
    if (cmd === 'say') {
        socket.emit('send-message', agent, { from: 'director', message: rest.join(' ') });
        setTimeout(() => process.exit(0), 300);
    } else {
        socket.emit('listen-to-agents');
    }
});
socket.on('state-update', (states) => {
    for (const [name, s] of Object.entries(states || {})) {
        if (!s) { console.log(name, '无状态'); continue; }
        const g = s.gameplay || {}, a = s.action || {}, inv = s.inventory || {};
        console.log(`${name}  位置 ${JSON.stringify(g.position)}  血 ${g.health}  饱 ${g.hunger}  生物群系 ${g.biome}`);
        console.log(`  动作 ${a.current || '空闲'}  ${a.isIdle ? '(idle)' : ''}`);
        console.log(`  背包 ${JSON.stringify(inv.counts || inv)}`);
    }
    process.exit(0);
});
setTimeout(() => { console.log('超时：MindServer 没回应'); process.exit(1); }, 8000);
