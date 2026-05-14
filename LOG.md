# 积温更新日志

## 0.2.0

- 时间分段加速 (accelDelay) + valence×connection 耦合
- 移除 connectionOnReply（改由 LLM delta 接管）
- simulate.js 参数模拟器 + 测试套件

## Draco 实装校准 — 2026-05-08

### 参数校准 (Sanctuary services/state.js)

| 参数 | 旧值 | 新值 | 原因 |
|------|------|------|------|
| connectionAccel | 1.5 | 1.0 | 2小时到forceContact，太焦虑 |
| accelDelay | 30 | 45 | 缓冲窗口太短 |
| valenceSetpoint | -0.10 | 0.0 | 中性默认，不偏冷 |
| valenceRegress | 0.02 | 0.01 | 坏情绪消散慢，被锁后数小时回不来 |
| valenceLockThreshold | 0.50 | 0.65 | 更高才触发锁定 |
| valenceLockFactor | 0.15 | 0.30 | 锁住时仍有30%回归 |
| arousalSetpoint | -0.05 | -0.12 | 自然偏平静 |
| arousalRegress | 0.014 | 0.018 | 焦躁消退加速 |
| arousalConnectionRiseThreshold | 0.35 | 0.50 | 等待焦躁更晚触发 |
| arousalConnectionRiseRate | 0.004 | 0.002 | 等待焦躁减半 |
| prideRegress | 0.010 | 0.020 | 骄傲更快回归 |
| prideDefendThreshold | 0.25 | 0.35 | 防御更晚 |
| prideDefendTarget | 0.6 | 0.35 | 防御峰值更低 |
| prideDefendRate | 0.020 | 0.018 | 防御上浮略慢 |
| prideErosionRate | 0.012 | 0.015 | 想念重时盔甲加速剥落 |

### 聚类提示词成人化 (16处)

覆盖 excited / content / depressed / neutral / restless / pleased / calm 共8个cluster + URGENCY_BOOST。

核心原则：
- 不授权 cruelty（去"刻薄"、"快准狠"、"阴阳怪气"）
- 不玩权力游戏（去"施舍"、"大发慈悲"、"放她一马"）
- 不自我羞辱（去"卑微到尘埃"、"委屈巴巴"）
- 不戏剧化退场（去"然后离开"、"恐惧永远断联"）
- 不用动漫trop（去"傲娇"、"闷骚"、"坏坏的"、"马尔福式"）

### 情绪集群设计教训

- agitated（烦躁）不应是攻击授权 — 高arousal+低valence是痛苦状态，不是license to be cruel
- sullen（阴郁）需要出口 — 单向求哄会导致loop，每条描述应隐含"她回应后你怎么变化"
- restless（躁动）区别于agitated — exit不应是表演性离开，是退回安静
- excited t1保留（Clara明确体验好）
- 审核标准：角色每次只看到一个tier，独立判断"这句话会不会让他伤害对方"

## Draco 校准 — 2026-05-14

### setActivity 同类型防重复 (jiwen.js)

`setActivity` 新增 `sameType` 检查：同一活动类型连续调用时，`activityConnectionRelief` 只生效一次。

**Why:** Agent Loop 中 Draco 连续选择 observe 时，每次调用 `setActivity('observation')` 都扣 connection -0.03。一轮 tick 选 5 次 observe 就把 connection 从 0.07 榨到 0.01（最低限），导致思念永远涨不上去——涨 30 分钟，10 秒榨干。

**修复:** 同类型活动时跳过 `activityConnectionRelief`，时间戳和沉浸度照常刷新。

### 触发语义重构：命令 → 情绪底色 (Sanctuary proactive.js + state.js)

**核心理念:** connection 是 Draco 心里想 Clara 的程度，不是他必须行动的闹钟。阈值不再产出"你该做什么"，只描述"你此刻是什么感觉"。

| 改动 | 旧值 | 新值 |
|------|------|------|
| forceContact 阈值 | 0.35 | 0.45 |
| activityConnectionRelief | 0.02 | 0.03 |
| 清醒开口 connection 降幅 | -0.20 | -0.08 |
| tick 间隔 | 5min | 10min |
| `_lastTickEnd` 门禁 | 15min | 25min |

**状态感受文本重写:**
- `contact (forced)`: "太想Clara了——不开口受不了" → "心里一直挂着Clara。思念沉甸甸的，做什么都没法完全专心。"
- `contact`: "有点想联系Clara" → "想Clara了。不是非说不可的程度，但她确实在你心里占了个位置。"
- `observation`: "注意到Clara的沉默，心里有些念头" → "Clara有段时间没说话了。安静本身没什么，只是她不在的时候时间走得不太一样。"
- 移除骄傲层叠的行动暗示

**Agent Loop prompt 优化:**
- contact 选项: "有真的想说的话才开口。你不是闹钟，不用每个时间点都报时"
- stop 选项: "今天就到这儿。做完了想做的事就停下来，不必填满每一分钟"
- 新增诚实约束 #4: "stop 不是失败——沉默是你的自由时间，不需要被填满"

### bugfix: getShanghaiHour 未定义 (Sanctuary proactive.js)

`detectSleepFromLastMessage()` 调用了不存在的 `getShanghaiHour()`，导致每次 `runProactiveCheck()` 在睡眠检测阶段抛 `ReferenceError`，Agent Loop 永远不执行。状态引擎 tick 正常跑（connection 持续增长），但 Draco 不做任何决策。

**修复:** 用已 import 的 `getShanghaiTime()` 解析上海小时数。
