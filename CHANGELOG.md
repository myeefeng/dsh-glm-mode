# 更新日志 / Changelog

本项目的所有重要变更都记录在这里。格式参考 Keep a Changelog。

## [0.4.0] - 2026-09-18

### 新增
- **工具空转守卫（ToolSpinGuard）**：检测 PTC 会话中连续占位的 run_code 调用（无 tools.* 实质引用的短代码），达阈值后经 agent/pre-step 官方决策通道注入一次纠偏消息（顶层无 write / 大文本走 heredoc / 认真构造调用），注入后清零。尾部追加不动请求前缀缓存；事件 kind=tool-spin 写入 guard-events.jsonl。
- 新增配置项：spinGuardEnabled / spinGuardStreakThreshold / spinGuardMaxCodeChars / spinGuardWindowMs（默认 5 次 / 200 字符 / 15 分钟）。
- 自测扩展到 52 项（新增注入、清零、零感知、断流窗口、判定矩阵、fail-open、账本防线十组用例）。

## [0.3.0] - 2026-09-16

### 新增
- **思考死循环守卫（StreamLoopGuard）**：经 llm/stream 瀑布包装 chunk 流（仅 zhipuai glm-* 路由），reasoning 句子级重复检测（≥8 次连续 + 句长 ≥48 字符 + 武装阈值 2000 字符，数字归一化防漂移漏检），触发合成 finish{max-tokens}（复用「输出 token 上限」UI 链路）并硬取消上游请求。
- 守卫触发账本 ~/.dsh/dsh-glm/guard-events.jsonl（JSONL 只增流水）。
- 自测 28 项（合成流：截断语法合规、路由矩阵、防误伤、fail-open、消费者中断、signal 桥接、账本落盘）。

## [0.2.0] - 2026-09-08

### 变更
- 预设工具形态定为 PTC（Code Mode），tool-presentation mode: ptc；同条件 A/B 对比 PTC 减少轮次、input −15%。

## [0.1.0] - 2026-09-08

### 新增
- 「GLM 模式」Agent 预设（随插件安装/卸载）：PTC 呈现、GLM 专属自动压缩（0.75/0.22）、原生多模态声明。
- GLM 兜底压缩引擎（host 压缩槽空闲时挂载，官方 "nearest owner wins" 共存语义）。
