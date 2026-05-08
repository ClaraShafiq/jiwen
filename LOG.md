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
