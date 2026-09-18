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
import { ToolResultPruner } from '@deepseek-ai/dsh-compaction-tool-result-pruner';
import z from '@deepseek-ai/schemastery';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { defaultEventsFile, installLoopGuard } from './loop-guard.js';
import { defaultSpinEventsFile, installSpinGuard } from './spin-guard.js';
export { defaultEventsFile, installLoopGuard, isGlmRoute, ReasoningLoopDetector } from './loop-guard.js';
export { defaultSpinEventsFile, installSpinGuard, isPlaceholderRunCode } from './spin-guard.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
export const name = 'dsh-glm-mode';
export const inject = [];
export const Config = z.object({
    compactEnabled: z.boolean().default(true),
    glmThresholdRatio: z.number().min(0.3).max(0.95).default(0.75),
    glmRetainRatio: z.number().min(0.05).max(0.4).default(0.22),
    otherThresholdRatio: z.number().min(0.5).max(0.99).default(0.98),
    otherRetainRatio: z.number().min(0.01).max(0.2).default(0.05),
    glmPresetEnabled: z.boolean().default(true),
    loopGuardEnabled: z.boolean().default(true),
    loopGuardRepeatThreshold: z.number().min(3).max(100).default(8),
    loopGuardMinSentenceChars: z.number().min(8).max(500).default(48),
    loopGuardMinReasoningChars: z.number().min(200).max(100000).default(2000),
    spinGuardEnabled: z.boolean().default(true),
    spinGuardStreakThreshold: z.number().min(2).max(50).default(5),
    spinGuardMaxCodeChars: z.number().min(50).max(2000).default(200),
    spinGuardWindowMs: z.number().min(60000).max(3600000).default(900000),
});
/**
 * Host fallback engine，语义同 dsh-kiro 的 KiroCompactionEngine：当会话所属
 * preset 发布了自己的隔离压缩 owner（如「GLM 模式」预设内置的压缩组），
 * 最近的 owner 胜出，本兜底引擎退位为 no-op，避免双引擎阈值/重试预算冲突。
 */
export class GlmCompactionEngine extends BasicCompactionEngine {
    compactIfNeeded(agent, trigger, signal) {
        const ctxLike = this.ctx;
        const presets = ctxLike.get('agentPresets');
        const presetOwner = presets?.serviceFor(agent, 'compaction');
        if (presetOwner !== undefined && presetOwner !== this)
            return Promise.resolve(null);
        return super.compactIfNeeded(agent, trigger, signal);
    }
}
/**
 * 本插件是否仍列在任一 profile 的装配清单里（bundles 或 dependencies）。
 *
 * 卸载清理只在「确属卸载」时才删预设（见 apply 里的时序陷阱注释），判定依据就是
 * 这份清单：重装配时清单里仍然有 dsh-glm，真卸载时它已被原子移除。读不到 profiles
 * 目录时按「仍安装」处理——宁可留下一个预设目录，也不能把用户的「GLM 模式」删掉。
 * @param dshHome - harness home（DSH_HOME 或 ~/.dsh）。
 * @returns true 表示清单里仍有本插件。
 */
function pluginStillInstalled(dshHome) {
    let profiles;
    try {
        profiles = readdirSync(join(dshHome, 'profiles'));
    }
    catch {
        return true;
    }
    for (const dir of profiles) {
        try {
            const pkg = JSON.parse(readFileSync(join(dshHome, 'profiles', dir, 'package.json'), 'utf8'));
            if ((pkg.dsh?.profile?.bundles ?? []).includes('dsh-glm-mode'))
                return true;
            if (pkg.dependencies !== undefined && Object.prototype.hasOwnProperty.call(pkg.dependencies, 'dsh-glm-mode'))
                return true;
        }
        catch { /* 跳过无法解析的 profile */ }
    }
    return false;
}
export function apply(ctx, config) {
    // ── GLM 思考死循环守卫（v0.3.0，llm/stream 包装层）──────────────────────
    // 活体事故：glm-5.3-flash reasoningEffort=max 下单步纯思考 131072 token 死循环
    // （约 2500 次同句重复，29.5 分钟），打满 maxTokens 才被掐断。守卫在 reasoning
    // 增量上做句子级连续重复检测，提前合成 finish{max-tokens}——复用既有
    // 「输出 token 上限」UI 链路。非 GLM 路由零感知；wire/压缩/persona 不动。
    if (config.loopGuardEnabled) {
        try {
            installLoopGuard(ctx, config);
            ctx.logger?.info?.('[dsh-glm] 思考死循环守卫已挂载（llm/stream · zhipuai glm-* · 重复阈值 ' + config.loopGuardRepeatThreshold + ' 句 / 句长 ≥' + config.loopGuardMinSentenceChars + ' 字 / 武装 ≥' + config.loopGuardMinReasoningChars + ' 字符；触发记录 → ' + defaultEventsFile() + '）');
        }
        catch (error) {
            ctx.logger?.warn?.('[dsh-glm] 思考死循环守卫挂载失败（不影响压缩与预设，GLM 流将不受保护）: ' + String(error));
        }
    }
    // ── GLM 工具空转守卫（v0.4.0，llm/stream 检测 + agent/pre-step 干预）──────
    // 活体事故：PTC 呈现下模型幻觉「顶层 write 工具」，连发 37 次占位 run_code
    // （最长连续 23 步 marker 空转）。守卫在 llm/stream 上累计每会话占位 streak，
    // 达阈值后经 agent/pre-step 官方决策通道向前一步的消息尾部注入纠偏 user
    // 消息（顶层无 write / 大文本走 heredoc / 认真构造 run_code），注入一次即清
    // 零。尾部追加不动前缀缓存；非 GLM 路由与一次性请求（无 sessionId）零感知。
    if (config.spinGuardEnabled) {
        try {
            const disposeSpin = installSpinGuard(ctx, config);
            ctx.effect(() => disposeSpin, 'dsh-glm: spin-guard session state');
            ctx.logger?.info?.('[dsh-glm] 工具空转守卫已挂载（llm/stream 检测 · agent/pre-step 干预 · 连续占位 ≥' + config.spinGuardStreakThreshold + ' 次 / code <' + config.spinGuardMaxCodeChars + ' 字 / 断流窗口 ' + Math.round(config.spinGuardWindowMs / 60000) + ' 分钟；触发记录 kind=tool-spin → ' + defaultSpinEventsFile() + '）');
        }
        catch (error) {
            ctx.logger?.warn?.('[dsh-glm] 工具空转守卫挂载失败（不影响压缩/预设/思考守卫）: ' + String(error));
        }
    }
    // ──「GLM 模式」Agent 预设：随插件安装/卸载 ──────────────────────────────
    if (config.glmPresetEnabled) {
        try {
            const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'presets', 'glm');
            const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
            const dst = join(dshHome, '.agent-presets', 'glm');
            const stampFile = join(dshHome, 'dsh-glm-mode', 'preset-install.json');
            cpSync(src, dst, { recursive: true, force: true });
            try {
                mkdirSync(dirname(stampFile), { recursive: true });
                writeFileSync(stampFile, JSON.stringify({ installedAt: Date.now(), dst }, null, 2));
            }
            catch { /* 时间戳只是卸载判定的依据之一，写不进不影响安装 */ }
            // 卸载清理的时序陷阱（2026-09-14 实测事故：profile 补丁事务重应用后「GLM 模式」
            // 从预设选择器消失，而插件仍是 active）。事务性重应用是「新代先 apply、旧代后
            // dispose」，旧代在这里立即 rmSync 会把新代刚 cpSync 好的预设删掉。因此延迟一拍
            // 再二次校验，只有确属卸载才删除：
            //   ① 时间戳显示已有一代重新安装（installedAt 晚于本代 dispose 时刻）→ 保留；
            //   ② profile 装配清单里仍有 dsh-glm（= 重装配而不是卸载）→ 保留。
            ctx.effect(() => () => {
                const disposedAt = Date.now();
                const timer = setTimeout(() => {
                    try {
                        const stamp = JSON.parse(readFileSync(stampFile, 'utf8'));
                        if (typeof stamp.installedAt === 'number' && stamp.installedAt > disposedAt)
                            return;
                        if (pluginStillInstalled(dshHome))
                            return;
                        rmSync(dst, { recursive: true, force: true });
                    }
                    catch { /* 卸载清理尽力而为 */ }
                }, 1500);
                if (typeof timer.unref === 'function')
                    timer.unref();
            }, 'dsh-glm: remove preset on dispose');
            ctx.logger?.info?.('[dsh-glm]「GLM 模式」预设已安装（会话预设选择器里可选，推荐搭配 zhipuai/glm-5.3-flash）');
        }
        catch (error) {
            ctx.logger?.warn?.('[dsh-glm] GLM 预设安装失败（不影响压缩兜底）: ' + String(error));
        }
    }
    // ── 压缩兜底引擎（仅 host 槽位空闲时挂载）────────────────────────────────
    // 与 dsh-kiro 相同的共存纪律：已有 host owner 则保留它。「GLM 模式」预设
    // 自带隔离 owner，不依赖这里的兜底；此引擎服务于「没选 GLM 预设的 GLM 会话」。
    if (config.compactEnabled && ctx.get('toolResultPruner') === undefined) {
        try {
            ctx.plugin(ToolResultPruner);
        }
        catch (error) {
            ctx.logger?.warn?.('[dsh-glm] tool-result-pruner 启用失败，压缩仍会继续但不会预先修剪大型工具结果: ' + String(error));
        }
    }
    // dsh-smart-compact 优先让位：profile 装了它（bundles 在案）即把压缩槽交给
    // 它的 rollover 引擎（无损换窗），本插件的摘要兜底退出——零配置默认优先。
    let smartCompactInstalled = false;
    try {
        const dshHomeBase = process.env.DSH_HOME || join(homedir(), '.dsh');
        const profilesDir = join(dshHomeBase, 'profiles');
        for (const dir of readdirSync(profilesDir)) {
            try {
                const pkg = JSON.parse(readFileSync(join(profilesDir, dir, 'package.json'), 'utf8'));
                if ((pkg.dsh?.profile?.bundles ?? []).includes('@dsh-external/dsh-smart-compact')) {
                    smartCompactInstalled = true;
                    break;
                }
            }
            catch { /* 跳过无法解析的 profile */ }
        }
    }
    catch { /* 检测失败按未安装处理 */ }
    if (smartCompactInstalled) {
        ctx.logger?.info?.('[dsh-glm] 检测到 @dsh-external/dsh-smart-compact 已安装——压缩槽让位给其 rollover 引擎（无损换窗），本插件摘要兜底退出');
    }
    else if (ctx.get('compaction') !== undefined) {
        ctx.logger?.info?.('[dsh-glm] host 压缩 owner 已存在（如 dsh-kiro）；不重复挂载——GLM 会话由「GLM 模式」预设内置压缩组覆盖');
    }
    else {
        try {
            ctx.plugin(GlmCompactionEngine, {
                auto: config.compactEnabled,
                thresholdRatio: config.otherThresholdRatio,
                retainRatio: config.otherRetainRatio,
                summarizationProvider: '',
                summarizationModel: '',
                maxTokens: 8192,
                compactionRetries: 1,
                maxOverflowRetries: 1,
                modelPolicies: [
                    {
                        provider: 'zhipuai',
                        model: 'zhipuai/glm-5.3-flash',
                        thresholdRatio: config.glmThresholdRatio,
                        retainRatio: config.glmRetainRatio,
                    },
                ],
            });
            ctx.logger?.info?.('[dsh-glm] GLM 兜底压缩已挂载（GLM 阈值 ' + Math.round(config.glmThresholdRatio * 100) + '% / 保留 ' + Math.round(config.glmRetainRatio * 100) + '%，其它模型 ' + Math.round(config.otherThresholdRatio * 100) + '% 溢出级兜底）');
        }
        catch (error) {
            ctx.logger?.warn?.('[dsh-glm] 兜底压缩引擎挂载失败（GLM 模式预设内置压缩组不受影响）: ' + String(error));
        }
    }
}
//# sourceMappingURL=index.js.map