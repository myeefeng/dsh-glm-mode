/**
 * GLM 思考死循环守卫（StreamLoopGuard）——dsh-glm v0.3.0 新增层。
 *
 * 背景（2026-09-16 活体事故）：zhipuai/glm-5.3-flash 在 reasoningEffort=max 下
 * 单步纯思考输出 131,072 token（约 49 万字符、同一句循环约 2500 次），打满
 * maxTokens 上限被截断，用户等了 29.5 分钟只得到一条被掐断的回答。vLLM 官方
 * 库有同款模型缺陷报告（#56868 GLM-5.3-Flash long-decode degeneration）。
 *
 * 机制（Phase 2 实测自当版 dist，非记忆）：
 *  - dsh-llm 的 llm/stream 是瀑布事件：ctx.on("llm/stream", (options, next) => …)
 *    洋葱模型，next() 返回下游 chunk 流，监听器可包装（先例：dsh-session-title、
 *    dsh-session-checkpoint-policy、dsh-llm invariant validateStream）。
 *  - chunk 协议权威 = validateStream：block-start / *-delta / block-end /
 *    usage(≤1) / finish{reason}；finish 时不得有未闭合 block（error/aborted 除外）；
 *    finish 之后不得再有 chunk。本守卫合成的截断序列严格满足该语法。
 *  - llm/stream 瀑布的 fallback 闭包引用【原始 options 对象】——要换 signal 必须
 *    原地改写 options.signal（换成本守卫派生的子 AbortController），否则上游
 *    请求无法被提前取消，烧钱继续。
 *
 * 行为：仅对 zhipuai 路由的 glm-* 模型生效；只监测 reasoning 增量；句子级
 * 连续重复 ≥ K（数字归一化比对，防 calls=1123→1124 漂移漏检）即判定死循环，
 * 提前合成 finish{kind:"max-tokens"} 截断——下游 agent-loop / UI 完全复用既有
 * 「输出 token 上限」链路（回合锁存 + 回答保留 + 发送"继续"续跑），零新增 UI。
 *
 * 红线：不碰 wire（temp/thinking/tool_stream）、不碰压缩、不碰 persona、不改
 * maxTokens 默认（dsh-glm-build STATE 在案决策）。非 GLM 路由零包装零感知。
 * 守卫内部错误一律 fail-open（放行原始流）+ 显式日志——守卫绝不能反过来
 * 弄挂正常流水线；失败在日志可见，不静默。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
const TAG = '[dsh-glm][loop-guard]';
/** 句子切分终止符；无终止符时每 SOFT_CAP 字符强制切一刀。 */
const DELIMITERS = ['。', '！', '？', '!', '?', '；', ';', '\n'];
const SOFT_CAP = 200;
/** 粗略 token 估算除数（实测活体样本 490177 字符 ≈ 131072 token ≈ 3.74 字/token）。 */
const CHARS_PER_TOKEN_ESTIMATE = 3.7;
/** 仅 zhipuai 路由的 glm-* 模型走守卫；其余路由零感知。 */
export function isGlmRoute(options) {
    if (typeof options !== 'object' || options === null)
        return false;
    const o = options;
    if (o.provider !== 'zhipuai')
        return false;
    return typeof o.model === 'string' && /(^|\/)glm/i.test(o.model);
}
/**
 * 原地换 signal：llm/stream 瀑布的 fallback（adapterStream）闭包引用原始
 * options 对象，监听器返回值改不掉它——只能原地替换属性。派生子 controller
 * 保住「消费者中止 → 上游中止」的桥接，同时留出守卫单独硬取消上游的手柄。
 * @returns 硬取消上游的手柄；无法替换时返回 null（截断仍生效，仅少了提前止损）。
 */
function armAbortHandle(options) {
    try {
        const parent = options.signal;
        const inner = new AbortController();
        if (parent) {
            if (parent.aborted)
                inner.abort(parent.reason);
            else
                parent.addEventListener('abort', () => inner.abort(parent.reason), { once: true });
        }
        options.signal = inner.signal;
        return () => {
            try {
                inner.abort(new Error(TAG + ' reasoning repetition loop truncated this stream'));
            }
            catch { /* 已 abort 的 controller 再 abort 是 no-op */ }
        };
    }
    catch {
        return null;
    }
}
/**
 * 句子级连续重复检测器（每个 reasoning block 一个实例）。
 * 判定：同一句子（trim 后全等，或 ≥3 位数字串归一化后全等——防
 * calls=1123→1124 这类计数漂移漏检；1-2 位序号属合法枚举不折叠）连续出现
 * ≥ K 次，且流内累计 reasoning 字符 ≥ 武装阈值。
 */
export class ReasoningLoopDetector {
    cfg;
    buf = '';
    last = null;
    lastNorm = null;
    count = 0;
    /** 本 block 累计 reasoning 全文（合成 block-end 时回填，保持与已流出的 delta 一致）。 */
    text = '';
    constructor(cfg) {
        this.cfg = cfg;
    }
    /** 喂入一段 reasoning 增量；返回判定结果。 */
    feed(delta) {
        this.text += delta;
        this.buf += delta;
        while (true) {
            let cut = -1;
            let dlen = 0;
            for (const d of DELIMITERS) {
                const i = this.buf.indexOf(d);
                if (i >= 0 && (cut < 0 || i < cut)) {
                    cut = i;
                    dlen = d.length;
                }
            }
            let raw = null;
            if (cut >= 0) {
                raw = this.buf.slice(0, cut + dlen);
                this.buf = this.buf.slice(cut + dlen);
            }
            else if (this.buf.length >= SOFT_CAP) {
                raw = this.buf.slice(0, SOFT_CAP);
                this.buf = this.buf.slice(SOFT_CAP);
            }
            else {
                break;
            }
            const s = raw.trim();
            if (s.length < this.cfg.loopGuardMinSentenceChars)
                continue;
            // 仅归一化 ≥3 位数字串（轮询/迭代计数器 calls=1123→1124 这类漂移）；
            // 1-2 位序号（第0步/第1步）是合法枚举，折叠它们会把正常推理误判成循环。
            const norm = s.replace(/[0-9]{3,}/g, '#');
            if (this.last !== null && (s === this.last || norm === this.lastNorm)) {
                this.count++;
            }
            else {
                this.last = s;
                this.lastNorm = norm;
                this.count = 1;
            }
            if (this.count >= this.cfg.loopGuardRepeatThreshold && this.text.length >= this.cfg.loopGuardMinReasoningChars) {
                return { triggered: true, sample: s, repeat: this.count, chars: this.text.length };
            }
        }
        return { triggered: false };
    }
}
/**
 * 事件账本默认路径：$DSH_HOME（缺省 ~/.dsh）/dsh-glm/guard-events.jsonl。
 * 只增不改的 JSONL 流水，专用于事后对账；不碰会话记录（防缓存失配与
 * 上下文污染），进程重启后仍可查。
 */
export function defaultEventsFile() {
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
    return join(dshHome, 'dsh-glm-mode', 'guard-events.jsonl');
}
/**
 * 安装守卫：注册 llm/stream 监听（随插件 fiber 生命周期自动清理）。
 * @param opts.eventsFile 事件账本路径（自测注入用；缺省 defaultEventsFile()）。
 * @returns disposer（ctx.on 自带者原样透传）。
 */
export function installLoopGuard(ctx, cfg, opts) {
    const eventsFile = opts?.eventsFile ?? defaultEventsFile();
    return ctx.on('llm/stream', (options, next) => {
        // 非 GLM 路由：零包装零感知。
        if (!isGlmRoute(options))
            return next();
        const o = options;
        const monitors = new Map();
        const open = new Map();
        let broken = false;
        let triggered = null;
        const abortUpstream = armAbortHandle(options);
        function observe(chunk) {
            switch (chunk?.type) {
                case 'block-start': {
                    const idx = chunk.index ?? 0;
                    open.set(idx, String(chunk.blockType));
                    if (chunk.blockType === 'reasoning')
                        monitors.set(idx, new ReasoningLoopDetector(cfg));
                    break;
                }
                case 'reasoning-delta': {
                    const idx = chunk.index ?? 0;
                    const m = monitors.get(idx);
                    if (!m)
                        break;
                    const r = m.feed(String(chunk.delta ?? ''));
                    if (r.triggered && triggered === null)
                        triggered = { sample: r.sample, repeat: r.repeat, chars: r.chars };
                    break;
                }
                case 'block-end': {
                    open.delete(chunk.index ?? 0);
                    break;
                }
            }
        }
        async function* guarded(source) {
            try {
                for await (const chunk of source) {
                    if (!broken && triggered === null) {
                        try {
                            observe(chunk);
                        }
                        catch (error) {
                            // fail-open：守卫内部错误绝不弄挂流水线，退位为直通 + 显式日志。
                            broken = true;
                            warn(TAG, '内部错误，守卫退位为直通（fail-open）:', error);
                        }
                    }
                    if (triggered !== null) {
                        // 语法合规收尾：闭合所有 open block（error/aborted 之外的 finish 要求无
                        // open block），reasoning block 用已累计全文回填，与已流出的 delta 一致。
                        for (const [idx, blockType] of [...open.entries()]) {
                            const block = blockType === 'reasoning'
                                ? { type: 'reasoning', text: monitors.get(idx)?.text ?? '' }
                                : { type: blockType };
                            yield { type: 'block-end', index: idx, block };
                        }
                        open.clear();
                        yield { type: 'finish', reason: { kind: 'max-tokens' } };
                        return;
                    }
                    yield chunk;
                }
            }
            finally {
                // 生成器关闭（无论触发截断 return、消费者中止还是上游耗尽）都会走到这里。
                if (triggered !== null) {
                    const est = Math.round(triggered.chars / CHARS_PER_TOKEN_ESTIMATE);
                    warn(TAG, '思考死循环已截断:', JSON.stringify({
                        provider: o.provider,
                        model: o.model,
                        sessionId: typeof o.sessionId === 'string' ? o.sessionId : undefined,
                        repeat: triggered.repeat,
                        sample: triggered.sample.slice(0, 80),
                        reasoningChars: triggered.chars,
                        estimatedWastedTokens: est,
                        upstreamAborted: abortUpstream !== null,
                    }));
                    try {
                        abortUpstream?.();
                    }
                    catch { /* 尽力而为 */ }
                    appendEventFile({
                        time: new Date().toISOString(),
                        provider: o.provider,
                        model: o.model,
                        sessionId: typeof o.sessionId === 'string' ? o.sessionId : undefined,
                        repeat: triggered.repeat,
                        sample: triggered.sample.slice(0, 120),
                        reasoningChars: triggered.chars,
                        estimatedWastedTokens: est,
                    });
                }
            }
        }
        const warn = (...args) => ctx.logger?.warn?.(...args);
        function appendEventFile(payload) {
            try {
                mkdirSync(dirname(eventsFile), { recursive: true });
                appendFileSync(eventsFile, JSON.stringify(payload) + '\n');
            }
            catch (error) {
                // 账本写不进去只影响事后对账，不影响截断本身——显式日志，不静默。
                warn(TAG, '事件账本写入失败（不影响截断本身）:', eventsFile, String(error));
            }
        }
        const downstream = next();
        if (typeof downstream?.[Symbol.asyncIterator] !== 'function') {
            // 下游不是异步可迭代流（未知协议变更）：放行原值，日志留痕，不瞎包。
            warn(TAG, '下游流不是 AsyncIterable，守卫放行原始值（协议变更需跟进）');
            return downstream;
        }
        return guarded(downstream);
    });
}
//# sourceMappingURL=loop-guard.js.map