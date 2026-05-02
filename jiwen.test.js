// ============================================================
// 积温引擎测试套件
// 运行：node jiwen.test.js
// ============================================================

const { createJiwen } = require('./jiwen');
const { simulate, computeDiagnostics } = require('./simulate');

let passed = 0;
let failed = 0;
let testName = '';
const _promises = [];

function describe(name, fn) {
  testName = name;
  fn();
}

function it(name, fn) {
  const fullName = testName + ' > ' + name;
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      _promises.push(
        result.then(
          () => { passed++; console.log('  PASS', fullName); },
          (e) => { failed++; console.log('  FAIL', fullName, '\n     ', e.message); }
        )
      );
      return;
    }
    passed++;
    console.log('  PASS', fullName);
  } catch (e) {
    failed++;
    console.log('  FAIL', fullName, '\n     ', e.message);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertClose(actual, expected, tolerance, msg) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${msg || 'assertClose'}: expected ${expected} ±${tolerance}, got ${actual}`);
  }
}

// ── 辅助：创建测试用 jiwen 实例 ──
// 默认从全 0 初始状态启动（中性冷启动），jiwen 不直接支持 initialState 选项，
// 需通过 onLoad 返回初始快照来注入。
const NEUTRAL_INIT = {
  connection: 0, pride: 0, valence: 0, arousal: 0, immersion: 0,
  lastActivity: null, lastTick: null, lastChatAnalysis: null,
  lastChatMessageId: null, _lastMsgId: 0,
};

function makeTestJiwen(opts = {}) {
  let lastMsg = null;
  let lastMsgId = 0;
  const customInit = opts.initialState || {};

  const instance = createJiwen({
    onSave: async () => {},
    onLoad: async () => ({ ...NEUTRAL_INIT, ...customInit }),
    getLastMessage: () => lastMsg,
    connectionRateFn: () => 0.001, // 固定速率，方便计算
    ...opts,
  });

  return {
    instance,
    setLastMessage(content) {
      lastMsgId++;
      lastMsg = { id: lastMsgId, content, timestamp: new Date().toISOString() };
    },
    getLastMsg() { return lastMsg; },
    getLastMsgId() { return lastMsgId; },
  };
}

// ============================================================
// 1. 单调性测试
// ============================================================
describe('单调性 Monotonicity', () => {

  it('connection 无回复时单调不减', async () => {
    const { instance } = makeTestJiwen();
    await instance.load();

    let prev = (await instance.getState()).connection;
    for (let i = 0; i < 20; i++) {
      await instance.tick(5);
      const curr = (await instance.getState()).connection;
      assert(curr >= prev, `connection 下降: ${prev} → ${curr}`);
      prev = curr;
    }
  });

  it('收到新消息后 connection 下降', async () => {
    const { instance, setLastMessage } = makeTestJiwen();
    await instance.load();

    await instance.tick(30);
    const before = (await instance.getState()).connection;
    assert(before > 0, 'connection 应该已有积累');

    setLastMessage('我回来了');
    await instance.tick(5);

    const after = (await instance.getState()).connection;
    assert(after < before, `新消息后 connection 应下降: ${before} → ${after}`);
  });

  it('resetConnection 将 connection 归零', async () => {
    const { instance } = makeTestJiwen();
    await instance.load();

    await instance.tick(60);
    const before = (await instance.getState()).connection;
    assert(before > 0.03, 'connection 应有显著积累');

    await instance.resetConnection();
    const after = (await instance.getState()).connection;
    assert(after === 0, `resetConnection 后应为0，实际 ${after}`);
  });

  it('pride 在无防御触发时回归 0', async () => {
    const { instance } = makeTestJiwen({
      rates: { prideDefendThreshold: 1.0, prideRegress: 0.01 },
    });
    await instance.load();
    // 先推 pride 到正区间
    await instance.applyDelta({ pride: 0.5 });
    const high = (await instance.getState()).pride;
    assert(high > 0.4, `pride 应先被推高，实际 ${high}`);

    // 多次 tick，pride 应回归 0
    for (let i = 0; i < 10; i++) await instance.tick(10);
    const after = (await instance.getState()).pride;
    assert(after < high, `pride 应回落: ${high} → ${after}`);
    assert(after >= 0, `pride 不应为负: ${after}`);
  });

  it('valence 回归设定点', async () => {
    const { instance } = makeTestJiwen({
      rates: { valenceSetpoint: 0.3, valenceRegress: 0.02, valenceLockThreshold: 1.0 },
    });
    await instance.load();
    // 先推到负区间（从0开始，applyDelta -0.4 → -0.4）
    await instance.applyDelta({ valence: -0.4 });
    const low = (await instance.getState()).valence;
    assert(low < -0.3, `valence 应先被拉低，实际 ${low}`);

    for (let i = 0; i < 10; i++) await instance.tick(10);
    const after = (await instance.getState()).valence;
    assert(after > low, `valence 应向设定点回归: ${low} → ${after}`);
    assert(after <= 0.3, `valence 不应超过设定点: ${after}`);
  });
});

// ============================================================
// 2. 边界测试
// ============================================================
describe('边界 Boundary', () => {

  it('五轴均在定义范围内', async () => {
    const { instance } = makeTestJiwen();
    await instance.load();

    // 极端操作：超限 delta + 长时间
    await instance.applyDelta({ pride: 3.0, valence: -3.0, arousal: 3.0, connection: 3.0 });
    for (let i = 0; i < 30; i++) await instance.tick(60);

    const s = await instance.getState();
    assert(s.connection >= 0 && s.connection <= 1, `connection 越界: ${s.connection}`);
    assert(s.pride >= -1 && s.pride <= 1, `pride 越界: ${s.pride}`);
    assert(s.valence >= -1 && s.valence <= 1, `valence 越界: ${s.valence}`);
    assert(s.arousal >= -1 && s.arousal <= 1, `arousal 越界: ${s.arousal}`);
    assert(s.immersion >= 0 && s.immersion <= 1, `immersion 越界: ${s.immersion}`);
  });

  it('connection 不倒灌到负值', async () => {
    const { instance } = makeTestJiwen({
      rates: { connectionOnReply: 0.5 },
    });
    await instance.load();
    await instance.tick(5);

    for (let i = 0; i < 10; i++) {
      await instance.resetConnection();
      const c = (await instance.getState()).connection;
      assert(c >= 0, `connection 为负: ${c}`);
    }
  });

  it('长时间空转不爆炸（600分钟）', async () => {
    const { instance } = makeTestJiwen({
      rates: { connectionAccel: 0 },
    });
    await instance.load();

    // 10 次 × 60 分钟 = 600 分钟
    for (let i = 0; i < 10; i++) {
      await instance.tick(60);
      const s = await instance.getState();
      assert(Number.isFinite(s.connection), 'connection 非有限值');
      assert(Number.isFinite(s.pride), 'pride 非有限值');
    }

    const s = await instance.getState();
    // 600分钟 × 0.001/min = 0.60
    assertClose(s.connection, 0.60, 0.02, 'connection 应 ~0.60');
    assert(s.connection <= 1.0, `connection 爆炸: ${s.connection}`);
  });
});

// ============================================================
// 3. 阈值转移测试
// tick() 有 60 分钟上限，需要分批调用
// ============================================================
describe('阈值转移 Thresholds', () => {

  it('connection 跨过 observation 阈值触发 observation', async () => {
    const { instance } = makeTestJiwen({
      thresholds: { observation: 0.20, considerContact: 0.50, forceContact: 0.80 },
      rates: { connectionAccel: 0 },
    });
    await instance.load();

    // 需要到达 0.20：4次 × 60min × 0.001/min = 0.24
    let triggers = [];
    for (let i = 0; i < 4; i++) {
      triggers = await instance.tick(60);
    }
    const hasObs = triggers.some(t => t.action === 'observation');
    assert(hasObs, `应触发 observation (c>=0.20)，实际: ${JSON.stringify(triggers)}`);
  });

  it('connection 跨过 considerContact 且 pride 低时触发 contact', async () => {
    const { instance } = makeTestJiwen({
      thresholds: { observation: 0.20, considerContact: 0.35, forceContact: 0.80, prideBlock: 0.50 },
      rates: { connectionAccel: 0, prideDefendThreshold: 1.0 },
    });
    await instance.load();

    // 6次 × 60min × 0.001/min = 0.36 > 0.35
    let triggers = [];
    for (let i = 0; i < 6; i++) {
      triggers = await instance.tick(60);
    }
    const hasContact = triggers.some(t => t.action === 'contact');
    assert(hasContact, `应触发 contact (c=0.36)，实际: ${JSON.stringify(triggers)}`);
  });

  it('connection 跨过 considerContact 但 pride 高时触发 find_activity', async () => {
    // 需要 pride 在 connection 到达 considerContact 时已超过 prideBlock
    // prideDefendRate=0.02/min, 在 connection>0.20(prideDefendThreshold) 时开始累积
    // 从 c=0 到 c=0.20: 4 ticks × 60min = 240min, pride 不动（未触发防御）
    // 从 c=0.20 到 c=0.35: 还需 ~2.5 ticks, pride 涨 0.02×150 = 3.0，远超 0.30
    const { instance } = makeTestJiwen({
      thresholds: { observation: 0.20, considerContact: 0.35, forceContact: 0.80, prideBlock: 0.30 },
      rates: { connectionAccel: 0, prideDefendThreshold: 0.20, prideDefendTarget: 0.60, prideDefendRate: 0.02 },
    });
    await instance.load();

    // 前4次 tick: c 到达 ~0.24，触发 pride 防御
    for (let i = 0; i < 4; i++) await instance.tick(60);
    // 再2次 tick: c 到达 ~0.36, pride 已累积 2×60×0.02=2.4 → 上限 0.60
    let triggers = [];
    for (let i = 0; i < 2; i++) {
      triggers = await instance.tick(60);
    }

    const s = await instance.getState();
    const hasFind = triggers.some(t => t.action === 'find_activity');
    const hasContact = triggers.some(t => t.action === 'contact');
    assert(hasFind, `应触发 find_activity（骄傲阻断）c=${s.connection.toFixed(2)} p=${s.pride.toFixed(2)} triggers=${JSON.stringify(triggers)}`);
    assert(!hasContact, `不应触发 contact（被拦截）triggers=${JSON.stringify(triggers)}`);
  });

  it('connection 跨过 forceContact 强制触发 contact', async () => {
    const { instance } = makeTestJiwen({
      thresholds: { observation: 0.20, considerContact: 0.35, forceContact: 0.50, prideBlock: 0.50 },
      rates: { connectionAccel: 0, prideDefendThreshold: 0.20, prideDefendTarget: 0.9, prideDefendRate: 0.1 },
    });
    await instance.load();

    // 9次 × 60min × 0.001/min = 0.54 > 0.50
    let triggers = [];
    for (let i = 0; i < 9; i++) {
      triggers = await instance.tick(60);
    }
    // pride 防御早就在跑了，但 forceContact 无视 pride
    const hasForced = triggers.some(t => t.action === 'contact' && t.forced === true);
    const s = await instance.getState();
    assert(hasForced, `应触发强制 contact c=${s.connection.toFixed(2)} p=${s.pride.toFixed(2)} triggers=${JSON.stringify(triggers)}`);
  });

  it('valence 过低触发 find_activity (low_valence)', async () => {
    const { instance } = makeTestJiwen({
      thresholds: { valenceActivity: -0.3, arousalAgitation: 1.0 },
    });
    await instance.load();
    await instance.applyDelta({ valence: -0.5 });
    const triggers = await instance.tick(5);
    const hasFind = triggers.some(t => t.action === 'find_activity' && t.reason === 'low_valence');
    assert(hasFind, `低 valence 应触发自我调节，实际: ${JSON.stringify(triggers)}`);
  });

  it('arousal 过高触发 find_activity (high_arousal)', async () => {
    const { instance } = makeTestJiwen({
      thresholds: { valenceActivity: -1.0, arousalAgitation: 0.6 },
    });
    await instance.load();
    await instance.applyDelta({ arousal: 0.8 });
    const s = await instance.getState();
    const triggers = await instance.tick(5);
    const hasFind = triggers.some(t => t.action === 'find_activity' && t.reason === 'high_arousal');
    assert(hasFind, `高 arousal 应触发自我调节 a=${s.arousal.toFixed(2)} triggers=${JSON.stringify(triggers)}`);
  });
});

// ============================================================
// 4. 诊断列测试
// ============================================================
describe('诊断列 Diagnostics', () => {

  it('effective_pride 正确识别有效拦截窗口', () => {
    const thresholds = {
      considerContact: 0.35, forceContact: 0.50, prideBlock: 0.50,
      observation: 0.20, valenceActivity: -1.0, arousalAgitation: 1.0,
    };

    // connection 还没到 considerContact → can_consider=false, effective=false
    const s1 = { connection: 0.30, pride: 0.60, valence: 0, arousal: 0, immersion: 0 };
    const d1 = computeDiagnostics(s1, thresholds);
    assert(d1.can_consider === false, '0.30 < 0.35 → can_consider 应为 false');
    assert(d1.can_pride_block === true, '0.60 > 0.50 → can_pride_block 应为 true');
    assert(d1.effective_pride === false, 'can_consider=false → effective 应为 false');

    // connection 跨过 considerContact，pride 够高 → 有效拦截
    const s2 = { connection: 0.40, pride: 0.60, valence: 0, arousal: 0, immersion: 0 };
    const d2 = computeDiagnostics(s2, thresholds);
    assert(d2.can_consider === true, '0.40 >= 0.35 → can_consider 应为 true');
    assert(d2.effective_pride === true, '在 considerContact 和 forceContact 之间 + pride 够高 → 有效拦截');

    // connection 跨过 forceContact → 拦截失效
    const s3 = { connection: 0.55, pride: 0.60, valence: 0, arousal: 0, immersion: 0 };
    const d3 = computeDiagnostics(s3, thresholds);
    assert(d3.in_force_contact === true, '0.55 >= 0.50 → force_contact');
    assert(d3.effective_pride === false, 'force_contact → effective 应为 false');

    // pride 不够高 → 不拦截
    const s4 = { connection: 0.40, pride: 0.30, valence: 0, arousal: 0, immersion: 0 };
    const d4 = computeDiagnostics(s4, thresholds);
    assert(d4.can_consider === true);
    assert(d4.can_pride_block === false, '0.30 < 0.50 → can_pride_block=false');
    assert(d4.effective_pride === false);
  });

  it('effective_pride 在 Draco 默认参数下窗口极小', async () => {
    // 用 Draco 实际参数
    const { instance } = makeTestJiwen({
      rates: {
        connectionAccel: 2.5,
        prideDefendThreshold: 0.25,
        prideDefendTarget: 0.55,
        prideDefendRate: 0.006,
      },
      thresholds: {
        observation: 0.12,
        considerContact: 0.22,
        forceContact: 0.35,
        prideBlock: 0.50,
        valenceActivity: -0.25,
        arousalAgitation: 0.55,
      },
      connectionRateFn: () => 0.009,
    });
    await instance.load();

    const thresholds = {
      observation: 0.12, considerContact: 0.22, forceContact: 0.35,
      prideBlock: 0.50, valenceActivity: -0.25, arousalAgitation: 0.55,
    };

    const trajectory = [];
    for (let min = 0; min <= 40; min += 1) {
      await instance.tick(1);
      const s = await instance.getState();
      trajectory.push({ time: min, connection: s.connection, pride: s.pride,
        diag: computeDiagnostics(s, thresholds) });
    }

    const effCount = trajectory.filter(p => p.diag.effective_pride).length;
    const forceCount = trajectory.filter(p => p.diag.in_force_contact).length;
    const finalConn = trajectory[trajectory.length - 1].connection;
    const finalPride = trajectory[trajectory.length - 1].pride;

    console.log(`\n     [Draco参数 40min] c:0→${finalConn.toFixed(3)} p:0→${finalPride.toFixed(3)} | effective_pride:${effCount}次 force:${forceCount}次`);

    if (effCount === 0) {
      console.log('     ⚠  Draco 当前参数下 effective_pride 窗口为 0！pride 从未生效拦截。');
    }

    // force_contact 应该触发（connection 必然越过 0.35）
    assert(forceCount > 0, '至少应触发 force_contact');
  });
});

// ============================================================
// 5. 多参数模拟测试
// ============================================================
describe('模拟引擎 Simulate', () => {

  it('同一场景不同参数产出不同轨迹', async () => {
    const scenario = [
      { time: 0, action: 'set_last_message', content: '晚安，去睡了' },
      { time: 30, action: 'tick' },
      { time: 60, action: 'tick' },
      { time: 120, action: 'tick' },
      { time: 240, action: 'tick' },
      { time: 480, action: 'set_last_message', content: '早啊醒了' },
      { time: 480, action: 'apply_delta', valence: 0.1, pride: -0.1 },
      { time: 480, action: 'reset_connection' },
    ];

    const paramSets = [
      { name: '默认', connectionRateFn: () => 0.0007 },
      { name: '快速累积', connectionRateFn: () => 0.003 },
    ];

    const results = await simulate(scenario, paramSets);

    assert(results.length === 2, '应有2组结果');
    assert(results[0].name === '默认');
    assert(results[1].name === '快速累积');
    assert(results[0].trajectory.length === scenario.length, '轨迹长度=事件数');
    assert(results[1].trajectory.length === scenario.length);

    // 240min 时：快速累积的 connection 应 > 默认
    const mid0 = results[0].trajectory[4];
    const mid1 = results[1].trajectory[4];
    assert(mid1.connection > mid0.connection,
      `快速累积(240min): ${mid1.connection} > 默认: ${mid0.connection}`);
  });

  it('输出包含诊断列', async () => {
    const scenario = [
      { time: 0, action: 'set_last_message', content: '晚安' },
      { time: 60, action: 'tick' },
      { time: 120, action: 'tick' },
    ];

    const results = await simulate(scenario, [{ name: 'test' }]);
    for (const row of results[0].trajectory) {
      assert(row.diagnostics !== undefined, '每行应有 diagnostics');
      assert(typeof row.diagnostics.can_consider === 'boolean');
      assert(typeof row.diagnostics.can_pride_block === 'boolean');
      assert(typeof row.diagnostics.effective_pride === 'boolean');
    }
  });

  it('apply_delta 正确修改状态', async () => {
    const scenario = [
      { time: 0, action: 'set_last_message', content: '测试' },
      { time: 10, action: 'apply_delta', pride: 1.3, valence: 0.8 },
      { time: 20, action: 'tick' },
    ];

    // simulate 内部 initial state 从 0 开始，所以 pride 1.3 → 1.0 (clamped), valence 0.8 → 0.8
    const results = await simulate(scenario, [{ name: 'test' }]);
    const afterDelta = results[0].trajectory[1];
    assert(afterDelta.pride > 0.9, `pride 应为 ~1.0 (clamped): ${afterDelta.pride}`);
    assert(afterDelta.valence > 0.7, `valence 应为 ~0.8: ${afterDelta.valence}`);
  });

  it('reset_connection 清零 connection', async () => {
    const scenario = [
      { time: 0, action: 'set_last_message', content: '你好' },
      { time: 30, action: 'tick' },
      { time: 30, action: 'reset_connection' },
    ];

    const results = await simulate(scenario, [{ name: 'test' }]);
    const afterReset = results[0].trajectory[2];
    assert(afterReset.connection === 0, `reset 后 connection 应为 0: ${afterReset.connection}`);
  });
});

// ============================================================
// 6. 回归测试
// ============================================================
describe('回归 Regression', () => {

  it('tick 传入 0 或负数不推进状态', async () => {
    const { instance } = makeTestJiwen();
    await instance.load();

    const before = await instance.getState();
    await instance.tick(0);
    const after0 = await instance.getState();
    assert(after0.connection === before.connection, 'tick(0) 不应改变 connection');

    await instance.tick(-5);
    const afterNeg = await instance.getState();
    assert(afterNeg.connection === before.connection, 'tick(-5) 不应改变 connection');
  });

  it('tick 超过60分钟被截断', async () => {
    const { instance } = makeTestJiwen({
      rates: { connectionAccel: 0 },
    });
    await instance.load();

    await instance.tick(120);
    const s = await instance.getState();
    // 60 × 0.001 = 0.06
    assertClose(s.connection, 0.06, 0.005, 'tick(120) 应被截断为 60 分钟');
  });

  it('setActivity 设置沉浸度并部分缓解 connection', async () => {
    const { instance } = makeTestJiwen({
      rates: { activityConnectionRelief: 0.1 },
    });
    await instance.load();

    await instance.tick(50);
    const before = await instance.getState();
    assert(before.connection > 0.02);

    await instance.setActivity('reading', '测试书');
    const after = await instance.getState();
    assert(after.immersion >= 0.5, '沉浸度应被设置');
    assert(after.connection < before.connection, 'connection 应被部分缓解');
    assert(after.lastActivity !== null);
    assert(after.lastActivity.type === 'reading');
  });

  it('getPromptContext 和 getStyleGuidance 返回非空字符串', async () => {
    const { instance } = makeTestJiwen();
    await instance.load();
    await instance.tick(50);

    const ctx = instance.getPromptContext();
    const style = instance.getStyleGuidance();
    assert(typeof ctx === 'string' && ctx.length > 0, 'getPromptContext 应返回非空');
    assert(typeof style === 'string', 'getStyleGuidance 应返回字符串');
  });
});

// ============================================================
// 运行
// ============================================================
(async () => {
  console.log('\n═══════════════════════════════════');
  console.log(  '  积温引擎测试套件');
  console.log(  '═══════════════════════════════════\n');

  // 等待所有异步 it() 完成
  await Promise.all(_promises);

  console.log(`\n───────────────────────────────────`);
  console.log(`  通过: ${passed}  |  失败: ${failed}`);
  console.log(`───────────────────────────────────\n`);

  process.exit(failed > 0 ? 1 : 0);
})();
