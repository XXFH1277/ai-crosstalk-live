# 技能来源与适配范围

参考项目：[Mindcraft](https://github.com/mindcraft-bots/mindcraft)，MIT 许可见同目录 LICENSE。
查阅版本：`e1c1fc3ffa481506c2445fc639e16dba504b5920`。
参考文件：`src/agent/library/skills.js` 的 collectBlock、craftRecipe、tillAndSow、pickupNearbyItems，以及 `src/agent/npc/item_goal.js` 的配方前置与执行反馈设计。

本项目没有安装完整 Mindcraft，也没有启用其任意代码生成、作弊配置或独立聊天角色。`skills.mjs` 针对已有 Mineflayer 双人连接重写适配上述技能流程，保留第三方许可；规划、中文状态、结果核验和经验存储由本项目实现。

重要差异：采集按实际入包计数；耕作检查水源和实际作物；规划只输出受约束的技能步骤；停止、断线和危险取消动作；双人对同一方块互斥。经验是经过验证的步骤组合及失败记录，并不是重新训练大模型。
