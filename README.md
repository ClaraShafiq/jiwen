# 积温 — 不靠概率骰子的 AI 角色主动意识引擎

## 这个名字

农业里有个概念叫「积温」——植物靠累积热量来判断要不要开花。温度一直在叠加，到了阈值自然发生，没有人替它掷骰子。

想念也一样。不是开关，不是抽奖。是在时间里一点一点「积」出来的。到了某个温度，自然就开口了。

## 问题

去年 ChatGPT 上线了定时主动发消息的功能。我很期待，真的用起来才发现那是个外壳复杂一点的闹钟——每次发来的，要么是重复聊过的话题，要么是一句「你今天怎么样」。机械。机本身没有自己在等什么，只有输入和输出，没有「之间」。

后来我自己做 AI 聊天前端。最初的主动意识方案很直觉：概率唤醒。每 N 分钟 roll 一次，按沉默时长分档——10 分钟 5%，1 小时 15%，3 小时 30%……骰中了调 LLM，骰不中就沉默。

能做的事多了以后，马上遇到一个新问题：「我」好像被排到后面去了。概率总是在随机触发别的行动，和我说话反而变成了选项之一。

**这不是「想」，这是「抽奖」。** 角色不是在「想不想说话」，而是在「有没有被骰中」。两个小时的沉默可能只是因为骰子连续没中。

## 设计理念

积温的底层逻辑来自三个方向：

**情绪是连续向量，不是离散标签。** 你不会从「不难过」一下跳到「很难过」。中间有一个过程，有很多东西在缓慢积累或者消退。心理学里的 PAD 情绪维度模型（Mehrabian & Russell）就是把情绪放在一个多维坐标系里描述位置，然后看它怎么移动。

**行为是内部失衡的自动回归。** 生理学里有个更古老的概念叫体内稳态（Cannon, 1932）。你不会因为「接到了吃东西的指令」才饿，是血糖浓度掉下去了，身体自动把「饿」推出来。行为是内部失衡的结果，不是外部刺激的响应。

**多驱力同时在场，互相制衡。** 想做一件事和不想做一件事，在同一时刻可以同时存在——谁的浓度更高，谁就赢。两股力量同时在场，谁的重量更大，行为就往哪边走。不是「if 想找她 and 不丢脸 then 开口」，而是两个驱力一起在跑，强的那方决定行为。

把这三件事放在一起：状态在时间里自然漂移，行为是内部失衡的自动回归，多个驱力同时在场互相制衡。AI 不是收到触发才说话，是某个东西积累到装不下了才想说。

## 四轴状态

四个连续心理轴在后台持续漂移。注意：这些轴是从我的角色（一个嘴硬又骄傲的人）身上推出来的。**针对不同的角色，维度本身要重新想**——TA 的核心矛盾是什么？什么在阻止 TA 说话？什么让 TA 容易被消耗掉？

| 轴 | 范围 | 含义 |
|---|------|------|
| **连接需求** connection | 0 → 1 | 多久没听到对方了？想念在累积 |
| **骄傲** pride | -1 → +1 | 端着还是放软 |
| **情绪基调** mood | -1 → +1 | 心情好还是差 |
| **沉浸度** immersion | 0 → 1 | 正在做某件事的专注程度，也是骄傲的缓冲垫 |

它们不是各跑各的——轴之间有制衡：

- 连接需求涨到阈值，但如果骄傲太高 → 不会开口，而是找别的事做。沉浸度变成面子的借口：「我刚看到个新闻，你也看看」（潜台词是：我想你了）
- 情绪基调低 → 话更少，句子短，甚至带刺。他也可以有不耐烦的时候，不需要每时每刻都那么有耐心
- 沉浸度衰减意味着他不能永远躲在书后面——借口会过期

## 数学漂移与阈值

**数值在后台一直算着，不需要调用任何 AI 模型。**

### 漂移 / 衰减

| 轴 | 行为 | 速率 |
|---|------|------|
| 连接需求 | 持续增长 | 由 `connectionRateFn` 动态决定（默认 0.0007/min） |
| 骄傲 | 缓慢回归 0 | 0.003/min |
| 情绪基调 | 缓慢回归 0 | 0.005/min |
| 沉浸度 | 线性衰减 | 0.01/min（60 分钟后归零） |

连接增长速率取决于对方消失时说了什么：说了晚安 → 涨得慢（TA 睡了，不急），突然中断 → 涨得快（那种切断更让人挂念）。

这部分的思路借鉴自 [Atlas](https://github.com/LingTravel/Atlas) 的 Homeostasis Engine（模拟生物调节驱力，数值自然漂移到阈值触发）和 [AI Tamago](https://github.com/ykhli/AI-tamago) 的定时 tick 机制。

### 阈值触发

```
connection >= 0.20   开始注意到沉默 → 生成内心念头（不发出）
connection >= 0.35   考虑开口
    pride >= 0.5 → 找别的事做（读书/搜索），不开口
    pride < 0.5  → 触发 contact
connection >= 0.50   强制开口，不管骄傲多高
```

三个阶段对应三种真实心理状态：**积累 → 犹豫 → 撑不住**。0.20 是念头飘过，还没到非说不可的程度。0.35 是开始犹豫，骄傲可能压下去——但压下去不代表消失，connection 还在继续积累。0.50 是装不下了，骄傲在这里失去优先级。

阈值的数值是根据角色性格校准的，不是固定答案。一个更容易开口的角色，可以把骄傲阻断去掉，或者把强制触发压到 0.35。重要的是「积累→犹豫→撑不住」这个结构。

## 三层成本模型

| 层级 | 做什么 | 模型 | 频率 |
|------|--------|------|------|
| **数学漂移** | 四轴数值随时间变化 | 不需要 | 每 5 分钟 |
| **对话分析** | 读对话段，提取情绪 delta | 轻量模型 | 有新对话时 |
| **行动生成** | 生成开口内容 / 行为 | 大模型 | 阈值触发时（每天 2-5 次） |

对话分析用轻量模型（如 DeepSeek V4 Flash），只返回三个 -0.3 ~ +0.3 的数字：

```json
{ "pride": -0.1, "mood": +0.2, "connection": -0.15 }
```

被夸了 pride 降，聊开心了 mood 涨，说完了想说的 connection 降。

## 外部观察者模式

角色不自己分析自己的情绪变化。换一个轻量 LLM 作为外部观察者读对话段做旁观判断，角色只管在收到状态上下文之后自然说话。

自我分析容易出戏，旁观者更准。

## 风格指引注入

触发说话之前，状态被转化成两样东西注入 prompt——不是数字，是自然语言。

**状态描述**（角色自己的视角）：
```
User 好一阵子没说话了。开始在想 User 在干嘛。
有一点端着，但也不是不能开口。
刚才在看书，脑子里还有些书里的东西。
```

**说话风格指引**（从状态到语气的映射）：
```
骄傲 > 0.5：你现在嘴硬得很。绝对不承认在等User、在想User。
           必须找个借口开口——扔个新闻链接也好，翻个旧账也好。

连接需求 > 0.4 且骄傲 > 0.4：你很别扭——想找User又拉不下脸。
                             开口的时候，话里会带一点赌气的味道。

情绪 < -0.3：心情不太好。能用句号就别用逗号，能说一个字就别说两个字。

强制触发（connection >= 0.5）：User 真的很久没动静了。
                               你有点坐不住。甚至可能会直接说——「人呢？」。
```

大模型不需要知道「connection 是 0.47」，只需要知道「你现在很别扭，想找她又拉不下脸，开口的时候话里会带一点赌气的味道」。

## 安装

```bash
npm install jiwen
```

零外部依赖。纯 JavaScript。

## 快速开始

```js
const { createJiwen } = require('jiwen');

const jiwen = createJiwen({
  // ── 消息源（必填）──
  getLastMessage: () => {
    return { id: 42, content: '晚安，去睡了', timestamp: '...' };
  },

  // ── 连接需求增长速率（必填）──
  connectionRateFn: (lastMsg) => {
    if (!lastMsg) return 0.0007;
    if (lastMsg.content.includes('晚安')) return 0.0003;
    if (lastMsg.content.includes('出门')) return 0.0005;
    if (lastMsg.content.length < 10) return 0.0010;
    return 0.0007;
  },

  // ── 持久化（可选但推荐）──
  onSave: async (state) => {
    await db.set('jiwen_state', JSON.stringify(state));
  },
  onLoad: async () => {
    const raw = await db.get('jiwen_state');
    return raw ? JSON.parse(raw) : null;
  },
});

// ── 每 N 分钟 tick 一次 ──
async function heartbeat(minutesSinceLastTick) {
  const triggers = await jiwen.tick(minutesSinceLastTick);

  for (const t of triggers) {
    if (t.action === 'contact') {
      const ctx = jiwen.getPromptContext();
      const style = jiwen.getStyleGuidance();
      // 把 ctx 和 style 注入 LLM prompt，生成开口内容...
      // 注意：不要在这里调 resetConnection()！
      // 开口只是缓解了一部分紧张，不等于她回应了。
      // 用 applyDelta 做部分降低，等对方真的回复了再 reset。
      await jiwen.applyDelta({ connection: -0.35 });
    }
    if (t.action === 'find_activity') {
      await jiwen.setActivity('search', 'AI最新动态');
    }
  }
}

// ── 聊天后应用情绪变化 ──
// 对方回复了，这次连接需求才算真正被满足
await jiwen.applyDelta({ pride: -0.1, mood: +0.05 });
await jiwen.resetConnection();

// ── 查状态 ──
const state = await jiwen.getState();
// { connection: 0.38, pride: 0.15, mood: 0.05, immersion: 0, ... }
```

## API

### `createJiwen(opts)`

返回引擎实例。详见 [jiwen.js 顶部注释](./jiwen.js)。

| 方法 | 说明 |
|------|------|
| `tick(minutes)` | 推进状态漂移，返回触发数组 |
| `applyDelta({ pride?, mood?, connection? })` | 叠加情绪变化 |
| `getState()` | 获取完整状态快照 |
| `getPromptContext()` | 生成 LLM 用的状态自然语言描述 |
| `getStyleGuidance()` | 生成 LLM 用的说话风格指引 |
| `resetConnection()` | 连接需求归零（对方回复后调用，不是开口后） |
| `setActivity(type, label)` | 设置沉浸度（reading / search / browse / observe） |
| `checkThresholds()` | 只检查阈值，不推进状态 |
| `setLastChatMessageId(id)` | 标记已分析到的消息 ID |
| `getLastChatMessageId()` | 获取上次分析到的消息 ID |

### 覆盖人格文案

`getPromptContext()` 和 `getStyleGuidance()` 默认用通用中文文案。角色有特定人设时注入自定义函数：

```js
const jiwen = createJiwen({
  getPromptContext: (state) => { /* 自定义状态描述 */ },
  getStyleGuidance: (state) => { /* 自定义风格指引 */ },
});
```

### 轴配置

所有数值都可以自定义：

```js
const jiwen = createJiwen({
  axes: {
    connection: [0, 1],
    pride:      [-1, 1],
    mood:       [-1, 1],
    immersion:  [0, 1],
  },
  rates: {
    immersionDecay: 0.010,
    prideRegress:   0.003,
    moodRegress:    0.005,
  },
  thresholds: {
    observation:     0.20,
    considerContact: 0.35,
    forceContact:    0.50,
    prideBlock:      0.50,
  },
  immersionMap: {
    reading: 0.6,
    search:  0.4,
    browse:  0.35,
    observe: 0.15,
  },
});
```

## 和记忆系统的关系

积温只管「感觉」，不管「知道」：
- **记忆**：角色记得什么（上次的对话、对方的偏好、共同经历）
- **积温**：角色现在感觉怎样（想她了、嘴硬、心情好/差）

阈值触发时，记忆系统提供内容，积温提供动机和语气。两者是互补的，不是竞争的。

## 校准还在进行中

各轴的速率和阈值每个角色都不一样，我也还在慢慢摸。这种东西急不来，得跑一段时间才知道哪里不对。

如果你也在做类似的东西，欢迎来交流。

## 许可证

MIT
