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
/** 守卫配置（与插件 Config 对应字段子集）。 */
export interface SpinGuardConfig {
    /** 连续占位 run_code 达到该次数即在下一次请求前注入纠偏。 */
    spinGuardStreakThreshold: number;
    /** 参与占位判定的 run_code code 最大长度（字符）——≥ 该值视为有实质内容。 */
    spinGuardMaxCodeChars: number;
    /** 距最近一次占位超过该毫秒数即视为断流，streak 清零。 */
    spinGuardWindowMs: number;
}
/** 守卫宿主需要的最小上下文能力（运行时 cordis ctx 的结构子集）。 */
export interface SpinGuardContext {
    on(event: string, listener: (options: unknown, next: () => unknown) => unknown, opts?: Record<string, unknown>): unknown;
    logger?: {
        info?(...args: unknown[]): void;
        warn?(...args: unknown[]): void;
    };
}
/** 事件账本默认路径：与 loop-guard 同一份 guard-events.jsonl（kind 字段区分）。 */
export declare function defaultSpinEventsFile(): string;
/**
 * 单个工具调用的占位判定。
 * @returns true=占位（无 tools. 引用且 code 短）／false=实质（含 tools.* 或
 * code 达到实质长度）／null=无法判定（参数不完整或不可解析，中立处理）。
 */
export declare function isPlaceholderRunCode(name: string, argumentsJson: string, maxCodeChars: number): boolean | null;
/**
 * 安装工具空转守卫：注册 llm/stream（检测）与 agent/pre-step（干预）两个监听，
 * 均随插件 fiber 生命周期自动清理。
 * @param opts.eventsFile 事件账本路径（自测注入用；缺省与 loop-guard 同一份）。
 * @returns disposer（额外清理内存态；ctx.on 自带者由运行时管理）。
 */
export declare function installSpinGuard(ctx: SpinGuardContext, cfg: SpinGuardConfig, opts?: {
    eventsFile?: string;
}): () => void;
