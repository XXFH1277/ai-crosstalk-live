# 对 mindcraft 的改动（还原用）

mindcraft（github.com/mindcraft-bots/mindcraft，MIT，许可见 `LICENSE-mindcraft`）本身不进仓库，放在 `工具/mindcraft/`（已 gitignore）。这里存的是我们改过或新加的文件，换电脑时按下面的步骤还原。

1. 克隆 mindcraft 到 `工具/mindcraft`，切到 commit `e1c1fc3`。
2. 把本目录下的文件按相同路径覆盖进去：`鲸云社/`（两人人设）、`settings.js`、`src/utils/mcdata.js`、`src/agent/vision/*.js`、`patches/mineflayer+4.33.0.patch`。
3. `package.json` 里把 `"mineflayer"` 改成精确版本 `"4.33.0"`（补丁只适配这个版本）。
4. 在 `工具/mindcraft` 下运行：
   ```bash
   npm install --ignore-scripts
   npx patch-package
   ```
   跳过安装脚本是因为原生包 `gl` / `canvas` 在本机编译不了；它们只用于机器人视角截图，我们没开。
5. 照 `keys.example.json` 写 `keys.json`，只需要填 `DEEPSEEK_API_KEY`（用 `原型/.env.local` 里的同一个 key）。**`keys.json` 不要提交。**

每个文件改了什么、为什么改，见 `../使用说明.md` 和 `任务日志.md` 里 2026-10-29 的 Minecraft 章节。
