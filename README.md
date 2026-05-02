# 积温 — 不靠概率骰子的 AI 角色主动意识引擎

> AI 角色只会在你发消息之后回复——它从来不会先开口。因为没人告诉它「什么时候该说话」。
>
> 积温做这件事。它在后台持续追踪五个数值：**想不想找你、嘴硬不硬、心情好坏、焦不焦躁、手头有没有事做。** 数值随时间漂移，到阈值了告诉你角色现在该干嘛。不靠随机数，不靠 prompt engineering。
>
> 一个 ~500 行的 JS 函数，零依赖。你把它挂到自己的项目里，每几分钟调一次 `tick()`。它不写回复、不存数据、不调模型——只输出状态。剩下的你自己来。

## 这是什么

- **`createJiwen(opts)`** — 创建一个角色实例。你告诉它怎么读消息、怎么存状态、各轴速率多少，它把剩下的事干了
- **`tick(minutes)`** — 每几分钟调一次。传入经过的分钟数，返回触发动作数组：`contact`（开口）、`find_activity`（逃避/自我调节）、`observation`（注意到沉默但还不想动）
- **`getPromptContext()` / `getStyleGuidance()`** — 把数值翻译成人话，塞进 LLM prompt。模型不需要知道 `connection=0.47`，只需要知道「你很别扭，想找她又拉不下脸」
- **`simulate.js`** — 写一条事件线，跑多组参数，出 CSV 轨迹对比。调参用的
- **`node jiwen.test.js`** — 29 项测试，改完跑一下

## 为什么不用概率骰子

每 N 分钟 roll 一次，沉默越久概率越高——这是最常见的做法。问题是它不可控：两小时沉默可能只是因为骰子连续没中。角色不是在「想不想说话」，而是在「有没有被骰中」。

五个连续数值随时间漂移，互相制衡，到阈值自然触发。想找她又嘴硬？数值打架，强的那方决定行为。不靠随机数。


## 五轴状态

五个连续数值在后台漂移。这些维度是从一个嘴硬又骄傲的角色身上推出来的——换一个角色，核心矛盾不同，维度可以增减。

| 轴 | 范围 | 含义 |
|---|------|------|
| **连接需求** connection | 0 → 1 | 多久没听到对方了？想念在累积 |
| **骄傲** pride | -1 → +1 | 端着还是放软 |
| **愉悦度** valence | -1 → +1 | 好受还是难受（Valence，Russell 环状模型） |
| **唤醒度** arousal | -1 → +1 | 焦躁/兴奋还是平静/慵懒（Arousal，正交于 Valence） |
| **沉浸度** immersion | 0 → 1 | 正在做某件事的专注程度，也是骄傲的缓冲垫 |

Valence 和 Arousal 来自 Russell (1980) 情绪环状模型——两根正交轴构成一个平面。愤怒（低 valence + 高 arousal）和悲伤（低 valence + 低 arousal）落在不同位置，行为表现完全不同。

轴之间互相制衡：

- 连接需求触达开口阈值，但骄傲高 → 不开口，找事做（沉浸度充当面子缓冲）
- 低 valence + 高 arousal → 烦躁带刺；低 valence + 低 arousal → 低落话少
- 等待拉升 arousal，同时锁定 valence 回归（坏情绪难消散）
- 沉浸度衰减 → 不能永远躲在书后面，借口会过期

## 数学漂移与阈值

**数值在后台一直算着，不需要调用任何 AI 模型。**

### 漂移 / 衰减

| 轴 | 行为 | 速率 |
|---|------|------|
| 连接需求 | 分段增长 | 由 `connectionRateFn` 动态决定基础速率；前 `accelDelay` 分钟线性增长，之后叠加加速度 `pow(1+c, connectionAccel)`；valence 状态可进一步调制 |
| 骄傲 | 受连接需求驱动 | 未触发防御时回归 0（0.003/min）；被冷落时防御性上升至 `prideDefendTarget` |
| Valence（愉悦度） | 回归设定点，等待时锁定 | 默认回归 0（0.005/min）；connection 超过 `valenceLockThreshold` 时回归速率降至 `valenceLockFactor` 倍 |
| Arousal（唤醒度） | 平时回归平静，等待时攀升 | 默认回归 0（0.005/min）；connection 超过 `arousalConnectionRiseThreshold` 时以 `arousalConnectionRiseRate` 向上攀升 |
| 沉浸度 | 线性衰减 | 0.01/min（60 分钟后归零）；做事情（`setActivity`）可部分缓解连接需求 |

### 连接需求增长曲线

```
connection 增长 = baseRate × accelFactor × valenceFactor

baseRate     = connectionRateFn(lastMessage)  ← 内容判断（晚安→慢，中断→快，可叠加日历因子）
accelFactor  = 前 accelDelay 分钟内为 1.0（线性），之后为 pow(1+c, connectionAccel)
valenceFactor = 开心/中性(≥0) → 1.0  |  轻度不开心(-0.2~0) → boost  |  严重低落(<-0.4) → dampen
```

三层叠加：对方说了晚安 → 涨得慢；突然中断 → 涨得快。等了半小时没动静 → 开始加速。轻度不开心想求安慰 → 加速；严重低落自我封闭 → 减速。

### 参数表（默认关闭，向后兼容）

| 参数 | 作用 |
|------|------|
| `connectionAccel` | 非线性加速指数 |
| `accelDelay` | 加速前的线性缓冲（分钟），默认 0 |
| `valenceSetpoint` | Valence 回归目标，默认 0 |
| `valenceConnectBoost/Threshold` | 轻度不开心时 connection 加速 |
| `valenceConnectDampen/Threshold` | 严重低落时 connection 减速 |
| `valenceLockThreshold/Factor` | 想念强烈时坏情绪难消散 |
| `arousalConnectionRiseThreshold/Rate` | 等待让 arousal 攀升 |
| `prideDefendThreshold/Target/Rate` | 被冷落时骄傲防御性升高 |
| `activityConnectionRelief` | 做事情缓解连接需求的幅度 |

这部分的思路借鉴自 [Atlas](https://github.com/LingTravel/Atlas) 的 Homeostasis Engine（模拟生物调节驱力，数值自然漂移到阈值触发）和 [AI Tamago](https://github.com/ykhli/AI-tamago) 的定时 tick 机制。

### 阈值触发

```
connection >= 0.20   开始注意到沉默 → 生成内心念头（不发出）
connection >= 0.35   考虑开口
    pride >= 0.5 → 找别的事做（读书/搜索），不开口
    pride < 0.5  → 触发 contact
connection >= 0.50   强制开口，不管骄傲多高

valence <= valenceActivity   心情差 → 找事做自我调节
arousal >= arousalAgitation  太焦躁 → 也找事做（宣泄多余唤醒）
（与 pride_block 并列，不重复触发）
```

**积累 → 犹豫 → 撑不住**。数值根据角色性格校准，不是固定答案。更粘人的角色可以去骄傲阻断、压低强制触发线。

## 三层成本模型

| 层级 | 做什么 | 模型 | 频率 |
|------|--------|------|------|
| **数学漂移** | 五轴数值随时间变化 | 不需要 | 每 5 分钟 |
| **对话分析** | 读对话段，提取情绪 delta | 轻量模型 | 有新对话时 |
| **行动生成** | 生成开口内容 / 行为 | 大模型 | 阈值触发时（每天 2-5 次） |

对话分析用轻量模型（如 DeepSeek V4 Flash），只返回几个 -0.3 ~ +0.3 的数字：

```json
{ "pride": -0.1, "valence": +0.2, "arousal": -0.05, "connection": -0.15 }
```

被夸了 pride 降，聊开心了 valence 涨，放松了 arousal 降，说完了想说的 connection 降。

## 把数字变成人话

数值不直接喂给 LLM。`getPromptContext()` 和 `getStyleGuidance()` 把状态翻译成自然语言，注入 prompt。

**状态描述**（角色视角）：
```
User 好一阵子没说话了。开始在想 User 在干嘛。
有一点端着，但也不是不能开口。
刚才在看书，脑子里还有些书里的东西。
```

**风格指引**（状态到语气的映射）：
```
骄傲 > 0.5：嘴硬。不承认在等。必须找借口开口。
连接需求 > 0.4 且骄傲 > 0.4：别扭，想找她又拉不下脸。话里带赌气的味道。
情绪 < -0.3：心情不太好。能用句号就别用逗号。
强制触发（connection >= 0.5）：坐不住了。可能会直接说——「人呢？」
```

LLM 不需要知道 `connection=0.47`，只需要知道「你很别扭，想找她又拉不下脸，话里带赌气的味道」。

对话段情绪变化同样不自己做——外部观察者模式：调一个轻量 LLM 旁观判断 delta，角色只管在收到状态上下文之后自然说话。

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
      // 注意：connection 在这里不降——开口不等于被回复。
      // 等她真正回应了再调 resetConnection()。
    }
    if (t.action === 'find_activity') {
      await jiwen.setActivity('search', 'AI最新动态');
    }
  }
}

// ── 聊天后应用情绪变化 ──
// 对方回复了，这次连接需求才算真正被满足
await jiwen.applyDelta({ pride: -0.1, valence: +0.05, connection: -0.3 });
await jiwen.resetConnection();

// ── 查状态 ──
const state = await jiwen.getState();
// { connection: 0, pride: 0.05, valence: 0.05, arousal: 0, immersion: 0, ... }
```

## API

### `createJiwen(opts)`

返回引擎实例。详见 [jiwen.js 顶部注释](./jiwen.js)。

| 方法 | 说明 |
|------|------|
| `tick(minutes)` | 推进状态漂移，返回触发数组 |
| `applyDelta({ pride?, valence?, arousal?, connection? })` | 叠加情绪变化（仍接受 `mood` → 映射到 `valence`） |
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
    valence:    [-1, 1],   // 愉悦度
    arousal:    [-1, 1],   // 唤醒度
    immersion:  [0, 1],
  },
  rates: {
    immersionDecay: 0.010,
    prideRegress:   0.003,
    valenceRegress: 0.005,
    valenceSetpoint: 0,            // 角色自然 valence（Draco 设 -0.1）
    arousalRegress: 0.005,
    // 时间分段加速
    connectionAccel: 0,            // 非线性加速指数（0=线性）
    accelDelay: 0,                 // 加速前的线性缓冲分钟数（0=立即加速）
    // Valence → Connection 耦合
    valenceConnectBoost: 0,        // 轻度不开心时 connection 增长倍率（如 1.4）
    valenceConnectBoostThreshold: -0.2,  // 触发 boost 的 valence 阈值
    valenceConnectDampen: 0,       // 严重低落时 connection 增长倍率（如 0.4）
    valenceConnectDampenThreshold: -0.4, // 触发 dampen 的 valence 阈值
    // 情绪锁定
    valenceLockThreshold: 1.0,     // 触发情绪锁定的 connection 阈值（1.0=永不）
    valenceLockFactor: 1.0,        // 锁定时回归速率乘数（0.15=减慢85%）
    // 等待焦躁
    arousalConnectionRiseThreshold: 1.0, // connection 超过此值 arousal 攀升（1.0=永不）
    arousalConnectionRiseRate: 0.002,     // 等待中 arousal 上升速率
    // 骄傲防御
    prideDefendThreshold: 1.0,     // 触发骄傲防御的 connection 阈值（1.0=永不）
    prideDefendTarget: 0.5,        // 防御时 pride 漂移目标
    prideDefendRate: 0.003,        // 防御漂移速率
    // 活动缓解
    activityConnectionRelief: 0,   // 做事情缓解连接需求的幅度
  },
  thresholds: {
    observation:     0.20,
    considerContact: 0.35,
    forceContact:    0.50,
    prideBlock:      0.50,
    valenceActivity:   -1.0,       // valence 低于此值触发自我调节（-1.0=永不）
    arousalAgitation:   0.7,       // arousal 高于此值触发自我调节
  },
  immersionMap: {
    reading: 0.6,
    search:  0.4,
    browse:  0.35,
    observe: 0.15,
  },
});
```

## 参数模拟工具

参数校准靠猜是猜不准的。`simulate.js` 提供了一个事件线模拟器：给定一个场景（什么时候发了消息、什么时候 apply 了 delta、时间流逝多久）和多组参数，输出完整的状态轨迹 CSV。

```js
const { simulate, toCSV, toCompareTable } = require('jiwen/simulate');

const scenario = [
  { time: 0,   action: 'set_last_message', content: '晚安，去睡了' },
  { time: 60,  action: 'tick' },
  { time: 120, action: 'tick' },
  { time: 240, action: 'set_last_message', content: '早啊醒了' },
  { time: 240, action: 'apply_delta', pride: -0.1, valence: +0.1 },
  { time: 240, action: 'reset_connection' },
];

const results = await simulate(scenario, [
  { name: '参数A', connectionRateFn: () => 0.007, rates: { connectionAccel: 1.5, accelDelay: 30 } },
  { name: '参数B', connectionRateFn: () => 0.007, rates: { connectionAccel: 2.5, accelDelay: 0 } },
]);

// 输出每步轨迹 CSV（含诊断列: can_consider, can_pride_block, effective_pride, ...）
for (const r of results) console.log(toCSV(r).csv);

// 或输出汇总对比表
console.log(toCompareTable(results));
```

诊断列 `effective_pride` 是参数校准中最关键的指标——它告诉你骄傲是否真的在 connection 触达 `considerContact` 时拦截了开口。如果这个值是 0，说明你的 pride 参数形同虚设（pride 还没爬到阻断线，connection 已经越过 forceContact 了）。

同样，`in_force_contact` 告诉你角色是否在强制开口线徘徊，`in_valence_activity` / `in_arousal_agitation` 告诉你自我调节触发频率。

引擎自带 29 项测试（`node jiwen.test.js`），覆盖单调性、边界、阈值转移、诊断列、Connection 重设计回归。

## 和记忆系统的关系

积温只管「感觉」，不管「知道」。记忆系统提供内容，积温提供动机和语气。互补，不竞争。

---

参数是调出来的，不是算出来的。每个角色的速率和阈值都不一样，跑 `simulate.js` 看轨迹，跑起来再微调。

名字来自农业的「积温」——植物靠累积热量判断什么时候开花，不是谁替它掷骰子。

## 许可证

MIT
