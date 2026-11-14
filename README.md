# dsh-cost-meter

> npm 包名：`@beckchiang/dsh-cost-meter`（`dsh-cost-meter` 已被他人占用）

**Input-dock session cost meter for DeepSeek Harness — every step is priced at the peak/off-peak rate that was actually in force when that request ran, so past amounts never get rewritten by a later time-of-day.** · **DeepSeek Harness 输入框下方的会话成本计：每一步都按它真正发生时的峰谷价计价，历史金额不会被后来的时段改写。**

<p align="center">
  <img src="./icon.svg" width="96" alt="dsh-cost-meter icon">
</p>

- 常驻读数：输入框下方一行「累计 ¥x · 本轮 ¥y」，点开是完整面板。
- 按步计价：金额来自会话事件流里每一步的 `usage` 与其请求开始时间，而不是「当前价 × 总 token」。
- 两条判据：**每步上下文**（换会话真正能省的东西）+ **会话累计成本**（钱包预算），任一越线即变色。
- 会告诉你**该不该交接**：按近 3 轮节奏预测再 10 轮要花多少，切新会话前 3 轮能省多少。

---

## 为什么需要「按步计价」

宿主给前端的 `tokenUsage` 投影只有**累计 token**，没有时间也没有单价。直接用「当前单价 × 累计 token」算钱，会得到两个必然的错误：

1. **跨峰谷就改写历史**：北京时间 12:00 或 18:00 一过，之前所有步骤的金额整体翻倍或减半；刷新页面也会变。
2. **切换模型就改写历史**：用 `deepseek-flash` 跑了两小时后切到 `deepseek-v4-pro`，前面两小时的金额会被按 Pro 的价格重算一遍。

真实账单不是这样算的：**每个请求按它发出那一刻的单价、它当时用的模型计价，然后相加**。本插件就是把这个账本做出来。

## 功能

### 1. 按步计价账本（历史冻结）

Host 半边读取会话自己的事件流，把每一步的 `usage`（未缓存输入 / 缓存命中 / 输出）配上「该步请求开始时间」与「该步模型」，用当时有效的峰谷价计价，逐轮聚合成账本。金额一旦算出就不再依赖「现在几点」。

### 2. 累计与拆分

- **累计成本**：整段会话按步求和，面板里字号最大。
- **成本构成**：一条三色堆叠条，整条长度 = 累计总成本（100%），按「缓存命中 / 非缓存输入 / 输出」三项成本占比切段；下方图例给出色点、名称、token 量、成本占比与金额。

### 3. 本轮 / 上一轮成本

按 turn 号聚合：本轮进行中显示当前 turn 的实时成本，空闲时显示上一个已完成 turn。附状态徽标与「距黄线/红线还差多少」。

### 4. 双判据与交接建议

见下文「判据与建议」。阈值用 token 与人民币绝对值，不受峰谷切换影响。

### 5. 峰谷时段提示

计时段框标明这是 **DeepSeek 官方价**：当前是高峰还是空闲、缓存命中单价（带 `/百万 tokens` 单位）、高峰窗口、空闲规则、距下一次切换的**时长 + 具体时刻**（如「距进入空闲 52 分钟（周三 12:00）」，周末会跳到「（周一 09:00）」），并注明人民币口径与「法定节假日未按高峰计」。

### 6. 趋势预测

四行「标签 + 数值」：每步上下文、每轮增长、再 10 轮成本、切会话首 3 轮。增长越快、上下文越重，越值得交接。

## 面板长什么样

```
┌ 累计 ─────────────────────────────┐
│                        ¥6.203      │  ← 主角，18px
├ DeepSeek 官方价 ───── ¥0.02/百万 tokens ┤
│ ● 当前高峰时段                      │
│ 高峰：工作日 9:00–12:00、14:00–18:00  │
│ 其余时段与周末按空闲价                │
│ 距进入空闲 52 分钟（周三 12:00）       │
│ 人民币；法定节假日未按高峰计           │
├ 成本构成 ─────────────────────────┤
│ ███████████  ██████  ███           │  ← 一条三色条
│ ● 缓存命中  12.4M  62%  ¥3.845      │
│ ● 非缓存输入 3.1M  21%  ¥1.302      │
│ ● 输出      0.4M  17%  ¥1.056      │
├ 本轮 ─────────────────────────────┤
│ 成本合计                    ¥0.412  │
│ 缓存命中               ¥0.201       │
│ 正常            距黄线：每步 +175k   │
│ 每步上下文还宽裕，累计也没到黄线。     │
├ 趋势 ─────────────────────────────┤
│ 每步上下文              208.4k      │
│ 每轮增长                +4.3k       │
│ 再 10 轮成本            ¥4.37       │
│ 切会话首 3 轮            ¥0.13      │
├ 判据 ─────────────────────────────┤
│ 判据：会话累计 ¥3 黄、¥8 红          │
│ 判据：每步上下文 200k 黄、400k 红     │
│ 累计按每步当时价计，历史不漂移         │
└───────────────────────────────────┘
```

面板文案固定中文（不跟随界面语言），宽度 `min(340px, 100vw - 24px)`，六个分区统一为「描边框 + 小标题」容器。

## 计价口径

### 价格表（人民币 / 百万 tokens）

| 模型 | 时段 | 缓存命中 | 非缓存输入 | 输出 |
|---|---|---|---|---|
| `deepseek-flash` | 空闲 | ¥0.02 | ¥1 | ¥4 |
| `deepseek-flash` | 高峰 | ¥0.04 | ¥2 | ¥8 |
| `deepseek-v4-pro` | 空闲 | ¥0.15 | ¥4.5 | ¥13.5 |
| `deepseek-v4-pro` | 高峰 | ¥0.30 | ¥9 | ¥27 |

别名：`deepseek-v4-flash`、`deepseek-v4-flash-experimental` 归到 `deepseek-flash`。未收录的模型按 `deepseek-flash` 估价，并在面板里点名提示。

### 高峰时段

北京时间（`Asia/Shanghai`）**周一至周五 09:00–12:00、14:00–18:00**；其余时间与周末全天按空闲价。法定节假日未特殊处理（DeepSeek 官方可能有，本插件没有节假日表）。

### 每一步如何归价

1. `step/start` 记下 `"turn:step"` 的请求开始时间。
2. `request/context` 或 `request/header` 里出现的模型名更新「当前模型」。
3. `assistant/message` 带 `usage` 时，用该步的开始时间（缺失则退回事件时间）与当时的模型计价。
4. `cacheWriteTokens` 不计费（DeepSeek 不收缓存写入的钱）。

请求跨峰谷边界时，按**请求开始时刻**归段，不拆分。

### 缓存与失败退路

Host 路由用 `session.seq` 做 memo（最多 32 个会话）：seq 没变就直接复用上次的账本，避免每步重扫事件流。拿不到账本时（旧会话未打开、路由未加载、插件刚装还没重启），面板退回「当前价折算」并在判据区写明「累计暂按现价折算，跨时段会漂移」——只影响显示口径，不会写坏任何数据。

## 判据与建议

### 两条线（任一越线即变色）

| 指标 | 计算 | 黄 | 红 | 为什么用这个 |
|---|---|---|---|---|
| 每步上下文 | 近 3 轮 `(cacheRead + 非缓存输入) / 步数` 的中位数 | ≥ 200k token | ≥ 400k token | 换会话真正能省的是它；用 token 作阈值，与峰谷、单价都无关 |
| 会话累计成本 | 账本 `totals.cost` | ≥ ¥3 | ≥ ¥8 | 钱包的绝对预算，不受轮次长短影响 |

旧口径「本轮缓存命中金额 ¥0.1 / ¥0.3」只在**拿不到账本**时作为退路，因为它等于「上下文 × 步数 × 单价」，会把步数也乘进去——160 步 × 90k 的会话会被误判成很重。

### 读数怎么用

- **每步上下文**：这是每轮真正吃进去的量。200k 以上开始注意，400k 以上基本该换会话了。
- **每轮增长**：上下文每轮涨多少。`+4k/轮` 属于正常沉淀；`+20k/轮` 说明每轮在往上下文里塞大东西。
- **再 10 轮成本**：按近 3 轮节奏外推，判断「这个会话还能不能继续跑」。
- **切会话首 3 轮**：切新会话后前 3 轮的预估花费（按每步约 2 万 token 估算），和「再 10 轮成本」对比就知道交接划不划算。当前每步上下文 ≤ 40k 时不显示——那时切会话省不了多少。

### 什么时候该交接

1. 每步上下文进红（≥ 400k），或累计进红（≥ ¥8）——面板会直接写「上下文与累计都超红线，该交接」。
2. 每轮增长进琥珀（≥ 1k/轮）且「再 10 轮成本」明显高于「切会话首 3 轮」——早切更省。
3. 只是累计进黄（¥3）但每步上下文还很轻：会话本身健康，不用急着切。

## 安装

### 本机目录（开发/自用，推荐）

把仓库放到任意目录，然后在 DSH 里用 `plugin_manager` 的 `install_bundle` 指向**该目录的绝对路径**（插件市场 → 安装本地包，或让 agent 执行）。它会写 profile 的依赖与 bundle 列表，装完即生效并跨重启保留。

### npm（发布后）

```bash
plugin_manager install_bundle @beckchiang/dsh-cost-meter
# 或：npm i -g @beckchiang/dsh-cost-meter 后指向全局目录
```

### 跨机 zip

解压后同样是 `install_bundle <解压目录>`。包内附带 `test/smoke.mjs`，装完可以在目标机自检：

```bash
node test/smoke.mjs
```

### 从源码

```bash
git clone https://github.com/BeckChiang/dsh-cost-meter.git
cd dsh-cost-meter
node test/smoke.mjs
```

## 工作原理

### Host 半边（`index.js` + `lib/ledger.mjs`）

- 注册 `GET /api/cost-meter/ledger?id=<sessionId>`，要求请求头 `x-cost-meter: 1`（同源防误触）。
- `ctx.sessions.get(id)` 拿活会话；会话 id 形如 `session-<uuid>`，裸 uuid 与带前缀两种写法都接受。
- `session.snapshotEvents()` 取事件流 → `buildLedger(events)` 逐事件计价 → 返回 `steps / totals / turns / currentTurn / lastAssistantTurn / inFlightTurn / models / unknownModels / hasPricedSteps`。
- 按 `session.seq` memo，seq 未变直接复用；只读，从不改写会话或事件。

### Client 半边（`client.js`）

- 注册到 `conversation.composer.dock`（输入框下方），React 组件，主题 token 取色。
- 依赖变化后 400ms 防抖再拉账本，并把当时的 `running` 状态一起记住：账本与当前运行状态对不上时，**累计仍用账本**（历史永远精确），只有「本轮」退回本地增量。
- 语言命名空间 `cost-meter`（`zh-CN` / `en` 两套字典都保留），面板显示固定中文。

## 自定义

| 想改什么 | 改哪里 |
|---|---|
| 价格表 / 时段 / 模型别名 | `lib/ledger.mjs` 顶部的 `PRICES`、`ALIAS`、`FALLBACK_MODEL` |
| 判据阈值 | `client.js` 顶部 `WARN_CTX_TOKENS`、`RED_CTX_TOKENS`、`WARN_SESSION_YUAN`、`RED_SESSION_YUAN` |
| 预测假设（每步 2 万、再 10 轮） | `client.js` 的 `FRESH_CTX_TOKENS`、`PREDICT_TURNS` |
| 面板宽度 | `client.js` 面板容器 `width: min(340px, calc(100vw - 24px))` |

改 Host 半边（`index.js` / `lib/ledger.mjs`）需要重启 DSH 才加载；改 `client.js` 刷新页面即可。

## 测试

```bash
node test/smoke.mjs
```

最小 React 替身驱动真实组件：断言面板六个分区、堆叠条三段宽度合计 100%、颜色互异、图例含 token 与占比、判据与预测文案、徽标与颜色分级、账本缺席时的退路文案。当前 44 条断言全部通过。

## 已知限制

- **只覆盖当前打开的会话**：`ctx.sessions.get()` 只对 live 会话有效，历史会话在面板里走「当前价折算」退路。
- **fork 的会话会重复计入种子事件**：与宿主 `tokenUsage` 投影口径一致，暂不特殊处理。
- **价格需手动更新**：DeepSeek 调价后要改 `lib/ledger.mjs`。
- **法定节假日未处理**：官方可能整段按空闲价，本插件只看星期与钟点。
- **未收录模型按 flash 估价**：面板会点名，但金额只是估计。

## 兼容性

- 需要 Host 侧 `webServer` 与 `sessions` 服务（`ctx.sessions.get` / `session.snapshotEvents`），Client 侧需要 `conversation.composer.dock` 插槽与 `locale` 服务。
- 2.0.0 与 1.3.x 完全兼容，可以覆盖升级。

## 变更历史

见 [CHANGELOG.md](./CHANGELOG.md)。

## 许可

[MIT](./LICENSE) © 2026 BeckChiang
