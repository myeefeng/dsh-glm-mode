#!/usr/bin/env node
/**
 * StreamLoopGuard 合成流自测（零模型费用、确定性）。
 * 覆盖：死循环截断 / 正常流直通（chunk 级一致）/ 非 GLM 路由零感知 /
 * 武装阈值防误伤 / 短句防误伤 / fail-open / 消费者提前中断 / signal 桥接与硬取消。
 * 运行：node scripts/selftest-loop-guard.mjs（需先构建出 lib/）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { installLoopGuard, installSpinGuard, isPlaceholderRunCode } from '../lib/index.js'

const TAG_FAIL = (name) => 'FAIL[' + name + ']'
let passed = 0
const failures = []

function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok  ' + name) } else { failures.push(name + (detail ? ' :: ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}

// ── chunk 协议语法校验（镜像 dsh-llm validateStream 规则）───────────────────
const DELTA_OF = { 'reasoning-delta': 'reasoning', 'text-delta': 'text', 'tool-call-delta': 'tool-call' }
function assertGrammar(name, chunks) {
  const open = new Map()
  let finished = false
  let usageSeen = false
  for (const c of chunks) {
    if (finished) throw new Error(TAG_FAIL(name) + ' chunk after finish: ' + c.type)
    switch (c.type) {
      case 'block-start':
        if (open.has(c.index)) throw new Error(TAG_FAIL(name) + ' repeated block-start ' + c.index)
        open.set(c.index, c.blockType); break
      case 'reasoning-delta': case 'text-delta': case 'tool-call-delta':
        if (open.get(c.index) !== DELTA_OF[c.type]) throw new Error(TAG_FAIL(name) + ' delta ' + c.type + ' for absent/mismatched block ' + c.index)
        break
      case 'block-end':
        if (open.get(c.index) !== (c.block && c.block.type)) throw new Error(TAG_FAIL(name) + ' block-end mismatch ' + c.index)
        open.delete(c.index); break
      case 'usage':
        if (usageSeen) throw new Error(TAG_FAIL(name) + ' duplicate usage')
        usageSeen = true; break
      case 'finish':
        if (open.size > 0 && c.reason && c.reason.kind !== 'error' && c.reason.kind !== 'aborted') throw new Error(TAG_FAIL(name) + ' finish with ' + open.size + ' open block(s)')
        finished = true; break
      default: throw new Error(TAG_FAIL(name) + ' unknown chunk type ' + c.type)
    }
  }
  if (!finished) throw new Error(TAG_FAIL(name) + ' stream ended without finish')
}

// ── 测试基建 ────────────────────────────────────────────────────────────────
function makeCtx() {
  const listeners = []
  const logs = []
  return {
    ctx: {
      on: (event, fn) => { listeners.push(fn); return () => {} },
      logger: { info: (...a) => logs.push(['info', ...a]), warn: (...a) => logs.push(['warn', ...a]) },
    },
    listeners,
    logs,
  }
}
function source(chunks, state) {
  state = state || {}
  async function* gen() {
    try { for (const c of chunks) yield c } finally { state.closed = true }
  }
  state.gen = gen
  return gen()
}
async function drain(stream) {
  const out = []
  for await (const c of stream) out.push(c)
  return out
}
function onion(listeners, options, src) {
  // 单监听器洋葱：listener(options, () => src)（与运行时瀑布同构的最小复现）
  let s = src
  for (const l of listeners) s = l(options, () => s)
  return s
}
const uniqueSentence = (i) => '分析第' + i + '步：检查徽标 DOM 节点是否存在，样式元素是否挂载，以及轮询回调是否注册成功并按预期每秒执行一次刷新逻辑，确保状态数据能够正常写入渲染管道。'
const loopSentence = (n) => '确认：徽标的 DOM 存在，样式存在，页面内 fetch 正常（calls=' + n + ' 增长中），但徽标文本仍是占位符，说明客户端的轮询刷新没有把数据写进 DOM——那么问题出在哪一环，让我再看一遍：'

// ── 用例 A：GLM reasoning 死循环 → 截断 + 语法合规 + 硬取消 ────────────────
{
  const name = 'A.loop-truncated'
  const { ctx, listeners, logs } = makeCtx()
  const eventsFileA = '/tmp/dsh-glm-selftest-events-a-' + Date.now() + '.jsonl'
  installLoopGuard(ctx, { loopGuardRepeatThreshold: 8, loopGuardMinSentenceChars: 48, loopGuardMinReasoningChars: 2000 }, { eventsFile: eventsFileA })
  const st = {}
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    ...Array.from({ length: 25 }, (_, i) => ({ type: 'reasoning-delta', index: 0, delta: uniqueSentence(i) + '。' })),
    ...Array.from({ length: 12 }, (_, i) => ({ type: 'reasoning-delta', index: 0, delta: loopSentence(1123 + i) + '\n' })),
    { type: 'reasoning-delta', index: 0, delta: 'SHOULD_NOT_APPEAR' },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
  const parent = new AbortController()
  const options = { provider: 'zhipuai', model: 'zhipuai/glm-5.3-flash', sessionId: 'session-x', signal: parent.signal }
  const out = await drain(onion(listeners, options, source(chunks, st)))
  const last = out[out.length - 1]
  check(name + ': finish kind=max-tokens', last && last.type === 'finish' && last.reason && last.reason.kind === 'max-tokens', JSON.stringify(last))
  check(name + ': SHOULD_NOT_APPEAR not forwarded', !out.some((c) => (c.delta || '') === 'SHOULD_NOT_APPEAR' || (c.usage !== undefined)))
  check(name + ': grammar clean', (assertGrammar(name, out), true))
  check(name + ': upstream source closed', st.closed === true)
  check(name + ': child signal aborted (hard cancel)', options.signal && options.signal.aborted === true)
  check(name + ': parent signal untouched', parent.signal.aborted === false)
  check(name + ': loud log emitted', logs.some((l) => l[0] === 'warn' && String(l[1]).includes('loop-guard')), JSON.stringify(logs.slice(-1)))
  check(name + ': event ledger written', existsSync(eventsFileA) && readFileSync(eventsFileA, 'utf8').trim().split('\n').length === 1)
}

// ── 用例 B：正常 GLM 流 chunk 级直通 ────────────────────────────────────────
{
  const name = 'B.normal-passthrough'
  const { ctx, listeners } = makeCtx()
  installLoopGuard(ctx, { loopGuardRepeatThreshold: 8, loopGuardMinSentenceChars: 48, loopGuardMinReasoningChars: 2000 })
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    ...Array.from({ length: 30 }, (_, i) => ({ type: 'reasoning-delta', index: 0, delta: uniqueSentence(i % 6) + ' 变体' + i + '。' })),
    { type: 'block-end', index: 0, block: { type: 'reasoning' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, delta: '结论：徽标没更新。' },
    { type: 'block-end', index: 1, block: { type: 'text' } },
    { type: 'block-start', index: 2, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 2, delta: '{\"code\":\"1\"}' },
    { type: 'block-end', index: 2, block: { type: 'tool-call' } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
  const st = {}
  const options = { provider: 'zhipuai', model: 'zhipuai/glm-5.3-flash' }
  const out = await drain(onion(listeners, options, source(chunks, st)))
  check(name + ': chunk-for-chunk identical', JSON.stringify(out) === JSON.stringify(chunks))
  check(name + ': no synthetic truncation', out[out.length - 1].reason.kind === 'tool-calls')
  check(name + ': grammar clean', (assertGrammar(name, out), true))
}

// ── 用例 C：非 GLM 路由零感知（含 signal 不被换）────────────────────────────
{
  const name = 'C.non-glm-untouched'
  const { ctx, listeners } = makeCtx()
  installLoopGuard(ctx, { loopGuardRepeatThreshold: 8, loopGuardMinSentenceChars: 48, loopGuardMinReasoningChars: 2000 })
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    ...Array.from({ length: 30 }, (_, i) => ({ type: 'reasoning-delta', index: 0, delta: loopSentence(i) + '\n' })),
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ]
  const parent = new AbortController()
  const options = { provider: 'deepseek', model: 'deepseek/deepseek-flash', signal: parent.signal }
  const out = await drain(onion(listeners, options, source(chunks)))
  check(name + ': identical passthrough', JSON.stringify(out) === JSON.stringify(chunks))
  check(name + ': signal not swapped', options.signal === parent.signal)
}

// ── 用例 D：武装阈值防误伤（重复达到但总字符不足）───────────────────────────
{
  const name = 'D.arming-threshold'
  const { ctx, listeners } = makeCtx()
  installLoopGuard(ctx, { loopGuardRepeatThreshold: 8, loopGuardMinSentenceChars: 48, loopGuardMinReasoningChars: 2000 })
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    ...Array.from({ length: 8 }, (_, i) => ({ type: 'reasoning-delta', index: 0, delta: loopSentence(i) + '\n' })),
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
  const out = await drain(onion(listeners, {}, source(chunks)))
  check(name + ': not triggered below arming chars', out[out.length - 1].reason.kind === 'tool-calls' && out.length === chunks.length)
}

// ── 用例 E：短句防误伤（句子 < minSentenceChars）────────────────────────────
{
  const name = 'E.short-sentence-guard'
  const { ctx, listeners } = makeCtx()
  installLoopGuard(ctx, { loopGuardRepeatThreshold: 8, loopGuardMinSentenceChars: 48, loopGuardMinReasoningChars: 200 })
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    ...Array.from({ length: 20 }, () => ({ type: 'reasoning-delta', index: 0, delta: '再想一下；' })),
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
  const out = await drain(onion(listeners, {}, source(chunks)))
  check(name + ': short repeats not flagged', out[out.length - 1].reason.kind === 'tool-calls' && out.length === chunks.length)
}

// ── 用例 F：守卫内部错误 → fail-open 直通 + 显式日志 ────────────────────────
{
  const name = 'F.fail-open'
  const { ctx, listeners, logs } = makeCtx()
  installLoopGuard(ctx, { loopGuardRepeatThreshold: 8, loopGuardMinSentenceChars: 48, loopGuardMinReasoningChars: 200 })
  const poisoned = [{ type: 'block-start', get index() { throw new Error('boom') }, blockType: 'reasoning' }]
  const chunks = [
    ...poisoned,
    { type: 'reasoning-delta', index: 0, delta: uniqueSentence(1) },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
  const out = await drain(onion(listeners, { provider: 'zhipuai', model: 'glm-5.3-flash' }, source(chunks)))
  // 注意：poisoned chunk 带触发式 getter，不能 JSON.stringify 整个数组比对
  check(name + ': all chunks forwarded', out.length === 3 && out[0].type === 'block-start' && out[1].type === 'reasoning-delta' && out[2].type === 'finish' && out[2].reason.kind === 'tool-calls')
  check(name + ': loud fail-open log', logs.some((l) => l[0] === 'warn' && String(l.join(' ')).includes('fail-open')))
}

// ── 用例 G：消费者提前中断 → 上游关闭、无泄漏 ───────────────────────────────
{
  const name = 'G.consumer-break'
  const { ctx, listeners } = makeCtx()
  installLoopGuard(ctx, { loopGuardRepeatThreshold: 8, loopGuardMinSentenceChars: 48, loopGuardMinReasoningChars: 2000 })
  const st = {}
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    ...Array.from({ length: 50 }, (_, i) => ({ type: 'reasoning-delta', index: 0, delta: loopSentence(i) + '\n' })),
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
  const s = onion(listeners, { provider: 'zhipuai', model: 'glm-5.3-flash' }, source(chunks, st))
  let n = 0
  for await (const _ of s) { n++; if (n >= 3) break }
  await new Promise((r) => setTimeout(r, 20))
  check(name + ': source closed on consumer break', st.closed === true)
}

// ── 用例 H：signal 桥接（消费者 abort → 上游 abort）─────────────────────────
{
  const name = 'H.signal-bridge'
  const { ctx, listeners } = makeCtx()
  installLoopGuard(ctx, { loopGuardRepeatThreshold: 8, loopGuardMinSentenceChars: 48, loopGuardMinReasoningChars: 2000 })
  const parent = new AbortController()
  const options = { provider: 'zhipuai', model: 'glm-5.3-flash', signal: parent.signal }
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    ...Array.from({ length: 40 }, (_, i) => ({ type: 'reasoning-delta', index: 0, delta: loopSentence(i) + '\n' })),
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
  const s = onion(listeners, options, source(chunks))
  const it = s[Symbol.asyncIterator]()
  await it.next()
  const swapped = options.signal !== parent.signal
  check(name + ': signal swapped in place', swapped)
  parent.abort(new Error('user stop'))
  await new Promise((r) => setTimeout(r, 10))
  check(name + ': parent abort bridges to child', options.signal.aborted === true)
  try { await it.return?.() } catch { /* 桥接中断后消费结束属预期 */ }
}

// ── 用例 I：isGlmRoute 路由矩阵 ─────────────────────────────────────────────
{
  const { isGlmRoute } = await import('../lib/index.js')
  const name = 'I.route-matrix'
  check(name + ': zhipuai glm ok', isGlmRoute({ provider: 'zhipuai', model: 'zhipuai/glm-5.3-flash' }) === true)
  check(name + ': bare glm ok', isGlmRoute({ provider: 'zhipuai', model: 'glm-5.3-flash' }) === true)
  check(name + ': deepseek no', isGlmRoute({ provider: 'deepseek', model: 'deepseek/deepseek-flash' }) === false)
  check(name + ': zhipuai non-glm no', isGlmRoute({ provider: 'zhipuai', model: 'zhipuai/other-chat-v2' }) === false)
  check(name + ': junk no', isGlmRoute(null) === false && isGlmRoute('x') === false && isGlmRoute({ provider: 'zhipuai' }) === false)
}

// ── 用例 J：事件账本（默认路径推导 + 字段完整性）─────────────────────────────
{
  const name = 'J.event-ledger'
  const { ctx, listeners } = makeCtx()
  const file = '/tmp/dsh-glm-selftest-events-j-' + Date.now() + '.jsonl'
  installLoopGuard(ctx, { loopGuardRepeatThreshold: 8, loopGuardMinSentenceChars: 48, loopGuardMinReasoningChars: 2000 }, { eventsFile: file })
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    ...Array.from({ length: 25 }, (_, i) => ({ type: 'reasoning-delta', index: 0, delta: uniqueSentence(i) + '。' })),
    ...Array.from({ length: 10 }, (_, i) => ({ type: 'reasoning-delta', index: 0, delta: loopSentence(1123 + i) + '\n' })),
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
  await drain(onion(listeners, { provider: 'zhipuai', model: 'zhipuai/glm-5.3-flash', sessionId: 'session-j' }, source(chunks)))
  const lines = readFileSync(file, 'utf8').trim().split('\n')
  check(name + ': exactly one JSON line', lines.length === 1)
  const ev = JSON.parse(lines[0])
  check(name + ': fields complete', ev.provider === 'zhipuai' && ev.model === 'zhipuai/glm-5.3-flash' && ev.sessionId === 'session-j' && ev.repeat >= 8 && ev.reasoningChars > 2000 && typeof ev.estimatedWastedTokens === 'number' && typeof ev.time === 'string' && typeof ev.sample === 'string')
  check(name + ': real ledger untouched by selftest', !existsSync(join(homedir(), '.dsh', 'dsh-glm-mode', 'guard-events.jsonl')))
}


// ── spin-guard 测试基建：双瀑布槽（llm/stream 检测 + agent/pre-step 干预）───
function makeSpinCtx() {
  const slots = { 'llm/stream': [], 'agent/pre-step': [] }
  const logs = []
  return {
    ctx: {
      on: (event, fn) => { if (slots[event]) slots[event].push(fn); return () => {} },
      logger: { info: (...a) => logs.push(['info', ...a]), warn: (...a) => logs.push(['warn', ...a]) },
    },
    slots,
    logs,
    async glmStream(options, chunks) {
      let s = source(chunks)
      for (const l of slots['llm/stream']) { const inner = s; s = l(options, () => inner) }
      return await drain(s)
    },
    async preStep(sessionId, baseDecision, signal) {
      let s = async () => (baseDecision ? JSON.parse(JSON.stringify(baseDecision)) : { kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: 'task' }] }] })
      for (const l of slots['agent/pre-step']) { const inner = s; s = async () => l({ agent: { session: { id: sessionId } }, signal }, inner) }
      return await s()
    },
  }
}
const markerCall = (text) => [
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'tool-call-delta', index: 0, name: 'run_code', argumentsDelta: JSON.stringify({ code: 'console.log("' + (text || 'marker') + '")', description: 'note' }) },
  { type: 'block-end', index: 0, block: { type: 'tool-call' } },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]
const realCall = () => [
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'tool-call-delta', index: 0, name: 'run_code', argumentsDelta: JSON.stringify({ code: 'const out = await tools.bash({ command: "ls /tmp" }); console.log(out)', description: 'work' }) },
  { type: 'block-end', index: 0, block: { type: 'tool-call' } },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]
const GLM_OPTS = (sid) => ({ provider: 'zhipuai', model: 'zhipuai/glm-5.3-flash', ...(sid ? { sessionId: sid } : {}) })

// ── 用例 K：连续占位达阈值 → pre-step 注入纠偏一次并清零 ────────────────────
{
  const name = 'K.spin-inject-then-reset'
  const spin = makeSpinCtx()
  const file = '/tmp/dsh-glm-selftest-spin-k-' + Date.now() + '.jsonl'
  installSpinGuard(spin.ctx, { spinGuardStreakThreshold: 5, spinGuardMaxCodeChars: 200, spinGuardWindowMs: 900000 }, { eventsFile: file })
  const sid = 'session-k'
  for (let i = 0; i < 5; i++) await spin.glmStream(GLM_OPTS(sid), markerCall('m' + i))
  const d1 = await spin.preStep(sid)
  check(name + ': notice appended', Array.isArray(d1.messages) && d1.messages.length === 2, JSON.stringify(d1).slice(0, 120))
  check(name + ': notice shape user/text', d1.messages[1].role === 'user' && d1.messages[1].content[0].type === 'text')
  check(name + ': notice names run_code + heredoc + count', d1.messages[1].content[0].text.includes('run_code') && d1.messages[1].content[0].text.includes('heredoc') && d1.messages[1].content[0].text.includes('5'))
  check(name + ': loud log emitted', spin.logs.some((l) => l[0] === 'info' && String(l.join(' ')).includes('spin-guard')))
  const d2 = await spin.preStep(sid)
  check(name + ': streak cleared after inject', d2.messages.length === 1)
  const lines = readFileSync(file, 'utf8').trim().split('\n')
  const ev = JSON.parse(lines[0])
  check(name + ': ledger one tool-spin line', lines.length === 1 && ev.kind === 'tool-spin' && ev.sessionId === sid && ev.streak === 5 && ev.injected === true)
}

// ── 用例 L：实质调用打断 streak（含 tools.* 的 run_code）─────────────────────
{
  const name = 'L.real-call-resets'
  const spin = makeSpinCtx()
  installSpinGuard(spin.ctx, { spinGuardStreakThreshold: 5, spinGuardMaxCodeChars: 200, spinGuardWindowMs: 900000 })
  const sid = 'session-l'
  for (let i = 0; i < 3; i++) await spin.glmStream(GLM_OPTS(sid), markerCall())
  await spin.glmStream(GLM_OPTS(sid), realCall())
  for (let i = 0; i < 3; i++) await spin.glmStream(GLM_OPTS(sid), markerCall())
  const d = await spin.preStep(sid)
  check(name + ': real call resets streak, no inject', d.messages.length === 1)
}

// ── 用例 M：无 sessionId 的一次性 glm 请求零感知（title/压缩摘要）────────────
{
  const name = 'M.no-session-id-ignored'
  const spin = makeSpinCtx()
  installSpinGuard(spin.ctx, { spinGuardStreakThreshold: 5, spinGuardMaxCodeChars: 200, spinGuardWindowMs: 900000 })
  const sid = 'session-m'
  for (let i = 0; i < 6; i++) await spin.glmStream(GLM_OPTS(null), markerCall())
  const d = await spin.preStep(sid)
  check(name + ': sessionless streams never count', d.messages.length === 1)
}

// ── 用例 N：非 GLM 路由零感知 ────────────────────────────────────────────────
{
  const name = 'N.non-glm-ignored'
  const spin = makeSpinCtx()
  installSpinGuard(spin.ctx, { spinGuardStreakThreshold: 5, spinGuardMaxCodeChars: 200, spinGuardWindowMs: 900000 })
  const sid = 'session-n'
  for (let i = 0; i < 6; i++) await spin.glmStream({ provider: 'deepseek', model: 'deepseek/deepseek-chat', sessionId: sid }, markerCall())
  const d = await spin.preStep(sid)
  check(name + ': deepseek stream never counts', d.messages.length === 1)
}

// ── 用例 O：断流窗口过期 → streak 清零不干预 ─────────────────────────────────
{
  const name = 'O.window-expiry'
  const spin = makeSpinCtx()
  installSpinGuard(spin.ctx, { spinGuardStreakThreshold: 5, spinGuardMaxCodeChars: 200, spinGuardWindowMs: 1 })
  const sid = 'session-o'
  for (let i = 0; i < 5; i++) await spin.glmStream(GLM_OPTS(sid), markerCall())
  await new Promise((r) => setTimeout(r, 8))
  const d = await spin.preStep(sid)
  check(name + ': expired window no inject', d.messages.length === 1)
  const d2 = await spin.preStep(sid)
  check(name + ': streak cleared by expiry', d2.messages.length === 1)
}

// ── 用例 P：isPlaceholderRunCode 判定矩阵 ────────────────────────────────────
{
  const name = 'P.placeholder-matrix'
  const M = 200
  check(name + ': short marker is placeholder', isPlaceholderRunCode('run_code', JSON.stringify({ code: 'console.log("marker")' }), M) === true)
  check(name + ': tools.bash ref is real', isPlaceholderRunCode('run_code', JSON.stringify({ code: 'await tools.bash({command:"ls"})' }), M) === false)
  check(name + ': spaced tools. ref is real', isPlaceholderRunCode('run_code', JSON.stringify({ code: 'await tools . write({})' }), M) === false)
  check(name + ': long pure code is real', isPlaceholderRunCode('run_code', JSON.stringify({ code: 'x'.repeat(M) }), M) === false)
  check(name + ': other tool name is real', isPlaceholderRunCode('bash', JSON.stringify({ command: 'echo hi' }), M) === false)
  check(name + ': broken json is neutral', isPlaceholderRunCode('run_code', '{"code":"unterminated', M) === null)
  check(name + ': missing code is neutral', isPlaceholderRunCode('run_code', JSON.stringify({ description: 'x' }), M) === null)
}

// ── 用例 Q：检测面内部错误 → fail-open 全透传 ────────────────────────────────
{
  const name = 'Q.spin-fail-open'
  const spin = makeSpinCtx()
  installSpinGuard(spin.ctx, { spinGuardStreakThreshold: 5, spinGuardMaxCodeChars: 200, spinGuardWindowMs: 900000 })
  const poisoned = [{ type: 'tool-call-delta', get index() { throw new Error('boom') }, name: 'run_code', argumentsDelta: '{}' }]
  const chunks = [...poisoned, { type: 'finish', reason: { kind: 'tool-calls' } }]
  const out = await spin.glmStream(GLM_OPTS('session-q'), chunks)
  check(name + ': all chunks forwarded', out.length === 2 && out[0].type === 'tool-call-delta' && out[1].type === 'finish')
  check(name + ': loud fail-open log', spin.logs.some((l) => l[0] === 'warn' && String(l.join(' ')).includes('fail-open')))
  const d = await spin.preStep('session-q')
  check(name + ': no inject after fail-open', d.messages.length === 1)
}

// ── 用例 R：pre-step 非 enter 决策原样透传 ───────────────────────────────────
{
  const name = 'R.non-enter-decision'
  const spin = makeSpinCtx()
  installSpinGuard(spin.ctx, { spinGuardStreakThreshold: 5, spinGuardMaxCodeChars: 200, spinGuardWindowMs: 900000 })
  const sid = 'session-r'
  for (let i = 0; i < 5; i++) await spin.glmStream(GLM_OPTS(sid), markerCall())
  const d = await spin.preStep(sid, { kind: 'reject', reason: 'blocked' })
  check(name + ': reject passthrough untouched', d.kind === 'reject' && d.reason === 'blocked')
}

// ── 用例 S：中立步（纯文本/解析失败）不打断 streak 至阈值 ────────────────────
{
  const name = 'S.neutral-steps-keep-streak'
  const spin = makeSpinCtx()
  const fileS = '/tmp/dsh-glm-selftest-spin-s-' + Date.now() + '.jsonl'
  installSpinGuard(spin.ctx, { spinGuardStreakThreshold: 5, spinGuardMaxCodeChars: 200, spinGuardWindowMs: 900000 }, { eventsFile: fileS })
  const sid = 'session-s'
  for (let i = 0; i < 4; i++) await spin.glmStream(GLM_OPTS(sid), markerCall())
  // 纯文本步（无工具调用）：中立，不清零也不加一
  await spin.glmStream(GLM_OPTS(sid), [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, delta: '让我想想。' },
    { type: 'block-end', index: 0, block: { type: 'text' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  // 解析失败步（error 流截断）：中立
  await spin.glmStream(GLM_OPTS(sid), [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, name: 'run_code', argumentsDelta: '{"code":"unterm' },
    { type: 'finish', reason: { kind: 'error' } },
  ])
  // 中立步不打断 streak：再 1 次占位后应达阈值（4+1=5）而非从零重计
  await spin.glmStream(GLM_OPTS(sid), markerCall('after-neutral'))
  const d = await spin.preStep(sid)
  check(name + ': neutral steps preserve streak to threshold', d.messages.length === 2)
}


// ── 用例 T：真实账本防线（selftest 绝不触碰活体对账流水）─────────────────────
{
  check('T.real-ledger-untouched-by-selftest', !existsSync(join(homedir(), '.dsh', 'dsh-glm-mode', 'guard-events.jsonl')))
}

console.log('\n==== selftest: ' + passed + ' passed, ' + failures.length + ' failed ====')
if (failures.length) { console.log(failures.join('\n')); process.exit(1) }
