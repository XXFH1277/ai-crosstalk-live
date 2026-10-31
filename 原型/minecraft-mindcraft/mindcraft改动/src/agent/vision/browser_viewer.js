import settings from '../settings.js';

// 鲸云社改：prismarine-viewer 依赖原生 canvas/gl，只在开启机器人视角时才加载
export function addBrowserViewer(bot, count_id) {
    if (!settings.render_bot_view) return;
    import('prismarine-viewer').then(({ default: prismarineViewer }) => {
        prismarineViewer.mineflayer(bot, { port: 3000+count_id, firstPerson: true, });
    }).catch(err => console.error('render_bot_view 需要原生 canvas/gl：', err.message));
}
