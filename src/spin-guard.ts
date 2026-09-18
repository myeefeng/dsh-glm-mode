/**
 * ToolSpinGuard（工具空转守卫）——dsh-glm v0.4.0 新增层。
 *
 * 背景（2026-09-18 活体事故，session-74ddfa49 turn 19）：PTC 呈现下模型把大
 * markdown 塞进 run_code 内嵌 tools.write 的 JS 模板字符串 → 转义语法炸；随后
 * 模型幻觉「改用顶层 write 工具」——该会话顶层工具集只有 run_code（request/
 * header 实测 tool count=1，全 537 次调用 name 全为 run_code），顶层 write 不
 * 存在，模型发不出来，退化成连发 37 次占位 run_code（console.log("marker") 式，
 * 中位 34 字符、最长连续 23 步），烧掉 40+ 步才靠 bash heredoc 自救。
 *
 * 机制（Phase 2 实测自当版 dist，非记忆）：
 *  - 检测面 = llm/stream 瀑布（与 StreamLoopGuard 同缝）。chunk 协议中工具调用
 *    = block-start{blockType:"tool-call"} + tool-call-delta{id,name,argumentsDelta}
 *    + block-end（dsh-llm dist:928-933、1135-1139）；options.sessionId 由
 *    dsh-agent-loop buildRequest 注入（dist:1213），title/压缩摘要等非 agent
 *    请求没有它，天然零感知。
 *  - 干预面 = agent/pre-step 瀑布：决策 {kind:"enter", messages} 可被监听器改写，
 *    追加的 message 被 agent-loop 在 step 首次尝试时 append 为 user/message
 *    （firstAttempt 防重试重复，dist:1036）并经 session.deriveMessages 进入后续
 *    请求——这是 agent-loop 官方注入通道（原生 context sections 即走此路）；
 *    dsh-compaction-basic:798 是本缝的监听先例。
 *  - 为什么不在 llm/stream 注入：请求对象被 Object.freeze（agent-loop
 *    dist:1210-1215），messages 数组冻结不可 push；waterfall fallback 闭包引用
 *    原始 options，next() 换新对象也到不了 adapter——检测与干预必须分缝。
 *
 * 判定：本步存在工具调用且全部为 name==="run_code" 且 code 无 tools. 实质引用
 * 且 code 长度 < maxCodeChars → 记占位一次；任一实质调用（含 tools.*、或超长
 * 纯计算代码）清零；参数不可解析（error 流截断等）保持中立不更新。同一会话
 * 连续 ≥ threshold 且距最近占位 < windowMs → 下一步请求注入一条纠偏 user 消息
 * （点名：顶层无 write、大文本走 bash heredoc、认真构造 run_code），注入一次
 * 即清零。
 *
 * 红线：不碰 wire/压缩/persona/maxTokens（v0.3.0 在案决策全继承）；尾部追加
 * user 消息不动前缀（隐式前缀缓存只失配增量，代价远小于事故本体的 37 轮重放）；
 * fail-open——两个监听器的内部错误一律放行原流/原决策 + 显式日志；事件追加写
 * guard-events.jsonl（kind:"tool-spin"，只增不改，不碰会话记录）。
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isGlmRoute } from './loop-guard.js'

/** 守卫配置（与插件 Config 对应字段子集）。 */
export interface SpinGuardConfig {
  /** 连续占位 run_code 达到该次数即在下一次请求前注入纠偏。 */
  spinGuardStreakThreshold: number
  /** 参与占位判定的 run_code code 最大长度（字符）——≥ 该值视为有实质内容。 */
  spinGuardMaxCodeChars: number
  /** 距最近一次占位超过该毫秒数即视为断流，streak 清零。 */
  spinGuardWindowMs: number
}

/** 守卫宿主需要的最小上下文能力（运行时 cordis ctx 的结构子集）。 */
export interface SpinGuardContext {
  on(
    event: string,
    listener: (options: unknown, next: () => unknown) => unknown,
    opts?: Record<string, unknown>,
  ): unknown
  logger?: {
    info?(...args: unknown[]): void
    warn?(...args: unknown[]): void
  }
}

/** dsh-llm chunk 协议最小子集（本守卫只消费工具调用相关字段）。 */
interface LlmChunk {
  type: string
  index?: number
  name?: string
  argumentsDelta?: string
}

const TAG = '[dsh-glm][spin-guard]'

/** 事件账本默认路径：与 loop-guard 同一份 guard-events.jsonl（kind 字段区分）。 */
export function defaultSpinEventsFile(): string {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(dshHome, 'dsh-glm-mode', 'guard-events.jsonl')
}

/** 每会话空转状态（内存态，随插件 fiber 生命周期存活）。 */
interface SessionSpin {
  streak: number
  lastAt: number
  lastModel?: string
}

/**
 * 单个工具调用的占位判定。
 * @returns true=占位（无 tools. 引用且 code 短）／false=实质（含 tools.* 或
 * code 达到实质长度）／null=无法判定（参数不完整或不可解析，中立处理）。
 */
export function isPlaceholderRunCode(
  name: string,
  argumentsJson: string,
  maxCodeChars: number,
): boolean | null {
  if (name !== 'run_code') return false
  let code: string | undefined
  try {
    const args = JSON.parse(argumentsJson) as { code?: unknown }
    if (typeof args?.code !== 'string') return null
    code = args.code
  } catch {
    return null
  }
  // 任一 tools.* 引用即实质调用（嵌套 bash/read/write/edit…都算真干活）。
  if (/tools\s*\./.test(code)) return false
  // 达到实质长度的纯计算/打印代码宁可漏判（streak 不涨）也不误扰（不注入）。
  if (code.length >= maxCodeChars) return false
  return true
}

/**
 * 安装工具空转守卫：注册 llm/stream（检测）与 agent/pre-step（干预）两个监听，
 * 均随插件 fiber 生命周期自动清理。
 * @param opts.eventsFile 事件账本路径（自测注入用；缺省与 loop-guard 同一份）。
 * @returns disposer（额外清理内存态；ctx.on 自带者由运行时管理）。
 */
export function installSpinGuard(
  ctx: SpinGuardContext,
  cfg: SpinGuardConfig,
  opts?: { eventsFile?: string },
): () => void {
  const eventsFile = opts?.eventsFile ?? defaultSpinEventsFile()
  const sessions = new Map<string, SessionSpin>()

  function appendEventFile(payload: Record<string, unknown>): void {
    try {
      mkdirSync(dirname(eventsFile), { recursive: true })
      appendFileSync(eventsFile, JSON.stringify(payload) + '\n')
    } catch (error) {
      // 账本写不进去只影响事后对账，不影响干预本身——显式日志，不静默。
      ctx.logger?.warn?.(TAG, '事件账本写入失败（不影响干预本身）:', eventsFile, String(error))
    }
  }

  // ── ① 检测面：llm/stream（仅 zhipuai glm-* 且 agent-loop 请求）────────────
  ctx.on('llm/stream', (options: unknown, next: () => unknown) => {
    // 非 GLM 路由：零包装零感知。
    if (!isGlmRoute(options)) return next()
    const o = options as { provider?: string; model?: string; sessionId?: unknown }
    // 无 sessionId = 非 agent-loop 请求（会话标题、压缩摘要等一次性调用）：
    // 不属于「模型在任务里空转」，零感知。
    if (typeof o.sessionId !== 'string' || o.sessionId.length === 0) return next()

    const calls = new Map<number, { name: string; args: string }>()
    let broken = false

    function observe(chunk: LlmChunk): void {
      if (chunk?.type === 'tool-call-delta') {
        const idx = chunk.index ?? 0
        const c = calls.get(idx) ?? { name: '', args: '' }
        if (typeof chunk.name === 'string' && chunk.name) c.name = chunk.name
        c.args += String(chunk.argumentsDelta ?? '')
        calls.set(idx, c)
      }
    }

    function settle(): void {
      if (calls.size === 0) return // 纯文本/纯思考步：中立，不影响 streak
      let anyReal = false
      let anyUnknown = false
      for (const c of calls.values()) {
        const r = isPlaceholderRunCode(c.name, c.args, cfg.spinGuardMaxCodeChars)
        if (r === false) anyReal = true
        else if (r === null) anyUnknown = true
      }
      const key = o.sessionId as string
      const st = sessions.get(key) ?? { streak: 0, lastAt: 0 }
      if (anyReal) {
        st.streak = 0
      } else if (!anyUnknown) {
        st.streak += 1
        st.lastAt = Date.now()
        st.lastModel = o.model
      }
      sessions.set(key, st)
      if (st.streak >= cfg.spinGuardStreakThreshold) {
        ctx.logger?.warn?.(
          TAG,
          '检测到连续占位 run_code（将在下一次请求前注入纠偏）:',
          JSON.stringify({ sessionId: key, streak: st.streak, model: o.model }),
        )
      }
    }

    async function* guarded(source: AsyncIterable<LlmChunk>): AsyncGenerator<LlmChunk> {
      try {
        for await (const chunk of source) {
          if (!broken) {
            try {
              observe(chunk)
            } catch (error) {
              // fail-open：守卫内部错误绝不弄挂流水线，退位为直通 + 显式日志。
              broken = true
              ctx.logger?.warn?.(TAG, '流检测内部错误，退位为直通（fail-open）:', error)
            }
          }
          yield chunk
        }
      } finally {
        if (!broken) {
          try {
            settle()
          } catch (error) {
            ctx.logger?.warn?.(TAG, '流结算失败（streak 状态可能滞后）:', error)
          }
        }
      }
    }

    const downstream = next()
    if (typeof (downstream as AsyncIterable<LlmChunk> | null)?.[Symbol.asyncIterator] !== 'function') {
      ctx.logger?.warn?.(TAG, '下游流不是 AsyncIterable，守卫放行原始值（协议变更需跟进）')
      return downstream
    }
    return guarded(downstream as AsyncIterable<LlmChunk>)
  })

  // ── ② 干预面：agent/pre-step（官方消息注入通道）──────────────────────────
  ctx.on('agent/pre-step', async (options: unknown, next: () => unknown) => {
    try {
      const o = options as { agent?: { session?: { id?: unknown } }; signal?: AbortSignal }
      const sessionId = o?.agent?.session?.id
      if (typeof sessionId !== 'string' || sessionId.length === 0) return await next()
      const st = sessions.get(sessionId)
      if (!st || st.streak < cfg.spinGuardStreakThreshold) return await next()
      // 断流窗口：距最近占位太久说明问题已自行缓解（或换了任务），清零放行。
      if (Date.now() - st.lastAt > cfg.spinGuardWindowMs) {
        st.streak = 0
        return await next()
      }
      if (o?.signal?.aborted) return await next()
      const decision = (await next()) as
        | { kind?: string; messages?: unknown[] }
        | undefined
      // 非 enter 决策（reject 等）原样透传，不碰。
      if (
        !decision ||
        typeof decision !== 'object' ||
        decision.kind !== 'enter' ||
        !Array.isArray(decision.messages)
      ) {
        return decision
      }
      // 官方通道追加纠偏消息：agent-loop 会把它 append 为 user/message 并进入
      // 本步请求。尾部追加不动前缀（隐式前缀缓存仅失配增量）。
      const notice = [
        '[dsh-glm spin-guard] 你刚刚连续 ' + st.streak + ' 次发出占位 run_code 调用（code 里没有任何 tools.* 实质调用）。纠正三点：',
        '1. 顶层只有 run_code 一个工具——write/read/bash/edit 等都不存在于顶层，只能在 run_code 的 code 参数里用 await tools.xxx({...}) 调用；',
        '2. 把大段文本（markdown/JSON/代码）写盘时，不要用 JS 模板字符串直包（反引号与美元花括号转义极易炸），改用 await tools.bash({command}) 配合单引号 heredoc（cat > file 加 <<加引号的EOF 标记），或先 base64 再解码落盘；',
        '3. 嵌套 tools.write 写已存在的文件会因 file-not-observed 策略被拒——先 tools.read 再写，或直接走 heredoc。',
        '现在请认真构造一个能实际推进当前目标的 run_code 调用。',
      ].join('\n')
      decision.messages = [
        ...decision.messages,
        { role: 'user', content: [{ type: 'text', text: notice }] },
      ]
      appendEventFile({
        time: new Date().toISOString(),
        kind: 'tool-spin',
        sessionId,
        streak: st.streak,
        injected: true,
        model: st.lastModel,
      })
      st.streak = 0
      ctx.logger?.info?.(
        TAG,
        '已注入工具纠偏消息（连续占位达阈值后干预一次）:',
        JSON.stringify({ sessionId }),
      )
      return decision
    } catch (error) {
      // fail-open：干预失败绝不阻断步进。
      ctx.logger?.warn?.(TAG, 'pre-step 干预失败，放行原决策（fail-open）:', error)
      return await next()
    }
  })

  return () => {
    sessions.clear()
  }
}

