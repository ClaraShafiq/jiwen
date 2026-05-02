// ============================================================
// 积温模拟引擎 — 给定事件线 + 参数集 → 状态轨迹 + 诊断
// ============================================================

const { createJiwen } = require('./jiwen');

const NEUTRAL_INIT = {
  connection: 0, pride: 0, valence: 0, arousal: 0, immersion: 0,
  lastActivity: null, lastTick: null, lastChatAnalysis: null,
  lastChatMessageId: null, _lastMsgId: 0,
};

/**
 * 运行一个场景对多组参数，返回状态轨迹。
 *
 * 场景事件格式：
 *   { time: number, action: "set_last_message"|"tick"|"apply_delta"|"reset_connection", ... }
 *
 *   set_last_message:  { time, action: "set_last_message", content: string }
 *   apply_delta:      { time, action: "apply_delta", pride?, valence?, arousal?, connection? }
 *   reset_connection:  { time, action: "reset_connection" }
 *   tick:              { time, action: "tick" }  （纯时间流逝标记，无额外操作）
 *
 * @param {Array} scenario  事件数组，按 time 升序
 * @param {Array} paramsArray  参数集数组 [{ name, ...jiwenOpts }]
 * @returns {Array} [{ name, trajectory: [{time, action, connection, pride, valence, arousal, immersion, triggers, diagnostics}] }]
 */
async function simulate(scenario, paramsArray) {
  const results = [];

  for (const paramSet of paramsArray) {
    const { name, initialState: customInit, ...opts } = paramSet;
    const trajectory = [];
    let virtualTime = null;
    let virtualLastMsg = null;
    let virtualLastMsgId = 0;
    let pendingTriggers = [];

    // 注入虚拟消息源、空持久化、中性初始状态（通过 onLoad 返回）
    const instance = createJiwen({
      onSave: async () => {},
      onLoad: async () => ({ ...NEUTRAL_INIT, ...(customInit || {}) }),
      getLastMessage: () => virtualLastMsg,
      connectionRateFn: defaultConnectionRateFn,
      ...opts, // 用户参数覆盖默认值（含 connectionRateFn 覆盖）
    });

    await instance.load();
    const thresholds = instance.config.thresholds;

    for (const event of scenario) {
      // 1. 先推进时间（tick 处理上一个事件到当前事件之间的时间流逝）
      if (virtualTime !== null && event.time > virtualTime) {
        const elapsed = event.time - virtualTime;
        pendingTriggers = await instance.tick(elapsed);
      }
      virtualTime = event.time;

      // 2. 执行事件动作
      switch (event.action) {
        case 'set_last_message':
          virtualLastMsgId++;
          virtualLastMsg = {
            id: virtualLastMsgId,
            content: event.content || '',
            timestamp: new Date().toISOString(),
          };
          break;

        case 'apply_delta': {
          const delta = {};
          if (event.pride !== undefined) delta.pride = event.pride;
          if (event.valence !== undefined) delta.valence = event.valence;
          if (event.arousal !== undefined) delta.arousal = event.arousal;
          if (event.connection !== undefined) delta.connection = event.connection;
          // 向后兼容 mood → valence
          if (event.mood !== undefined) delta.valence = event.mood;
          if (Object.keys(delta).length > 0) {
            await instance.applyDelta(delta);
          }
          break;
        }

        case 'reset_connection':
          await instance.resetConnection();
          break;

        case 'tick':
          // 纯时间流逝，tick 已在上方处理，这里不额外操作
          break;
      }

      // 3. 记录快照
      const state = await instance.getState();
      const diag = computeDiagnostics(state, thresholds);

      trajectory.push({
        time: event.time,
        action: event.action,
        connection: round(state.connection, 4),
        pride: round(state.pride, 4),
        valence: round(state.valence, 4),
        arousal: round(state.arousal, 4),
        immersion: round(state.immersion, 4),
        triggers: pendingTriggers.map(t => ({
          action: t.action,
          urgency: t.urgency !== undefined ? round(t.urgency, 3) : undefined,
          forced: t.forced || false,
          reason: t.reason || null,
        })),
        diagnostics: diag,
      });

      pendingTriggers = [];
    }

    results.push({ name, trajectory });
  }

  return results;
}

// ── 诊断列 ────────────────────────────
function computeDiagnostics(state, thresholds) {
  const c = state.connection;
  const p = state.pride;
  const v = state.valence;
  const a = state.arousal;

  const can_consider = c >= thresholds.considerContact;
  const can_pride_block = p >= thresholds.prideBlock;
  const effective_pride = can_consider && can_pride_block && c < thresholds.forceContact;
  const in_observation = c >= thresholds.observation && c < thresholds.considerContact;
  const in_force_contact = c >= thresholds.forceContact;
  const in_valence_activity = v <= thresholds.valenceActivity;
  const in_arousal_agitation = a >= thresholds.arousalAgitation;

  return {
    can_consider:     can_consider,
    can_pride_block:  can_pride_block,
    effective_pride:  effective_pride,
    in_observation:   in_observation,
    in_force_contact: in_force_contact,
    in_valence_activity: in_valence_activity,
    in_arousal_agitation: in_arousal_agitation,
  };
}

// ── 默认连接需求速率（匹配 jiwen README 示例） ──
function defaultConnectionRateFn(lastMsg) {
  if (!lastMsg) return 0.0007;

  const text = lastMsg.content || '';

  if (/晚安|去睡了|睡了|睡觉/.test(text)) return 0.0003;
  if (/出门|上班|开会/.test(text)) return 0.0005;
  if (text.length < 10) return 0.0010;

  return 0.0007;
}

// ── 轨迹 → CSV ─────────────────────────
function toCSV(result) {
  const { name, trajectory } = result;
  const header = [
    'time', 'action',
    'connection', 'pride', 'valence', 'arousal', 'immersion',
    'triggers',
    'can_consider', 'can_pride_block', 'effective_pride',
    'in_observation', 'in_force_contact',
    'in_valence_activity', 'in_arousal_agitation',
  ];

  const lines = [header.join(',')];

  for (const row of trajectory) {
    const triggerStr = row.triggers.length > 0
      ? '"' + row.triggers.map(t => {
          const parts = [t.action];
          if (t.forced) parts.push('forced');
          if (t.reason) parts.push(t.reason);
          if (t.urgency !== undefined) parts.push('u' + t.urgency);
          return parts.join(':');
        }).join('|') + '"'
      : '';

    const d = row.diagnostics;
    const values = [
      row.time,
      row.action,
      row.connection,
      row.pride,
      row.valence,
      row.arousal,
      row.immersion,
      triggerStr,
      d.can_consider ? 1 : 0,
      d.can_pride_block ? 1 : 0,
      d.effective_pride ? 1 : 0,
      d.in_observation ? 1 : 0,
      d.in_force_contact ? 1 : 0,
      d.in_valence_activity ? 1 : 0,
      d.in_arousal_agitation ? 1 : 0,
    ];
    lines.push(values.join(','));
  }

  return { name, csv: lines.join('\n') };
}

// ── 多组轨迹 → 比较用合并 CSV（每组一列关键指标） ──
function toCompareTable(results) {
  // 每个结果的轨迹取最后一行做汇总
  const header = ['name', 'final_conn', 'final_pride', 'final_valence', 'final_arousal',
    'eff_pride_true_count', 'force_contact_count', 'observation_count', 'total_ticks'];
  const lines = [header.join(',')];

  for (const { name, trajectory } of results) {
    const last = trajectory[trajectory.length - 1];
    const effCount = trajectory.filter(r => r.diagnostics.effective_pride).length;
    const forceCount = trajectory.filter(r => r.diagnostics.in_force_contact).length;
    const obsCount = trajectory.filter(r => r.diagnostics.in_observation).length;
    const tickCount = trajectory.filter(r => r.action === 'tick').length;

    lines.push([
      name,
      last.connection, last.pride, last.valence, last.arousal,
      effCount, forceCount, obsCount, tickCount,
    ].join(','));
  }

  return lines.join('\n');
}

// ── 工具 ──────────────────────────────
function round(v, decimals) {
  const m = Math.pow(10, decimals);
  return Math.round(v * m) / m;
}

module.exports = { simulate, computeDiagnostics, defaultConnectionRateFn, toCSV, toCompareTable };
