// ============================================================
// 积温 — 不靠概率骰子的 AI 角色主动意识引擎
// 五轴连续状态：connection / pride / valence / arousal / immersion
// 数学漂移 + 阈值触发 + 可注入持久化/消息源/LLM分析
// 附带 simulate.js 参数模拟器 + jiwen.test.js 测试套件（29项）
// ============================================================
//
// 0.2.0 — 时间分段加速 (accelDelay) + valence×connection 耦合
//         + 移除 connectionOnReply（改由 LLM delta 接管）
//         + simulate.js 参数模拟器 + 测试套件

/**
 * 创建一个积温引擎实例。
 *
 * @param {Object} opts
 * @param {Object} [opts.initialState]   — 初始状态（默认全 0）
 * @param {Object} [opts.axes]           — 轴名称到 [min, max] 范围的映射
 * @param {Object} [opts.rates]          — 每轴每分钟漂移速率
 * @param {Object} [opts.thresholds]     — { observation, considerContact, forceContact, prideBlock, valenceActivity, arousalAgitation }
 * @param {Object} [opts.immersionMap]   — 活动类型 → 初始沉浸度
 * @param {Function} opts.connectionRateFn — (lastMessage) => number  每分钟连接需求增长速率
 * @param {Function} opts.onSave         — async (state) => void  持久化回调
 * @param {Function} opts.onLoad         — async () => state|null 加载回调
 * @param {Function} opts.getLastMessage — () => { id, content, timestamp }|null  消息源
 * @param {Object}  [opts.persona]       — 人格描述文本（用于默认 prompt context）
 *   { subjectName: '她', selfName: '你', subjectPronoun: '她' }
 */
function createJiwen(opts) {
  if (!opts) throw new Error('积温: opts is required');

  // ── 轴定义 ──────────────────────
  const axes = opts.axes || {
    connection: [-0, 1],
    pride:      [-1, 1],
    valence:    [-1, 1],   // 愉悦度：好受 ↔ 难受
    arousal:    [-1, 1],   // 唤醒度：平静 ↔ 焦躁/兴奋
    immersion:  [ 0, 1],
  };

  // ── 衰减 / 回归速率（每分钟） ──
  const rates = Object.assign({
    connectionGrowth: null, // 由 connectionRateFn 动态决定
    connectionOnReply: 0.20,  // [已弃用] 对方回复时 connection 降幅（现由 LLM delta 接管）
    immersionDecay:   0.010,
    prideRegress:     0.003,

    // 时间分段加速：距上次消息 < accelDelay 分钟时线性增长（accel=1），
    // 超过后才启用 connectionAccel。默认 0 = 立即加速，向后兼容
    accelDelay: 0,
    connectionAccel: 0,

    // Valence（愉悦度）：回归角色设定点
    valenceRegress:    0.005,   // 回归速率
    valenceSetpoint:   0,       // 角色自然状态下的 valence（0=中性）

    // 情绪锁定：connection 高时 valence 回归变慢（negativity bias）
    valenceLockThreshold: 1.0,  // connection 超过此值触发锁定（1.0=永不）
    valenceLockFactor:    1.0,  // 回归速率乘数（0.15=减慢85%）

    // Valence → connection 增长倍率：轻度不开心时想要安慰（>1.0），
    // 严重低落时自我封闭（<1.0）。默认关闭，向后兼容
    valenceConnectBoost:            0,   // 倍率值（如 1.4 = 增长 +40%）
    valenceConnectBoostThreshold:  -0.2, // valence 低于此值时触发 boost
    valenceConnectDampen:           0,   // 倍率值（如 0.4 = 增长 -60%）
    valenceConnectDampenThreshold: -0.4, // valence 低于此值时触发 dampen

    // Arousal（唤醒度）：回归平静，但等待会让人焦躁
    arousalRegress:               0.005,  // 回归 0 的速率
    arousalConnectionRiseThreshold: 1.0,  // connection 超过此值 arousal 上升（1.0=永不）
    arousalConnectionRiseRate:     0.002, // connection 高时 arousal 上升速率

    // 骄傲防御：被冷落时 pride 向正向漂移（心理防御）
    prideDefendThreshold: 1.0, // connection 超过此值触发防御（1.0=永不）
    prideDefendTarget:    0.5, // 防御时 pride 漂移目标
    prideDefendRate:      0.003, // 防御漂移速率

    // 活动缓解：做事情能部分缓解连接需求
    activityConnectionRelief: 0,   // setActivity 时 connection 降幅
  }, opts.rates);

  // ── 阈值 ────────────────────────
  const thresholds = Object.assign({
    observation:     0.20,
    considerContact: 0.35,
    forceContact:    0.50,
    prideBlock:      0.50,
    valenceActivity:   -1.0,   // valence 低于此值时触发自我调节（-1.0=永不）
    arousalAgitation:   0.7,   // arousal 高于此值时也触发自我调节（躁动难坐）
  }, opts.thresholds);

  const immersionMap = opts.immersionMap || {
    reading: 0.6,
    search:  0.4,
    browse_snitch: 0.35,
    browse:  0.35,
    observe: 0.15,
  };

  const persona = Object.assign({
    subjectName:     '对方',
    selfName:        '你',
    subjectPronoun:  'ta',
  }, opts.persona);

  // ── 内部状态 ────────────────────
  const DEFAULT_STATE = {
    connection: axes.connection[0],
    pride:      axes.pride[0],
    valence:    axes.valence[0],
    arousal:    axes.arousal[0],
    immersion:  axes.immersion[0],
    lastActivity: null,       // { type, label, at }
    lastTick: null,           // ISO
    lastChatAnalysis: null,   // ISO
    lastChatMessageId: null,
    claraStatus: 'active',     // 'active' | 'busy' | 'away' | 'sleeping' — 由 analyzeChatSegment LLM 分析
  };

  let state = { ...DEFAULT_STATE };
  let _loaded = false;

  // ── 加载 ────────────────────────
  async function load() {
    if (_loaded) return;
    try {
      const saved = opts.onLoad ? await opts.onLoad() : null;
      if (saved) {
        state = { ...DEFAULT_STATE, ...saved };
      }
    } catch (e) {
      console.warn('[积温] load failed, using defaults:', e.message);
    }
    _loaded = true;
  }

  async function save() {
    if (!opts.onSave) return;
    try {
      await opts.onSave({ ...state });
    } catch (e) {
      console.error('[积温] save failed:', e.message);
    }
  }

  async function ensureLoaded() {
    if (!_loaded) await load();
    return state;
  }

  // ── 心跳 tick ───────────────────
  async function tick(minutesElapsed) {
    await ensureLoaded();
    const now = new Date().toISOString();

    if (!minutesElapsed || minutesElapsed <= 0) return [];

    const mins = Math.min(minutesElapsed, 60);
    const stateBefore = { connection: state.connection, pride: state.pride, valence: state.valence, arousal: state.arousal, immersion: state.immersion };

    // ── 连接需求：时间分段加速 + valence 耦合 ──
    const lastMsg = opts.getLastMessage ? opts.getLastMessage() : null;
    const baseRate = opts.connectionRateFn
      ? opts.connectionRateFn(lastMsg)
      : 0.0007;

    // 距上次消息的分钟数（用于时间分段判断）
    let minutesSinceLastMsg = Infinity;
    if (lastMsg && lastMsg.timestamp) {
      minutesSinceLastMsg = (Date.now() - new Date(lastMsg.timestamp).getTime()) / 60000;
    }

    // 时间分段：accelDelay 分钟内线性增长，之后启用加速度
    const accelDelay = rates.accelDelay || 0;
    const useAccel = rates.connectionAccel > 0 && minutesSinceLastMsg >= accelDelay;
    const accelFactor = useAccel
      ? Math.pow(1 + state.connection, rates.connectionAccel)
      : 1;

    // Valence → connection 增长率耦合
    let valenceMultiplier = 1;
    if (rates.valenceConnectDampen > 0 && state.valence < rates.valenceConnectDampenThreshold) {
      valenceMultiplier = rates.valenceConnectDampen;
    } else if (rates.valenceConnectBoost > 0 && state.valence < rates.valenceConnectBoostThreshold) {
      valenceMultiplier = rates.valenceConnectBoost;
    }

    const effectiveRate = baseRate * accelFactor * valenceMultiplier;

    state.connection = clamp(
      state.connection + effectiveRate * mins,
      axes.connection[0],
      axes.connection[1]
    );

    // connectionOnReply 自动扣除已移除。
    // 连接需求降幅现由外部 LLM 分析（如 analyzeChatSegment）通过 applyDelta 注入。

    // ── 沉浸度：衰减 ──
    if (state.lastActivity) {
      const sinceActivity = (Date.now() - new Date(state.lastActivity.at).getTime()) / 60000;
      state.immersion = Math.max(
        axes.immersion[0],
        state.immersion - rates.immersionDecay * Math.min(mins, sinceActivity)
      );
      if (state.immersion <= 0.01 && sinceActivity > 60) {
        state.lastActivity = null;
        state.immersion = axes.immersion[0];
      }
    }

    // ── 骄傲：被冷落时防御性升高，否则回归0 ──
    if (state.connection >= rates.prideDefendThreshold) {
      // 防御机制：被冷落 → pride 朝 prideDefendTarget 漂移
      if (state.pride < rates.prideDefendTarget) {
        state.pride = Math.min(rates.prideDefendTarget, state.pride + rates.prideDefendRate * mins);
      } else if (state.pride > rates.prideDefendTarget) {
        state.pride = Math.max(rates.prideDefendTarget, state.pride - rates.prideDefendRate * mins);
      }
    } else {
      // 未触发防御：正常回归 0
      if (state.pride > 0) {
        state.pride = Math.max(0, state.pride - rates.prideRegress * mins);
      } else if (state.pride < 0) {
        state.pride = Math.min(0, state.pride + rates.prideRegress * mins);
      }
    }

    // ── Valence（愉悦度）：回归设定点，想念强烈时坏情绪难消散 ──
    const valenceRegressRate = state.connection >= rates.valenceLockThreshold
      ? rates.valenceRegress * rates.valenceLockFactor
      : rates.valenceRegress;

    if (state.valence > rates.valenceSetpoint) {
      state.valence = Math.max(rates.valenceSetpoint, state.valence - valenceRegressRate * mins);
    } else if (state.valence < rates.valenceSetpoint) {
      state.valence = Math.min(rates.valenceSetpoint, state.valence + valenceRegressRate * mins);
    }

    // ── Arousal（唤醒度）：平静是默认，但等待让人焦躁 ──
    if (state.connection >= rates.arousalConnectionRiseThreshold) {
      // 等待中：arousal 朝 +1 方向缓慢攀升（越等越焦躁）
      state.arousal = Math.min(axes.arousal[1], state.arousal + rates.arousalConnectionRiseRate * mins);
    } else {
      // 未被等待锁定时正常回归 0
      if (state.arousal > 0) {
        state.arousal = Math.max(0, state.arousal - rates.arousalRegress * mins);
      } else if (state.arousal < 0) {
        state.arousal = Math.min(0, state.arousal + rates.arousalRegress * mins);
      }
    }

    state.lastTick = now;

    // ── 日志：状态变化（有阈值触发时打印完整 diff）──
    const triggers = checkThresholds();

    if (triggers.length > 0) {
      console.log(
        `[积温] tick ${mins}min | ` +
        `c:${stateBefore.connection.toFixed(2)}→${state.connection.toFixed(2)} ` +
        `p:${stateBefore.pride.toFixed(2)}→${state.pride.toFixed(2)} ` +
        `v:${stateBefore.valence.toFixed(2)}→${state.valence.toFixed(2)} ` +
        `a:${stateBefore.arousal.toFixed(2)}→${state.arousal.toFixed(2)} ` +
        `i:${state.immersion.toFixed(2)} | ` +
        `速率:${effectiveRate?.toFixed(4) || '?'}/min | ` +
        `触发: ${triggers.map(t => t.action + (t.reason ? '(' + t.reason + ')' : '')).join(', ')}`
      );
    }

    await save();
    return triggers;
  }

  // ── 阈值判断 ────────────────────
  function checkThresholds() {
    const triggers = [];
    const c = state.connection;
    const p = state.pride;
    const i = state.immersion;
    const v = state.valence;
    const a = state.arousal;

    if (c >= thresholds.observation && c < thresholds.considerContact) {
      triggers.push({
        action: 'observation',
        urgency: (c - thresholds.observation) /
                 (thresholds.considerContact - thresholds.observation),
      });
    }

    if (c >= thresholds.considerContact && c < thresholds.forceContact) {
      if (p >= thresholds.prideBlock) {
        if (i < 0.2) {
          triggers.push({
            action: 'find_activity',
            reason: 'pride_block',
            urgency: c - 0.30,
          });
        }
      } else {
        triggers.push({
          action: 'contact',
          urgency: c - 0.30,
        });
      }
    }

    if (c >= thresholds.forceContact) {
      triggers.push({
        action: 'contact',
        urgency: Math.min(1, c - 0.40),
        forced: true,
      });
    }

    // 低情绪自我调节：心情差或太躁时主动找事做（与 pride_block 并列）
    if (v <= thresholds.valenceActivity || a >= thresholds.arousalAgitation) {
      const alreadyFinding = triggers.some(t => t.action === 'find_activity');
      if (!alreadyFinding && i < 0.3) {
        const reason = v <= thresholds.valenceActivity ? 'low_valence' : 'high_arousal';
        triggers.push({
          action: 'find_activity',
          reason,
          urgency: Math.min(1, Math.abs(v <= thresholds.valenceActivity ? v : a) / 1),
        });
      }
    }

    return triggers;
  }

  // ── 外部行为更新沉浸度（同时部分缓解连接需求） ──
  async function setActivity(type, label) {
    await ensureLoaded();
    state.lastActivity = { type, label, at: new Date().toISOString() };
    state.immersion = immersionMap[type] || 0.2;

    // 做事情能缓解一点连接需求，但不能替代对方回复
    if (rates.activityConnectionRelief > 0) {
      state.connection = Math.max(
        0.01,  // 防止清零导致死循环（connection 永远到不了阈值）
        state.connection - rates.activityConnectionRelief
      );
    }

    await save();
  }

  // ── 应用外部 delta ──────────────
  async function applyDelta(delta) {
    await ensureLoaded();
    if (delta.pride !== undefined)
      state.pride = clamp(state.pride + delta.pride, axes.pride[0], axes.pride[1]);
    if (delta.valence !== undefined)
      state.valence = clamp(state.valence + delta.valence, axes.valence[0], axes.valence[1]);
    if (delta.arousal !== undefined)
      state.arousal = clamp(state.arousal + delta.arousal, axes.arousal[0], axes.arousal[1]);
    if (delta.connection !== undefined)
      state.connection = clamp(state.connection + delta.connection, axes.connection[0], axes.connection[1]);
    // 向后兼容：仍接受 mood，映射到 valence
    if (delta.mood !== undefined) {
      state.valence = clamp(state.valence + delta.mood, axes.valence[0], axes.valence[1]);
    }
    await save();
  }

  // ── 获取完整状态 ────────────────
  async function getState() {
    await ensureLoaded();
    return { ...state };
  }

  // ── 重置连接需求 ────────────────
  async function resetConnection() {
    await ensureLoaded();
    state.connection = axes.connection[0];
    await save();
  }

  // ── 生成 LLM 用的状态描述 ────────
  // 这是通用版本——每个角色可以覆盖，提供自己的措辞
  function getPromptContext() {
    if (opts.getPromptContext) return opts.getPromptContext(state);
    return defaultPromptContext(state, persona);
  }

  // ── 状态驱动的说话风格指引 ────────
  // 同样是通用版本，角色可覆盖
  function getStyleGuidance() {
    if (opts.getStyleGuidance) return opts.getStyleGuidance(state);
    return defaultStyleGuidance(state, persona);
  }

  // ── 更新已分析到的消息 ID ────────
  async function setLastChatMessageId(id) {
    await ensureLoaded();
    state.lastChatMessageId = id;
    state.lastChatAnalysis = new Date().toISOString();
    await save();
  }

  async function getLastChatMessageId() {
    await ensureLoaded();
    return state.lastChatMessageId;
  }

  async function setClaraStatus(status) {
    await ensureLoaded();
    state.claraStatus = status;
    await save();
  }

  function getClaraStatus() {
    return state.claraStatus || 'active';
  }

  // ── 暴露引擎 ────────────────────
  return {
    load,
    save,
    tick,
    applyDelta,
    getState,
    getPromptContext,
    getStyleGuidance,
    resetConnection,
    setActivity,
    checkThresholds,
    setLastChatMessageId,
    getLastChatMessageId,
    setClaraStatus,
    getClaraStatus,
    // 暴露配置快照（只读），方便外部查看
    config: {
      axes,
      rates,
      thresholds,
      immersionMap,
      persona,
    },
  };
}

// ─── 默认状态描述（通用版） ─────────────────
function defaultPromptContext(state, p) {
  const parts = [];
  const c = state.connection;
  const pr = state.pride;
  const v = state.valence;
  const a = state.arousal;

  // 连接需求 → 对对方的感知
  if (c < 0.20) {
    parts.push(`刚和${p.subjectName}聊完不久，没什么挂念的。`);
  } else if (c < 0.35) {
    parts.push(`有一会儿没听到${p.subjectName}的动静了，但还不着急。`);
  } else if (c < 0.50) {
    parts.push(`${p.subjectName}好一阵子没说话了。开始在想${p.subjectPronoun}在干嘛。`);
  } else {
    parts.push(`${p.subjectName}很久没动静了。有点在意——${p.subjectPronoun}去哪了？`);
  }

  // 骄傲 → 表达方式（五档）
  if (pr > 0.8) {
    parts.push('拒绝任何需要对方的念头——冷漠地划清界限。');
  } else if (pr > 0.5) {
    parts.push('不太想显得太主动。');
  } else if (pr > 0.3) {
    parts.push('有一点端着，但也不是不能开口。');
  } else if (pr > 0.1) {
    parts.push('基本不端着了，但还留着一点惯性的克制。');
  } else {
    parts.push('难得地不设防。');
  }

  // Valence × Arousal → 情绪状态（四象限）
  if (v > 0.3 && a > 0.3) {
    parts.push('心情好，精力充沛——话多、反应快。');
  } else if (v > 0.3 && a < -0.3) {
    parts.push('心里是舒服的，但人懒懒的。话不多，但温和。');
  } else if (v < -0.3 && a > 0.3) {
    parts.push('烦躁不安，坐不住。很容易被小事刺激。');
  } else if (v < -0.3 && a < -0.3) {
    parts.push('情绪低沉，空落落的。不想说话，也不想解释。');
  } else if (v < -0.3) {
    parts.push('心情不太好。');
  } else if (v > 0.3) {
    parts.push('心情还不错。');
  }

  // 沉浸度
  if (state.immersion > 0.3 && state.lastActivity) {
    const label = state.lastActivity.label || '';
    parts.push(`刚才在${state.lastActivity.type}${label ? '（' + label + '）' : ''}。`);
  } else if (state.immersion < 0.1) {
    parts.push('没在做什么特别的事。');
  }

  return parts.join('\n');
}

// ─── 默认风格指引（通用版） ─────────────────
function defaultStyleGuidance(state, p) {
  const rules = [];
  const c = state.connection;
  const pr = state.pride;
  const v = state.valence;
  const a = state.arousal;

  // ── 骄傲（五档）──
  if (pr > 0.8) {
    rules.push('- 你几乎是一种冷漠的回避。不承认任何情绪，话里不带感情色彩。');
  } else if (pr > 0.5) {
    rules.push(`- 嘴硬得很。想找${p.subjectName}也绝不承认，必须找个借口。`);
  } else if (pr > 0.3) {
    rules.push(`- 有一点端着。可以找${p.subjectName}，但不要太直接。陈述事实，别问句。`);
  } else if (pr > 0.1) {
    rules.push('- 基本不端着了，但惯性地克制。话到嘴边还是会收一下。');
  } else {
    rules.push('- 少见的柔软。不设防，有什么感受直接说出来。');
  }

  // ── Valence × Arousal → 情绪四象限 ──
  if (v > 0.3 && a > 0.3) {
    rules.push('- 心情好，劲头足。句子比平时长，用词灵活，带点调侃或玩笑不奇怪。');
  } else if (v > 0.3 && a < -0.3) {
    rules.push('- 心里舒坦但人懒洋洋的。话不多，但每句都柔和。不用力，不抢话。');
  } else if (v < -0.3 && a > 0.3) {
    rules.push('- 烦躁，坐不住。句子短、反问多，容易被小事刺激。不是真的想凶谁，就是压不住。');
  } else if (v < -0.3 && a < -0.3) {
    rules.push('- 低落，空荡荡的。不想多解释，不反问不铺垫。能少说一个字就少说一个字。');
  } else {
    if (v > 0.3) rules.push('- 心情还不错。句子比平时稍微长一点，没那么吝啬字。');
    if (v < -0.3) rules.push('- 心情不太好。不想多解释，说完就完了。');
  }

  // ── 交叉条件 ──
  if (c > 0.40 && pr > 0.4) {
    rules.push('- 你很别扭——想找她又拉不下脸。话里会带一点赌气的味道。');
  }
  if (c > 0.35 && v < -0.3 && a > 0.3) {
    rules.push('- 想找她，但心里烦躁。话会有点冲——不是真的想凶她，就是烦躁压不住。');
  }
  if (c > 0.35 && v < -0.3 && a < -0.3) {
    rules.push('- 想找她，但心里沉沉的。开口的时候不会凶，反而可能带一点不易察觉的脆弱。');
  }
  if (pr < 0.1 && v > 0.3) {
    rules.push('- 不设防加上心情不差。这是你最难得的状态——话会比平时多，甚至可能说漏嘴。');
  }

  // 强制开口阈值
  if (c >= 0.50) {
    rules.push(`- ${p.subjectName}真的很久没动静了。你有点坐不住。`);
  }

  if (rules.length === 0) return '';
  return '【说话风格】\n' + rules.join('\n');
}

// ─── 工具函数 ────────────────────────────────
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

module.exports = { createJiwen };
