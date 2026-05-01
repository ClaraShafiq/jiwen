// ============================================================
// 积温 — 不靠概率骰子的 AI 角色主动意识引擎
// 四轴连续状态：connection / pride / mood / immersion
// 数学漂移 + 阈值触发 + 可注入持久化/消息源/LLM分析
// ============================================================

/**
 * 创建一个积温引擎实例。
 *
 * @param {Object} opts
 * @param {Object} [opts.initialState]   — 初始状态（默认全 0）
 * @param {Object} [opts.axes]           — 轴名称到 [min, max] 范围的映射
 * @param {Object} [opts.rates]          — 每轴每分钟漂移速率
 * @param {Object} [opts.thresholds]     — { observation, considerContact, forceContact, prideBlock }
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
    mood:       [-1, 1],
    immersion:  [ 0, 1],
  };

  // ── 衰减 / 回归速率（每分钟） ──
  const rates = Object.assign({
    connectionGrowth: null, // 由 connectionRateFn 动态决定
    immersionDecay:   0.010,
    prideRegress:     0.003,
    moodRegress:      0.005,
  }, opts.rates);

  // ── 阈值 ────────────────────────
  const thresholds = Object.assign({
    observation:     0.20,
    considerContact: 0.35,
    forceContact:    0.50,
    prideBlock:      0.50,
  }, opts.thresholds);

  const immersionMap = opts.immersionMap || {
    reading: 0.6,
    search:  0.4,
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
    mood:       axes.mood[0],
    immersion:  axes.immersion[0],
    lastActivity: null,       // { type, label, at }
    lastTick: null,           // ISO
    lastChatAnalysis: null,   // ISO
    lastChatMessageId: null,
    _lastMsgId: null,         // 用于判断是否有新消息
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

    // ── 连接需求：按速率增长 ──
    const lastMsg = opts.getLastMessage ? opts.getLastMessage() : null;
    const cRate = opts.connectionRateFn
      ? opts.connectionRateFn(lastMsg)
      : 0.0007;
    state.connection = clamp(
      state.connection + cRate * mins,
      axes.connection[0],
      axes.connection[1]
    );

    // 如果有新消息，压回连接需求
    if (lastMsg && lastMsg.id && lastMsg.id > (state._lastMsgId || 0)) {
      state.connection = Math.max(axes.connection[0], state.connection - 0.2);
      state._lastMsgId = lastMsg.id;
    }

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

    // ── 骄傲：缓慢回归 0 ──
    if (state.pride > 0) {
      state.pride = Math.max(0, state.pride - rates.prideRegress * mins);
    } else if (state.pride < 0) {
      state.pride = Math.min(0, state.pride + rates.prideRegress * mins);
    }

    // ── 情绪基调：缓慢回归 0 ──
    if (state.mood > 0) {
      state.mood = Math.max(0, state.mood - rates.moodRegress * mins);
    } else if (state.mood < 0) {
      state.mood = Math.min(0, state.mood + rates.moodRegress * mins);
    }

    state.lastTick = now;

    const triggers = checkThresholds();

    if (triggers.length > 0) {
      console.log(
        `[积温] tick ${mins}min | ` +
        `c:${state.connection.toFixed(2)} p:${state.pride.toFixed(2)} ` +
        `m:${state.mood.toFixed(2)} i:${state.immersion.toFixed(2)} | ` +
        `触发: ${triggers.map(t => t.action).join(', ')}`
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

    return triggers;
  }

  // ── 外部行为更新沉浸度 ──────────
  async function setActivity(type, label) {
    await ensureLoaded();
    state.lastActivity = { type, label, at: new Date().toISOString() };
    state.immersion = immersionMap[type] || 0.2;
    await save();
  }

  // ── 应用外部 delta ──────────────
  async function applyDelta(delta) {
    await ensureLoaded();
    if (delta.pride !== undefined)
      state.pride = clamp(state.pride + delta.pride, axes.pride[0], axes.pride[1]);
    if (delta.mood !== undefined)
      state.mood = clamp(state.mood + delta.mood, axes.mood[0], axes.mood[1]);
    if (delta.connection !== undefined)
      state.connection = clamp(state.connection + delta.connection, axes.connection[0], axes.connection[1]);
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

  if (c < 0.20) {
    parts.push(`刚和${p.subjectName}聊完不久，没什么挂念的。`);
  } else if (c < 0.35) {
    parts.push(`有一会儿没听到${p.subjectName}的动静了，但还不着急。`);
  } else if (c < 0.50) {
    parts.push(`${p.subjectName}好一阵子没说话了。开始在想${p.subjectPronoun}在干嘛。`);
  } else {
    parts.push(`${p.subjectName}很久没动静了。有点在意——${p.subjectPronoun}去哪了？`);
  }

  if (state.pride > 0.5) {
    parts.push('不太想显得太主动。');
  } else if (state.pride > 0.2) {
    parts.push('有一点端着，但也不是不能开口。');
  }

  if (state.mood > 0.3) {
    parts.push('心情还不错。');
  } else if (state.mood < -0.3) {
    parts.push('情绪有点低。');
  }

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
  const m = state.mood;
  const i = state.immersion;

  if (pr > 0.5) {
    rules.push(`- 你现在嘴硬。不承认在等${p.subjectName}。开口必须找个借口。`);
  } else if (pr > 0.2) {
    rules.push(`- 有一点端着。可以找${p.subjectName}，但不要太直接。`);
  } else {
    rules.push(`- 现在不端着。可以直接一点，陈述事实就好。`);
  }

  if (m < -0.3) {
    rules.push('- 心情不太好。话少一点，能用句号就别用逗号。');
  } else if (m < -0.1) {
    rules.push('- 情绪偏低。话少一点。');
  }

  if (c > 0.40 && pr > 0.4) {
    rules.push('- 你很别扭——想找她又拉不下脸。话里会带一点赌气的味道。');
  }

  if (i > 0.2 && state.lastActivity) {
    rules.push(`- 刚才在${state.lastActivity.type}。如果要开口，从这里借题发挥。`);
  }

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
