/**
 * dsh-glm host: 「GLM 模式」Agent 预设生命周期 + GLM 自动压缩兜底引擎 + 守卫家族。
 *
 * v0.4.0 起：思考死循环守卫（loop-guard，v0.3.0）+ 工具空转守卫（spin-guard）。
 *
 * 与 dsh-kiro 的形态对齐，但职责更窄：
 *   - GLM 本体走 llm-pi-ai 的 zhipuai 路由（settings.yaml 配置 z.ai 思考格式、
 *     原生多模态输入；pi-ai 层对 mify 网关的 GLM 模型发送 tool_stream），无需
 *     Kiro 式本地代理适配器。
 *   - 「GLM 模式」预设随插件安装/卸载（cpSync 到 ~/.dsh/.agent-presets/glm），
 *     预设内自带隔离压缩 owner（GLM 阈值 0.75/0.22）——官方 "nearest owner
 *     wins" 语义：无论 host 压缩槽被 dsh-kiro 还是本插件先占，GLM 会话都
 *     确定性走预设内阈值。
 *   - 仅当 host 压缩槽空闲（例如部署未装 dsh-kiro）时，本插件补挂 GlmCompactionEngine
 *     兜底：GLM 会话即使没选 GLM 预设也能吃到 GLM 阈值，而非溢出级 0.98。
 */
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import z from '@deepseek-ai/schemastery';
export { defaultEventsFile, installLoopGuard, isGlmRoute, ReasoningLoopDetector } from './loop-guard.js';
export { defaultSpinEventsFile, installSpinGuard, isPlaceholderRunCode } from './spin-guard.js';
export declare const name = "dsh-glm-mode";
export declare const inject: string[];
export interface Config {
    /** 自动压缩（Codex 式）：false 时仅在 GLM 预设内保留手动 /compact service。 */
    compactEnabled: boolean;
    /** GLM 会话的压缩阈值（上下文占比），达到即自动压缩。 */
    glmThresholdRatio: number;
    /** GLM 会话压缩后保留的最近上下文占比。 */
    glmRetainRatio: number;
    /** 其它模型会话的兜底压缩阈值（默认 0.98，仅溢出级兜底）。 */
    otherThresholdRatio: number;
    /** 其它模型会话的兜底保留占比。 */
    otherRetainRatio: number;
    /** 随插件安装「GLM 模式」Agent 预设（装=自动写入，卸载=自动删除）。 */
    glmPresetEnabled: boolean;
    /** 思考死循环守卫（v0.3.0）：GLM reasoning 流重复检测 + 提前截断。 */
    loopGuardEnabled: boolean;
    /** 同一句子连续重复达到该次数即判定死循环。 */
    loopGuardRepeatThreshold: number;
    /** 参与比对的句子最小长度（字符）。 */
    loopGuardMinSentenceChars: number;
    /** 累计 reasoning 字符达到该值后才武装判定。 */
    loopGuardMinReasoningChars: number;
    /** 工具空转守卫（v0.4.0）：连续占位 run_code 检测 + 下一次请求前注入纠偏。 */
    spinGuardEnabled: boolean;
    /** 连续占位 run_code 达到该次数即干预。 */
    spinGuardStreakThreshold: number;
    /** 占位判定的 code 长度上限（≥ 视为有实质内容，不判占位）。 */
    spinGuardMaxCodeChars: number;
    /** 距最近占位超过该毫秒数视为断流（streak 清零，不干预）。 */
    spinGuardWindowMs: number;
}
export declare const Config: z<Schemastery.ObjectS<{
    compactEnabled: z<boolean, boolean>;
    glmThresholdRatio: z<number, number>;
    glmRetainRatio: z<number, number>;
    otherThresholdRatio: z<number, number>;
    otherRetainRatio: z<number, number>;
    glmPresetEnabled: z<boolean, boolean>;
    loopGuardEnabled: z<boolean, boolean>;
    loopGuardRepeatThreshold: z<number, number>;
    loopGuardMinSentenceChars: z<number, number>;
    loopGuardMinReasoningChars: z<number, number>;
    spinGuardEnabled: z<boolean, boolean>;
    spinGuardStreakThreshold: z<number, number>;
    spinGuardMaxCodeChars: z<number, number>;
    spinGuardWindowMs: z<number, number>;
}>, Schemastery.ObjectT<{
    compactEnabled: z<boolean, boolean>;
    glmThresholdRatio: z<number, number>;
    glmRetainRatio: z<number, number>;
    otherThresholdRatio: z<number, number>;
    otherRetainRatio: z<number, number>;
    glmPresetEnabled: z<boolean, boolean>;
    loopGuardEnabled: z<boolean, boolean>;
    loopGuardRepeatThreshold: z<number, number>;
    loopGuardMinSentenceChars: z<number, number>;
    loopGuardMinReasoningChars: z<number, number>;
    spinGuardEnabled: z<boolean, boolean>;
    spinGuardStreakThreshold: z<number, number>;
    spinGuardMaxCodeChars: z<number, number>;
    spinGuardWindowMs: z<number, number>;
}>>;
type CompactionAgent = Parameters<BasicCompactionEngine['compactIfNeeded']>[0];
type CompactionTrigger = Parameters<BasicCompactionEngine['compactIfNeeded']>[1];
/**
 * Host fallback engine，语义同 dsh-kiro 的 KiroCompactionEngine：当会话所属
 * preset 发布了自己的隔离压缩 owner（如「GLM 模式」预设内置的压缩组），
 * 最近的 owner 胜出，本兜底引擎退位为 no-op，避免双引擎阈值/重试预算冲突。
 */
export declare class GlmCompactionEngine extends BasicCompactionEngine {
    compactIfNeeded(agent: CompactionAgent, trigger: CompactionTrigger, signal: AbortSignal): ReturnType<BasicCompactionEngine['compactIfNeeded']>;
}
interface AppContext {
    get(name: string): unknown;
    plugin(plugin: unknown, config?: unknown): void;
    effect(fn: () => void | (() => void), tag?: string): void;
    /** 事件监听（cordis ctx.on）；守卫用它挂 llm/stream 瀑布监听，随 fiber 自动清理。 */
    on(event: string, listener: (options: unknown, next: () => unknown) => unknown, opts?: Record<string, unknown>): unknown;
    logger?: {
        info?(...args: unknown[]): void;
        warn?(...args: unknown[]): void;
    };
}
export declare function apply(ctx: AppContext, config: Config): void;
