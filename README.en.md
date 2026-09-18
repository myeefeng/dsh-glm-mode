# dsh-glm-mode

![banner](assets/banner.png)

The "GLM Mode" agent preset for DeepSeek Harness, tuned end-to-end for zhipuai/glm-5.3-flash — PTC programmatic tool calling, GLM-specific auto-compaction, plus a **reasoning loop guard** and a **tool spin guard** out of the box.

[**中文**](README.md) · [Releases](https://github.com/hoyyang/dsh-glm-mode/releases) · [Changelog](CHANGELOG.md)

<p align="center">
  <a href="https://github.com/hoyyang/dsh-glm-mode/releases"><img src="https://img.shields.io/github/v/release/hoyyang/dsh-glm-mode" alt="release"></a>
  <img src="https://img.shields.io/badge/dsh-plugin-blue" alt="dsh plugin">
  <img src="https://img.shields.io/github/license/hoyyang/dsh-glm-mode" alt="license">
</p>

## Install

```bash
dsh plugin add hoyyang/dsh-glm-mode
```

Zero config required (every switch defaults to on). In a new session pick the "**GLM Mode**" agent preset and the `zhipuai/glm-5.3-flash` model.

## Why it helps

- **PTC tool calling**: the full tool catalog is presented as one Code Mode tool — the model composes multi-step TypeScript programs instead of per-call JSON round trips (A/B measured −15% input tokens at equal task).
- **Reasoning loop guard**: glm-5.3-flash degenerates on long decode at high reasoning effort (same defect as vLLM #56868) — observed live: 131,072 tokens of pure reasoning, one sentence repeated ~2,500 times, 29.5 minutes burned into the maxTokens ceiling. The guard watches the stream for sentence-level repetition and **truncates early, reusing the existing "output token limit" flow** — reply "continue" to resume.
- **Tool spin guard**: in PTC mode the model can hallucinate a "top-level write tool" and emit placeholder calls (one live incident: 37 in a row, 23 consecutive steps of no-ops). The guard detects the stall and injects one corrective message through the official channel to put the model back on track — **corrective, never truncating a healthy stream**.
- **GLM-specific auto-compaction**: the 1M context auto-compacts at 75% threshold / 22% retention, swapping history for an in-place summary; sessions that skip the preset still get an overflow-level fallback.
- **Native multimodal**: the preset declares text+image input — attach screenshots directly.

## 30-second start

1. `dsh plugin add hoyyang/dsh-glm-mode`
2. Restart DSH (or hot-reload)
3. New session → agent preset "**GLM Mode**"
4. Model → `zhipuai/glm-5.3-flash`
5. Just work — both guards run silently in the background

## Advanced

All knobs (in `cordis.patch.yml`; defaults are the recommended values):

| Key | Default | What it does |
|---|---|---|
| compactEnabled | true | Auto-compaction switch (false keeps manual /compact) |
| glmThresholdRatio | 0.75 | GLM session compaction threshold |
| glmRetainRatio | 0.22 | Retention ratio after compaction |
| otherThresholdRatio | 0.98 | Fallback threshold for non-GLM models |
| glmPresetEnabled | true | Install/remove the preset with the plugin |
| loopGuardEnabled | true | Reasoning loop guard switch |
| loopGuardRepeatThreshold | 8 | Consecutive sentence repeats that count as a loop |
| loopGuardMinSentenceChars | 48 | Minimum sentence length to compare (chars) |
| loopGuardMinReasoningChars | 2000 | Reasoning chars accumulated before arming |
| spinGuardEnabled | true | Tool spin guard switch |
| spinGuardStreakThreshold | 5 | Consecutive placeholder run_code calls before intervention |
| spinGuardMaxCodeChars | 200 | Code length cap for the placeholder test (≥ counts as real work) |
| spinGuardWindowMs | 900000 | Streak resets if the last placeholder is older than this |

Guard audit ledger: `~/.dsh/dsh-glm-mode/guard-events.jsonl` (append-only JSONL; the `kind` field separates `reasoning-loop` from `tool-spin`).

## How it works

- **Presentation**: `agent-presentation mode: ptc` folds the whole catalog into a single `run_code` tool; the model writes TypeScript and the runtime bridges `tools.*` calls.
- **Reasoning guard**: an `llm/stream` waterfall wraps the chunk stream (zhipuai glm-* routes only), feeding reasoning deltas into a digit-normalized sentence repeater; on trigger it synthesizes `finish{max-tokens}` and hard-cancels the upstream request.
- **Spin guard**: `llm/stream` inspects each step's tool calls (placeholder = run_code with no real `tools.*` reference and short code); past the threshold, an `agent/pre-step` decision rewrite appends one corrective user message — a tail append that never touches the request prefix cache.
- **Compaction**: the preset ships its own isolated compaction owner (official "nearest owner wins" semantics) that coexists deterministically with host engines such as dsh-kiro.

## Reliability & acceptance

- Synthetic self-test **52/52** (`scripts/selftest-loop-guard.mjs`: truncation grammar compliance, route matrix, arming thresholds, fail-open, inject/reset/zero-awareness matrix, stall window, ledger safety)
- Cold-start static checks (boot-check [A]–[E]) all green; uninstall/reinstall idempotency verified (real uninstall → reinstall → preset dir restored)
- Headless fresh-process live smoke test on the real model passed; guards stay silent on healthy streams
- Both guards fail open: internal errors release the original stream with a loud log — they never take the pipeline down

## FAQ

**Does it only affect GLM models?** Yes. Both guards and the compaction policy gate on the route (zhipuai glm-*); every other model is untouched.

**Will it break normal answers?** The reasoning guard arms only after 2,000 reasoning chars and ignores sentences under 48 chars; a spin-guard false positive costs one corrective message and never truncates anything.

**How is this different from the built-in Kiro mode?** Kiro mode is tuned for DeepSeek-family models. This plugin gives glm-5.3-flash its own preset (PTC + 1M compaction at 0.75/0.22) and the guard family. Both can coexist — compaction ownership yields deterministically per official semantics.

**Where do the wire settings (thinking format / tool_stream) live?** In your settings.yaml provider route (the officially recommended z.ai format), not inside this plugin — install and go.

## Build locally

```bash
pnpm install
npm run build      # tsc compile + npm pack
npm run selftest   # 52 synthetic self-test checks
```

## License

MIT — see [LICENSE](LICENSE).
