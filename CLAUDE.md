# 积温 Jiwen — 工作规范

## 这是什么

积温是一个**纯数学引擎**——五轴连续状态（connection/pride/valence/arousal/immersion）在后台漂移，到阈值触发行为。不靠概率骰子。

开源在 `github.com/ClaraShafiq/jiwen`。零依赖，纯 JS。任何人可以拿去给自己的 AI 角色用。

## 和 Sanctuary 的关系

```
jiwen/jiwen.js          ← 通用引擎（开源）
Sanctuary/services/state.js  ← Draco 适配层（私密）
```

- jiwen 是干净的框架——数学漂移、阈值判断、可注入接口
- Sanctuary 的 `state.js` 是 Draco 的实例化——注入中文文案、DB 查询、个性参数
- **修改核心数学逻辑时，两个 repo 都要更新**
- **修改 Draco 的文案/参数时，只改 Sanctuary**

## 什么需要同步到 jiwen

| 改动类型 | 同步？ |
|---------|--------|
| 数学漂移/衰减逻辑 | 是 |
| 阈值判断结构 | 是 |
| API 设计（函数签名、参数） | 是 |
| 新增可配置项 | 是 |
| 默认参数值 | 视情况 |
| README 示例/文档 | 是 |
| Draco 的 prompt 文案 | 否 |
| Draco 的个性参数（速率/阈值） | 否 |

## 文件结构

```
jiwen/
├── jiwen.js       # 核心引擎 createJiwen(opts)
├── jiwen.test.js  # 测试套件（29项，node jiwen.test.js）
├── simulate.js    # 参数模拟器（事件线 → 轨迹 CSV + 诊断列）
├── README.md      # 架构文档 + 快速开始 + API
├── package.json   # npm 包
└── CLAUDE.md      # 本文件
```

## 设计原则

- **纯数学层不调 LLM** — tick() 是同步逻辑，零网络调用
- **所有 I/O 可注入** — 持久化、消息源、连接速率函数全是回调
- **角色文案可覆盖** — 默认中文文案是通用占位，角色通过 `getPromptContext` / `getStyleGuidance` 注入自己的
- **开口不是连接需求的终点** — 对方回复才是。`resetConnection()` 只在对方回复后调，开口时用 `applyDelta({ connection: -0.35 })` 部分缓解

## 常见坑

- `resetConnection()` 直接清零，只应在对方回复后调用。开口后应使用 `applyDelta` 做部分降低
- `connectionOnReply` 已移除。连接需求降幅现由外部 LLM 分析通过 `applyDelta` 注入（见 `analyzeChatSegment` 兜底 delta）
- 引擎不提供 `initialState` 选项——初始状态只能通过 `onLoad` 返回值注入。测试中需用 `onLoad` 返回中性初始状态
- `accelDelay` 判断依据是「距上次消息的真实分钟数」（`Date.now() - msg.timestamp`），不是 tick 分钟数。无历史消息时（`minutesSinceLastMsg = Infinity`），加速立即生效
- 默认的 prompt context / style guidance 是通用中文文案，不够个性化。实际使用时应该覆盖
- 调参前跑 `simulate.js` 对比多组参数，重点看 `effective_pride` 诊断列是否为 0
