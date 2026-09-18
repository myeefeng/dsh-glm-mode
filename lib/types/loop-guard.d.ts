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
/** 守卫配置（与插件 Config 对应字段子集）。 */
export interface LoopGuardConfig {
    /** 同一段句子连续重复达到该次数即判定死循环。 */
    loopGuardRepeatThreshold: number;
    /** 参与比对的句子最小长度（字符）——短句重复不判。 */
    loopGuardMinSentenceChars: number;
    /** 累计 reasoning 字符达到该值后才武装判定——避免误伤开头阶段的正常重复。 */
    loopGuardMinReasoningChars: number;
}
/** 守卫宿主需要的最小上下文能力（运行时 cordis ctx 的结构子集）。 */
export interface LoopGuardContext {
    on(event: string, listener: (options: unknown, next: () => unknown) => unknown, opts?: Record<string, unknown>): unknown;
    logger?: {
        info?(...args: unknown[]): void;
        warn?(...args: unknown[]): void;
    };
}
/** 仅 zhipuai 路由的 glm-* 模型走守卫；其余路由零感知。 */
export declare function isGlmRoute(options: unknown): boolean;
/**
 * 句子级连续重复检测器（每个 reasoning block 一个实例）。
 * 判定：同一句子（trim 后全等，或 ≥3 位数字串归一化后全等——防
 * calls=1123→1124 这类计数漂移漏检；1-2 位序号属合法枚举不折叠）连续出现
 * ≥ K 次，且流内累计 reasoning 字符 ≥ 武装阈值。
 */
export declare class ReasoningLoopDetector {
    private readonly cfg;
    private buf;
    private last;
    private lastNorm;
    private count;
    /** 本 block 累计 reasoning 全文（合成 block-end 时回填，保持与已流出的 delta 一致）。 */
    text: string;
    constructor(cfg: LoopGuardConfig);
    /** 喂入一段 reasoning 增量；返回判定结果。 */
    feed(delta: string): {
        triggered: boolean;
        sample?: string;
        repeat?: number;
        chars?: number;
    };
}
/**
 * 事件账本默认路径：$DSH_HOME（缺省 ~/.dsh）/dsh-glm/guard-events.jsonl。
 * 只增不改的 JSONL 流水，专用于事后对账；不碰会话记录（防缓存失配与
 * 上下文污染），进程重启后仍可查。
 */
export declare function defaultEventsFile(): string;
/**
 * 安装守卫：注册 llm/stream 监听（随插件 fiber 生命周期自动清理）。
 * @param opts.eventsFile 事件账本路径（自测注入用；缺省 defaultEventsFile()）。
 * @returns disposer（ctx.on 自带者原样透传）。
 */
export declare function installLoopGuard(ctx: LoopGuardContext, cfg: LoopGuardConfig, opts?: {
    eventsFile?: string;
}): unknown;
