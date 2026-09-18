# dsh-glm-mode

![banner](assets/banner.png)

「GLM 模式」：为 zhipuai/glm-5.3-flash 调优的 DSH 编码 Agent 预设——装上即得 PTC 程序化工具调用、GLM 专属自动压缩，外加**思考死循环守卫**与**工具空转守卫**双层防护。

[**English**](README.en.md) · [Releases](https://github.com/hoyyang/dsh-glm-mode/releases) · [更新日志](CHANGELOG.md)

<p align="center">
  <a href="https://github.com/hoyyang/dsh-glm-mode/releases"><img src="https://img.shields.io/github/v/release/hoyyang/dsh-glm-mode" alt="release"></a>
  <img src="https://img.shields.io/badge/dsh-plugin-blue" alt="dsh plugin">
  <img src="https://img.shields.io/github/license/hoyyang/dsh-glm-mode" alt="license">
</p>

## 安装

```bash
dsh plugin add dsh-glm-mode
```

（npm 包名独享；也可用 GitHub 源：`dsh plugin add hoyyang/dsh-glm-mode`）

零配置可用（全部开关默认开启）。新会话在预设选择器里选「**GLM 模式**」，模型选 `zhipuai/glm-5.3-flash` 即可。

## 有啥用

- **PTC 程序化工具调用**：全量工具目录以 Code Mode 呈现，一个 TypeScript 程序组合多步操作，减少往返轮次与 input token（同条件 A/B 实测 input −15%）。
- **思考死循环守卫**：GLM-5.3-flash 在高推理档位下有 long-decode 退化缺陷（vLLM #56868 同款报告）——实测曾出现单步纯思考 131,072 token、同一句循环约 2,500 次、29.5 分钟烧满上限。守卫对流做句子级重复检测，**提前截断并复用「输出 token 上限」链路**，发「继续」即续跑。
- **工具空转守卫**：PTC 模式下模型可能幻觉出「顶层 write 工具」并连发占位调用（实测事故连发 37 次、最长连续 23 步空转）。守卫识别空转后经官方通道注入一条纠偏消息，把模型拉回正轨——**事后纠偏、不截断正常流**。
- **GLM 专属自动压缩**：1M 上下文按 75% 阈值 / 22% 保留自动压缩，压缩后原地摘要无缝续跑；未选 GLM 预设的 GLM 会话也有溢出级兜底。
- **原生多模态**：预设声明 text+image 输入，截图直接看。

## 30 秒上手

1. `dsh plugin add dsh-glm-mode`
2. 重启 DSH（或热重载）
3. 新会话 → 预设选「GLM 模式」
4. 模型选 `zhipuai/glm-5.3-flash`
5. 正常干活——守卫在后台静默工作，无需任何操作

## 进阶用法

全部配置项（`cordis.patch.yml`，默认即推荐值）：

| 键 | 默认 | 说明 |
|---|---|---|
| compactEnabled | true | 自动压缩开关（false 保留手动 /compact） |
| glmThresholdRatio | 0.75 | GLM 会话压缩阈值 |
| glmRetainRatio | 0.22 | 压缩后保留占比 |
| otherThresholdRatio | 0.98 | 非 GLM 模型兜底阈值 |
| glmPresetEnabled | true | 随插件安装/卸载 GLM 模式预设 |
| loopGuardEnabled | true | 思考死循环守卫开关 |
| loopGuardRepeatThreshold | 8 | 同一句子连续重复 N 次即判定死循环 |
| loopGuardMinSentenceChars | 48 | 参与比对的句子最小长度（字符） |
| loopGuardMinReasoningChars | 2000 | 累计 reasoning 字符达到后才武装判定 |
| spinGuardEnabled | true | 工具空转守卫开关 |
| spinGuardStreakThreshold | 5 | 连续占位 run_code 达 N 次即注入纠偏 |
| spinGuardMaxCodeChars | 200 | 占位判定的 code 长度上限（≥ 视为有实质内容） |
| spinGuardWindowMs | 900000 | 距最近占位超过该毫秒数视为断流（不干预） |

守卫触发对账：`~/.dsh/dsh-glm-mode/guard-events.jsonl`（JSONL 只增流水，`kind` 字段区分 `reasoning-loop` / `tool-spin`）。

## 工作原理

- **呈现层**：`agent-presentation mode: ptc` 把全量工具目录收进一个 `run_code` 工具，模型写 TypeScript 程序、运行时桥接调用真实工具。
- **思考守卫**：`llm/stream` 瀑布包装 chunk 流（仅 zhipuai glm-* 路由），reasoning 增量做数字归一化的句子重复比对，触发即合成 `finish{max-tokens}` 并硬取消上游请求。
- **空转守卫**：`llm/stream` 检测每步工具调用（占位 = run_code 且无 `tools.*` 实质引用且 code 短）；达阈值后经 `agent/pre-step` 官方决策通道向消息尾部注入一条纠偏 user 消息——尾部追加不动请求前缀，前缀缓存仅失配增量。
- **压缩**：预设内自带隔离压缩 owner（官方 "nearest owner wins" 语义），与 dsh-kiro 等宿主引擎确定性共存。

## 可靠性与验收

- 合成流自测 **52/52**（`scripts/selftest-loop-guard.mjs`：截断语法合规、路由矩阵、武装阈值防误伤、fail-open、注入/清零/零感知矩阵、断流窗口、账本防线）
- 冷启动静态检测 boot-check [A]–[E] 全绿；卸载重装幂等（真卸→重装→预设目录恢复）
- headless 全新进程真模型冒烟通过；守卫对正常流零干扰
- 两守卫均 fail-open：内部错误放行原始流 + 显式日志，绝不弄挂流水线

## 常见问题

**只对 GLM 模型生效吗？** 是。两个守卫与压缩策略都按路由（zhipuai glm-*）判定，其他模型零感知零开销。

**会误伤正常回答吗？** 思考守卫有武装阈值（≥2000 reasoning 字符后才开始判定）与最小句长（≥48 字符）双重防误伤；空转守卫误判的代价仅是一条纠偏消息，不会截断任何流。

**和直接用 Kiro 模式有什么区别？** Kiro 模式面向 DeepSeek 系模型调优；本插件为 GLM-5.3-flash 提供专属预设（PTC + 1M 压缩阈值 0.75/0.22）与守卫家族，两者可共存，压缩 owner 按官方语义确定性让位。

**wire 层配置（thinking 格式 / tool_stream）在哪？** 部署于 settings.yaml 的 provider 路由层（z.ai 官方推荐格式），不在本插件内，装完即用。

## 本地构建

```bash
pnpm install
npm run build      # tsc 编译 + npm pack 产出 tgz
npm run selftest   # 52 项合成流自测
```

## 许可证

MIT —— 详见 [LICENSE](LICENSE)。
