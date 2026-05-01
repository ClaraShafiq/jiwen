# 积温 — 不靠概率骰子的 AI 角色主动意识引擎

## 问题

AI 伴侣/角色项目通常用定时轮询 + 概率骰子来决定「要不要主动说话」：
- 每 N 分钟 roll 一次
- 概率曲线按沉默时长分档（10min 5%, 1h 15%, 3h 30%...）
- 骰中了调 LLM，骰不中就沉默

**问题：** 这不是「想」，这是「抽奖」。角色不是在「想不想说话」，而是在「有没有被骰中」。两个小时的沉默可能只是因为骰子连续没中。

## 积温的做法

**状态驱动，而非概率驱动。**

名字来自一个很简单的隐喻：想念像温度一样，不是靠开关决定的，是在时间里一点一点「积」出来的。到了某个温度，自然就会开口。骄傲和情绪则像风向，影响着这团火往哪边烧。

四个连续心理轴在后台持续漂移：

| 轴 | 范围 | 含义 |
|---|------|------|
| **连接需求** connection | 0 → 1 | 多久没听到对方了？想念在累积 |
| **骄傲** pride | -1 → +1 | 端着还是放软 |
| **情绪基调** mood | -1 → +1 | 心情好还是差 |
| **沉浸度** immersion | 0 → 1 | 刚才在做什么（看书/搜索/发呆），正在消退 |

它们不是独立运行的——轴之间互相制衡：
- 连接需求涨到阈值，但如果骄傲太高 → 不会开口，而是找别的事做（「我又不是非找她不可」）
- 情绪基调低 → 开口时话少带刺
- 沉浸度给他一个面子借口（「我在看书，不是在等她」）

## 三层成本模型

| 层级 | 做什么 | 调用 |
|------|--------|------|
| **数学漂移** | 四轴数值随时间自然变化 | **免费**，纯算术 |
| **对话分析** | 聊完后，轻量模型旁观分析情绪变化 | 小模型，每次 ~100 token |
| **行动生成** | 达到阈值时，大模型生成一句话/行为 | 大模型，每天 2–5 次 |

总 LLM 调用量比传统轮询骰子方案更低——因为数学层不要钱，大模型只在阈值触发时介入。

## 认知心理学根基

- **PAD 情绪维度模型**（Mehrabian & Russell）：情绪是连续向量空间，不是离散标签
- **体内稳态**（Cannon）：行为是内部失衡的自动回归，不是外部刺激的响应
- **欲望驱动**（自衍体 Zyantine）：多驱力互相制衡，强方决定行为
- **边缘系统模型**：情绪加工和记忆检索共享结构

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
    // 从你的数据库/存储中获取对方的最后一条消息
    return { id: 42, content: '晚安，去睡了', timestamp: '...' };
  },

  // ── 连接需求增长速率（必填）──
  // 根据对方消失时说了什么，返回不同的速率
  connectionRateFn: (lastMsg) => {
    if (!lastMsg) return 0.0007;
    if (lastMsg.content.includes('晚安')) return 0.0003;  // 说了晚安，涨得慢
    if (lastMsg.content.includes('出门')) return 0.0005;  // 说了去哪
    if (lastMsg.content.length < 10) return 0.0010;       // 突然中断
    return 0.0007; // 默认
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
      // 角色想开口了。把状态描述 + 风格指引注入 LLM prompt
      const ctx = jiwen.getPromptContext();
      const style = jiwen.getStyleGuidance();
      const prompt = `[你的状态]\n${ctx}\n\n${style}\n\n开口说你想说的话。`;
      // 调你的 LLM ...
      await jiwen.resetConnection();
    }

    if (t.action === 'find_activity') {
      // 骄傲太高，不肯开口，找别的事做
      // 比如搜索资讯 / 看书 ...
      await jiwen.setActivity('search', 'AI最新动态');
    }
  }
}

// ── 聊天后应用情绪变化 ──
async function afterChat(emotionDelta) {
  // emotionDelta 由外部轻量 LLM 分析对话段得出
  await jiwen.applyDelta({ pride: -0.1, mood: +0.05 });
}

// ── 查状态 ──
const state = await jiwen.getState();
console.log(state); // { connection: 0.38, pride: 0.15, mood: 0.05, immersion: 0, ... }
```

## API

### `createJiwen(opts)`

返回引擎实例。详见 [jiwen.js 顶部注释](./jiwen.js)。

### 引擎方法

| 方法 | 说明 |
|------|------|
| `tick(minutes)` | 推进状态漂移，返回触发数组 |
| `applyDelta({ pride?, mood?, connection? })` | 叠加情绪变化 |
| `getState()` | 获取完整状态快照 |
| `getPromptContext()` | 生成 LLM 用的状态自然语言描述 |
| `getStyleGuidance()` | 生成 LLM 用的说话风格指引 |
| `resetConnection()` | 连接需求归零（开口后调用） |
| `setActivity(type, label)` | 设置沉浸度（看书/搜索等） |
| `checkThresholds()` | 只检查阈值，不推进状态 |
| `setLastChatMessageId(id)` | 标记已分析到的消息 ID |
| `getLastChatMessageId()` | 获取上次分析到的消息 ID |

### 覆盖人格文案

`getPromptContext()` 和 `getStyleGuidance()` 默认用通用的中文文案。如果你的角色有特定人设，注入自定义函数：

```js
const jiwen = createJiwen({
  // ...其他配置...
  getPromptContext: (state) => {
    // 返回完全自定义的状态描述
    return `...`;
  },
  getStyleGuidance: (state) => {
    // 返回完全自定义的风格指引
    return `...`;
  },
});
```

## 轴配置

所有数值都可以自定义：

```js
const jiwen = createJiwen({
  axes: {
    connection: [0, 1],      // [min, max]
    pride:      [-1, 1],
    mood:       [-1, 1],
    immersion:  [0, 1],
  },
  rates: {
    immersionDecay: 0.010,   // 每分钟衰减
    prideRegress:   0.003,   // 每分钟回归 0
    moodRegress:    0.005,
  },
  thresholds: {
    observation:     0.20,   // 开始注意到沉默
    considerContact: 0.35,   // 考虑开口
    forceContact:    0.50,   // 强制开口（无视骄傲）
    prideBlock:      0.50,   // 骄傲阻断阈值
  },
  immersionMap: {
    reading:  0.6,
    search:   0.4,
    browse:   0.35,
    observe:  0.15,
  },
});
```

## 和记忆系统的关系

积温只管「感觉」，不管「知道」。它应该和记忆系统互补：
- **记忆**：角色记得什么（上次的对话、对方的偏好、共同经历）
- **积温**：角色现在感觉怎样（想她了、嘴硬、心情好/差）

在阈值触发时，记忆系统提供内容，积温提供动机和语气。

## 许可证

MIT
