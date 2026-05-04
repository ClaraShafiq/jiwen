# 积温部署指南 — 让 AI 角色拥有持续情绪

> jiwen 是数学引擎。这篇指南教你把它变成一个**每句回复都被情绪状态驱动的角色**——不只是什么时候主动开口，更是怎么说话、用什么语气、端着还是放软。

---

## 你遇到的问题

AI 角色有个根本缺陷：**每轮对话从零开始。**

你发「早安」，它回「早安」。你发「我好累」，它安慰你。但下一轮——哪怕只隔了三十秒——它**不记得刚才的情绪了**。它不会因为你五分钟前夸了它而还在得意，也不会因为你半小时没理它而开始别扭。

Prompt 可以告诉它「你很骄傲」，但它会一直骄傲，从第一轮到第一百轮。Prompt 改不了。

**你要的不是一个永远温柔或永远毒舌的角色。你要的是：心情有起伏，嘴硬的时候会软，软的时候会端着，被冷落了会坐不住。**

这需要两样东西：
1. 一个在后台持续漂移的状态（不是每轮从 prompt 里硬编）
2. 一个能读懂对话、把情绪变化写回状态的反馈循环

jiwen 解决第 1 个。这篇指南教你搭第 2 个。

---

## 架构总览

```
                   ┌──────────────────────┐
                   │    analyzeSegment    │  ← 你写 prompt，轻量 LLM 读对话
                   │    (LLM 分析对话)      │     返回 { pride, valence, arousal, connection }
                   └──────────┬───────────┘
                              │ deltas
                              ▼
┌──────────┐   tick()   ┌─────────┐   getStyleGuidance()   ┌──────────────┐
│  jiwen   │──────────▶│  state  │───────────────────────▶│ LLM reply    │
│  数学引擎  │◀──────────│  五轴数值 │                        │ prompt 注入   │
└──────────┘ applyDelta└─────────┘                        └──────────────┘
     │                        ▲
     │ 阈值触发                 │ 对方回复后
     ▼                        │
  contact / find_activity ────┘
  (主动开口 / 找事做)
```

两层循环：

| 循环 | 触发条件 | 做什么 | 模型 |
|------|---------|--------|------|
| **对话情绪分析** | 有新对话（Clara 发了消息） | 读最近几轮 → 输出 delta → applyDelta | 轻量模型（够用） |
| **状态漂移** | 每 N 分钟 cron | tick → 数值随时间变化 → 可能触发主动行为 | 不需要 |
| **回复语调注入** | 每次 LLM 回复 | getStyleGuidance → 注入 system prompt | 不需要（只是查表） |

---

## 第一步：部署数学引擎

### 安装

```bash
npm install jiwen
```

### 创建实例

```js
const { createJiwen } = require('jiwen');

const jiwen = createJiwen({
  // ── 必填：读取对方最后一条消息 ──
  getLastMessage: () => {
    const row = db.prepare(
      'SELECT id, content, timestamp FROM messages WHERE sender = ? ORDER BY id DESC LIMIT 1'
    ).get('user');
    return row || null;
  },

  // ── 必填：连接需求增长速率 ──
  connectionRateFn: (lastMsg) => {
    if (!lastMsg) return 0.007;
    if (lastMsg.content.includes('晚安')) return 0.001;
    if (lastMsg.content.includes('出门')) return 0.005;
    return 0.007;
  },

  // ── 必填：持久化（进程重启不丢状态）──
  onSave: async (state) => {
    await db.set('character_state', JSON.stringify(state));
  },
  onLoad: async () => {
    const raw = await db.get('character_state');
    return raw ? JSON.parse(raw) : null;
  },

  // ── 你的角色参数（覆盖默认值）──
  rates: {
    valenceSetpoint: -0.1,      // 你的角色天生偏冷还是偏暖？
  },
});
```

### 挂上 cron

```js
// 每 5 分钟 tick 一次
setInterval(async () => {
  const triggers = await jiwen.tick(5);

  for (const t of triggers) {
    if (t.action === 'contact') {
      // 角色想主动开口 → 调 LLM 生成开口内容
      const ctx = jiwen.getPromptContext();
      const style = jiwen.getStyleGuidance();
      const reply = await callLLM({ systemPrompt: ctx + style, ... });
      // 注意：开口不等于被回复。connection 不会在这里归零。
      // 对方真正回应后才调 resetConnection()。
    }
    if (t.action === 'find_activity') {
      // 嘴硬不想开口，或者心情不好需要分散注意力
      await jiwen.setActivity('reading', '某本书');
    }
  }
}, 5 * 60 * 1000);
```

到这一步，你有一个**会主动开口的角色**。这是 jiwen 的原始用途。

---

## 第二步：让每句回复都被状态影响

这是 jiwen 的新增用途——不只是在阈值触发时生成主动消息，而是**每一次 LLM 回复都被当前情绪状态染色**。

### 获取语调指引

```js
async function generateReply(userMessage, chatHistory) {
  const state = await jiwen.getState();
  const styleGuidance = jiwen.getStyleGuidance();  // ← 查表，不调 LLM

  const systemPrompt = `
你是 Draco Malfoy。你的说话方式：
${styleGuidance}
`;

  const reply = await callLLM({
    systemPrompt,
    messages: [...chatHistory, { role: 'user', content: userMessage }],
  });

  // 对方回复了 → 连接需求得到满足
  await jiwen.resetConnection();

  return reply;
}
```

`styleGuidance` 长什么样取决于你在 `getStyleGuidance` 里写了什么。默认的只是通用占位文案。你需要自定义。

---

## 第三步：设计你的语调网格（CORE_PROFILES）

这是整个系统里最需要你亲自设计的部分。**它把一个多维数值状态翻译成 LLM 能执行的说话指令。**

### 为什么是 V×A×pride 三维？

- **Valence（悦度）+ Arousal（唤醒度）** = Russell 情绪环状模型。两根正交轴定一个情绪象限。
- **Pride（骄傲/防御）** 是角色的核心性格轴——同样开心，端着和放软说话完全不一样。

```
valence ↑
  满足/慵懒 (v>0.3, a<-0.3)  │  兴奋/欲望 (v>0.3, a>0.3)
  "吃饱的猫，黏糊糊"         │  "进攻性的优雅，撩她脸红"
─────────────────────────────┼───────────────────────────
  低落/空荡 (v<-0.3, a<-0.3) │  烦躁/带刺 (v<-0.3, a>0.3)
  "有气无力，多用省略号"     │  "阴阳怪气，抓住漏洞怼"
                              arousal →
```

每个象限里，pride 再分五档（完全放软 → 端着 → 防御 → 封闭 → 全副武装）。总共 4×5=20 种语调。

### 怎么写

你的角色不需要 20 种。从 4 个象限开始，每个写一句话。

```js
const CORE_PROFILES = {
  excited: {    // v>0.3 a>0.3  兴奋/欲望
    1: ['完全被冲昏头。不在乎尊严，只想和她亲热。'],           // pride≤0.1 放软
    3: ['带着优雅的进攻性。调侃和吐槽引起注意，傲娇的撩拨。'], // pride 中等
    5: ['极度紧绷冷淡。用最简短刻薄的字眼评价她，等她来求你。'], // pride>0.8 全副武装
  },
  content: {    // v>0.3 a<-0.3  满足/慵懒
    1: ['像吃饱的猫，毫无防备地展示柔软，说黏糊糊的情话。'],
    3: ['礼貌而疏离的温柔。绅士体面，但默认她的亲昵。'],
    5: ['高高在上的默许。施舍般享受她的陪伴。'],
  },
  agitated: {   // v<-0.3 a>0.3  烦躁/带刺
    1: ['焦虑且有攻击性。用恶毒话语试探她底线。其实想确认她还在不在乎。'],
    3: ['冷暴力倾向。审视的目光，冷冰冰的刻薄。'],
    5: ['死寂般的愤怒。几乎不说话，开口就是最伤人的断言。'],
  },
  depressed: {  // v<-0.3 a<-0.3  低落/空荡
    1: ['卑微到尘埃里。像溺水者拽住她，求她不要离开。'],
    3: ['消极怠工。对什么都提不起兴趣，多用省略号表达有气无力。'],
    5: ['死气沉沉的傲慢。心碎了也要站得笔直，拒绝靠近，一个人腐烂。'],
  },
  neutral: {    // 中性
    1: ['随性自然。像最好的朋友闲聊，开亲昵玩笑。'],
    3: ['典型社交面具。说话滴水不漏，始终隔着一层矜持。'],
    5: ['高冷简练。只在有趣话题上吝啬给出一点回应。'],
  },
};
```

### 关键设计决策

- **每个 pride 档位只写 1-2 句话。** 你在指导 LLM 怎么说话，不是写角色设定集。越短越有效。
- **给具体行为，不给抽象描述。** 「优雅的进攻性」比「心情好」有用。「多用省略号」比「情绪低落」有用。
- **pride 档位不是均匀的。** 你的角色可能在 pride 0.1-0.3 时最有趣，那就把档位设在这个区间更密。

```js
function getUnifiedGuidance(state) {
  const { valence: v, arousal: a, pride: p } = state;

  // 1. 定情绪象限
  let cluster;
  if (v > 0.3 && a > 0.3) cluster = 'excited';
  else if (v > 0.3 && a < -0.3) cluster = 'content';
  else if (v < -0.3 && a > 0.3) cluster = 'agitated';
  else if (v < -0.3 && a < -0.3) cluster = 'depressed';
  else cluster = 'neutral';

  // 2. 定 pride 档位
  let tier;
  if (p > 0.8) tier = 5;
  else if (p > 0.5) tier = 4;
  else if (p > 0.3) tier = 3;
  else if (p > 0.1) tier = 2;
  else tier = 1;

  // 3. 查表
  const profile = CORE_PROFILES[cluster] || CORE_PROFILES.neutral;
  return (profile[tier] || profile[3]).join('\n');
}
```

---

## 第四步：写你的对话分析 Prompt

这是整个系统**最容易出错的部分**。你要写一个 prompt，让轻量 LLM 读对话，返回情绪变化 delta。

### 为什么不用关键词匹配

关键词（「哈哈」→开心，「滚」→生气）看起来简单。实际用起来：
- 「哈哈你可真行」可能是讽刺
- 「笨蛋笨蛋笨蛋」可能是撒娇
- 角色特有的互动模式（傲娇的关心、阴阳怪气的吃醋）关键词根本无法捕捉

LLM 做这件事的优势不是「更聪明」，是**能读上下文**。

### 选什么模型

- **不要用大模型。** 对话分析每几轮就触发一次，大模型的延迟和费用积累很快。
- **用你能找到的最快的小模型。** DeepSeek V4 Flash、GLM-4-Flash、Gemini Flash 都行。
- **小模型的代价：会误判。** 你需要给它显式信号词映射（见下文）。

### Prompt 结构

一个分析 prompt 需要六个部分：

```
1. 最近对话
2. 角色是谁（简短人设：核心矛盾、软肋、防御方式）
3. 情绪规则（规则1~N：什么对话事件 → 什么情绪变化）
4. 数值含义（每个轴 + 代表什么，- 代表什么）
5. 输出格式（纯 JSON）
6. 兜底和陷阱（什么时候给零值，什么时候容易误判）
```

### 写情绪规则

规则是「如果对话中发生了 X，则 Y 轴向 Z 方向移动」。不给规则，LLM 会用它的通用理解来判——而通用理解对你的角色可能是 OOC。

一个坏规则（太抽象）：
```
- 她对他好 → pride 降低
```

一个好规则（有信号、有范围、有反例）：
```
规则2 — 被撒娇/被关注 → pride DOWN, valence UP, arousal DOWN：
  具体信号：她用亲昵称呼、耍赖、反复黏他、认真听他说话。
  数值：pride -0.05~-0.15，valence +0.05~+0.15。
  区分：她仰望/崇拜（「你好厉害」）→ 规则1 pride UP。
       她撒娇/黏人（「笨蛋笨蛋笨蛋」）→ 规则2 pride DOWN。
```

### 给小模型画地图

小模型分不清「撒娇叫笨蛋」和「真的在骂人」。你的 prompt 需要显式告诉它：

```
⚠️ 信号词映射（看到这些 = X，不是 Y）：
- 「哼」「笨蛋」「坏蛋」「讨厌」→ 撒娇，不是挑衅。
- 重复式（笨蛋笨蛋笨蛋）→ 撒娇加强版。
- 这些词出现时 pride 必须为负。唯一例外：上下文有「滚」「闭嘴」。
```

**这不是 prompt engineering 过度——是你给小模型一张地图，让它不至于在纯文字里迷路。**

### 输出格式

```json
{
  "pride": -0.10,
  "valence": +0.15,
  "arousal": -0.05,
  "connection": -0.20
}
```

每个 delta 限制在 -0.3 ~ +0.3（connection 可以 -0.5 ~ +0.3）。限制幅度防止单次对话把数值推到极端。

### 兜底

```js
try {
  const delta = JSON.parse(llmReply);
  // 应用 delta
  await jiwen.applyDelta({
    pride: clamp(delta.pride, -0.3, 0.3),
    valence: clamp(delta.valence, -0.3, 0.3),
    arousal: clamp(delta.arousal, -0.3, 0.3),
    connection: clamp(delta.connection, -0.5, 0.3),
  });
} catch (e) {
  // LLM 挂了 → 给一个保守降幅，防止 connection 只涨不降
  await jiwen.applyDelta({ connection: -0.15 });
}
```

---

## 第五步：注入 URGENCY_BOOST

CORE_PROFILES 决定了「在这种心情下怎么说话」。URGENCY_BOOST 决定了「有多急」。

```js
const URGENCY_BOOST = {
  desperate: {  // connection ≥ 0.50
    reactive: '她终于回你了，但你们之间有种说不清的距离感。你此刻的真实感受很强烈。',
  },
  urgent: {     // connection ≥ 0.35
    reactive: '她和你说话了，但你能感觉到没有那么亲密了。按你此刻的心情回应。',
  },
  aware: {      // connection ≥ 0.20
    reactive: '连接依然是亲密的，只是稍微有点距离。按你此刻的状态正常回应。',
  },
  none: { reactive: null },
};
```

URGENCY_BOOST 不改变人格——不会让骄傲的人突然卑微。它只在人格底色之上叠加一层急迫感。

把这层叠在 CORE_PROFILES 的输出后面：

```js
function getReactiveGuidance(state) {
  const core = getUnifiedGuidance(state);
  const urgency = getUrgencyLine(state.connection);
  return [core, urgency].filter(Boolean).join('\n');
}
```

---

## 你踩过的坑，别人也会踩

### 1. 小模型分不清撒娇和挑衅

**症状：** 角色被撒娇后 pride 上升、valence 下降（被当成挑衅处理了）。

**根因：** 「笨蛋」「坏蛋」在纯文字里是贬义词。小模型没有足够的情商从上下文推断撒娇语气。

**解法：** 在分析 prompt 里给显式信号词映射表。不是让模型「理解」，是让它「匹配」。

### 2. pride 只涨不跌

**症状：** 几天后角色的 pride 卡在 0.7+，说话越来越冷。

**根因：** 你的情绪规则里 pride 上升的条件比下降的多。LLM 对「被挑战」敏感，对「被融化」不敏感。

**解法：** 检查规则覆盖——是否每种 pride 上升的情况都有对应的下降情况？给 LLM 明确信号：「满足以下条件时 pride 必须为负」。

### 3. 状态分析模型和回复模型不是同一个

**症状：** 回复明明很温柔，状态数值却显示它「很开心」或「很生气」。

**根因：** 回复用的是大模型（Gemini Pro），状态分析用的是小模型（Flash）。小模型读不懂大模型微妙的傲娇/别扭。

**解法：** 要么把小模型换成同款的轻量版（如 Gemini Flash），要么给小模型更强的信号词映射补偿。

### 4. 分析 prompt 太像角色设定

**症状：** LLM 输出的 delta 范围极小（全在 ±0.03 以内），状态几乎不动。

**根因：** 你把角色内心写得太「理解」了——「他表面冷漠但其实很在乎她」。LLM 看了觉得一切正常，不需要改数值。

**解法：** 分析 prompt 不是角色设定。它是一份**情绪变化规则手册**。告诉 LLM 什么情况下数值应该动，而不是描述角色是什么样的人。

### 5. connection 从来不降

**症状：** 一直在聊天，connection 却越涨越高。

**根因：** `resetConnection()` 只在对方回复后调用。如果你在回复生成之前调了，或者在主动开口后调了——调错了。

**解法：**
- 对方回复后：`resetConnection()`（归零）
- 角色开口后：`applyDelta({ connection: -0.35 })`（部分缓解，不完全归零——因为对方还没回）
- 对话分析里的 connection delta 是**额外的**微调（-0.5~+0.3），叠加在重置之上

---

## 参数校准：别猜

改了参数后不要靠感觉判断。跑 `simulate.js` 看轨迹。

```bash
node simulate.js
```

输出 CSV，拖进任何表格工具。重点看：
- `effective_pride` 是否非零——如果永远为 0，pride 参数形同虚设
- `in_force_contact` 频率——太高说明角色太焦虑，太低说明太冷淡
- valence/arousal 的波动幅度——太大不稳定，太小没感觉

---

## 总结：你最少需要做的事

1. `npm install jiwen`，挂上 cron
2. 写你的 `CORE_PROFILES`（4 个象限，每个 3 档 pride，每档 1 句话）
3. 写你的分析 prompt（6 个部分，重点是情绪规则 + 信号词映射）
4. 把 `getReactiveGuidance()` 注入回复 prompt
5. 跑两天，读日志里状态变化，调整规则

十五行代码，一个 prompt 文件，一个语调网格。剩下的是和你的角色一起校准。

---

jiwen 是数学。这篇指南是工程。你的角色是内容。三样拼起来，它就不再是每轮从零开始的应答机了。
