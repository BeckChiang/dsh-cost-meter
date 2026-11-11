/**
 * 按 step 计价的账本内核（Host 侧，纯函数）。
 *
 * 问题：计价插件早期版本拿「当前时刻」的峰谷价去乘整个会话的累计 token，
 * 于是一跨 12:00 / 18:00（或只刷新页面），历史累计金额就整体改写，与真实账单不符。
 *
 * 这里改成：每个 step 用它**请求发生时**的时间戳与所用模型单独计价，再求和。
 * 结论只依赖事件本身，与「现在几点」无关，所以历史一次定稿、永不漂移。
 *
 * 计价口径：
 *   - 时间取该 step 的 `step/start`（请求开始），缺失时退回 `assistant/message` 的 time。
 *   - 模型取该 step 之前最近一次 `request/context` / `request/header` 声明的模型。
 *   - 只计 input / output / cacheRead 三项；cacheWrite 在 DeepSeek 定价里不额外收费。
 *
 * 价格来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 * 单位 CNY / 百万 tokens，空闲价为高峰价的一半；
 * 高峰 = 北京时间周一至周五 9:00–12:00、14:00–18:00（法定节假日未单独处理）。
 */

export const PRICES = {
  'deepseek-flash': {
    off: { cacheRead: 0.02, input: 1, output: 4 },
    peak: { cacheRead: 0.04, input: 2, output: 8 },
  },
  'deepseek-v4-pro': {
    off: { cacheRead: 0.15, input: 4.5, output: 13.5 },
    peak: { cacheRead: 0.30, input: 9, output: 27 },
  },
}

export const ALIAS = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
}

export const FALLBACK_MODEL = 'deepseek-flash'

export function beijingPeak(date) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai',
      hour12: false,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(date)
    const f = {}
    for (const p of parts) f[p.type] = p.value
    if (f.weekday === 'Sat' || f.weekday === 'Sun') return false
    const mins = (Number(f.hour) % 24) * 60 + Number(f.minute)
    return (mins >= 540 && mins < 720) || (mins >= 840 && mins < 1080)
  } catch (_) {
    return false
  }
}

/** 某模型在某时刻的单价；未知模型标记 known=false，仍按 fallback 估算。 */
export function rateFor(modelName, date) {
  const key = ALIAS[modelName] || modelName
  const known = Object.prototype.hasOwnProperty.call(PRICES, key)
  const entry = PRICES[key] || PRICES[FALLBACK_MODEL]
  const peak = beijingPeak(date)
  return { ...(peak ? entry.peak : entry.off), peak, known }
}

const PER_MILLION = 1e6
const cost3 = (tokens, unit) => (tokens / PER_MILLION) * unit

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * 单个 step 的用量计价。
 * @param {{cacheReadTokens?:number,inputTokens?:number,outputTokens?:number}} usage
 */
export function priceUsage(usage, modelName, at) {
  const cache = num(usage && usage.cacheReadTokens)
  const input = num(usage && usage.inputTokens)
  const output = num(usage && usage.outputTokens)
  const rate = rateFor(modelName, at)
  const cacheCost = cost3(cache, rate.cacheRead)
  const inputCost = cost3(input, rate.input)
  const outputCost = cost3(output, rate.output)
  return {
    cache,
    input,
    output,
    cacheCost,
    inputCost,
    outputCost,
    cost: cacheCost + inputCost + outputCost,
    peak: rate.peak,
    known: rate.known,
  }
}

function modelOf(event) {
  const data = event && event.data
  if (!data) return null
  if (event.type === 'request/context' && typeof data.model === 'string' && data.model) return data.model
  if (event.type === 'request/header') {
    const header = data.header || {}
    const config = header.config || {}
    if (typeof config.model === 'string' && config.model) return config.model
  }
  return null
}

function emptyTurn(turn) {
  return {
    turn,
    cost: 0,
    cacheCost: 0,
    inputCost: 0,
    outputCost: 0,
    cache: 0,
    input: 0,
    output: 0,
    steps: 0,
  }
}

function addStep(bucket, step) {
  bucket.cost += step.cost
  bucket.cacheCost += step.cacheCost
  bucket.inputCost += step.inputCost
  bucket.outputCost += step.outputCost
  bucket.cache += step.cache
  bucket.input += step.input
  bucket.output += step.output
  bucket.steps += 1
}

/**
 * 把会话事件流折叠成账本。
 *
 * @param {readonly {type:string,seq:number,time:number,data?:any}[]} events
 * @returns {{
 *   steps: number,
 *   totals: {cost:number,cacheCost:number,inputCost:number,outputCost:number,cache:number,input:number,output:number,steps:number},
 *   turns: Record<string, object>,
 *   currentTurn: number|null,
 *   lastAssistantTurn: number|null,
 *   inFlightTurn: number|null,
 *   models: Record<string, number>,
 *   unknownModels: string[],
 *   firstStepAt: string|null,
 *   lastStepAt: string|null,
 *   hasPricedSteps: boolean,
 * }}
 */
export function buildLedger(events) {
  const list = Array.isArray(events) ? events : []
  const stepStart = new Map()
  const pending = new Map()
  const turns = new Map()
  const totals = {
    cost: 0, cacheCost: 0, inputCost: 0, outputCost: 0,
    cache: 0, input: 0, output: 0, steps: 0,
  }
  const models = {}
  const unknown = new Set()
  let model = null
  let currentTurn = null
  let lastAssistantTurn = null
  let steps = 0
  let firstStepAt = null
  let lastStepAt = null

  for (const event of list) {
    if (!event || !event.data) continue
    const data = event.data

    if (event.type === 'turn/start') {
      const turnNo = Number(data.turn)
      if (Number.isFinite(turnNo)) currentTurn = turnNo
      continue
    }

    const declared = modelOf(event)
    if (declared) {
      model = declared
      continue
    }

    if (event.type === 'step/start') {
      const turnNo = Number(data.turn)
      const stepNo = Number(data.step)
      if (Number.isFinite(turnNo) && Number.isFinite(stepNo)) {
        stepStart.set(`${turnNo}:${stepNo}`, Number(event.time) || 0)
        pending.set(`${turnNo}:${stepNo}`, { turn: turnNo, step: stepNo })
      }
      continue
    }

    if (event.type !== 'assistant/message') continue
    const usage = data.usage
    if (!usage) continue

    const turnNo = Number(data.turn)
    const stepNo = Number(data.step)
    if (!Number.isFinite(turnNo) || !Number.isFinite(stepNo)) continue

    // 请求开始时间才是这次调用被计费的时刻；缺失时退回消息时间。
    const at = stepStart.get(`${turnNo}:${stepNo}`) || Number(event.time) || 0
    pending.delete(`${turnNo}:${stepNo}`)
    const priced = priceUsage(usage, model, new Date(at || Date.now()))

    const bucket = turns.get(turnNo) || emptyTurn(turnNo)
    addStep(bucket, priced)
    turns.set(turnNo, bucket)

    addStep(totals, priced)
    steps += 1
    lastAssistantTurn = turnNo
    const iso = at ? new Date(at).toISOString() : null
    firstStepAt = firstStepAt || iso
    lastStepAt = iso

    const label = model || '(unknown)'
    models[label] = (models[label] || 0) + 1
    if (!priced.known) unknown.add(label)
  }

  const turnObject = {}
  for (const [key, value] of turns) turnObject[String(key)] = value

  // 还在跑的 step（有 step/start、没有 usage）：说明这一轮已经开始了。
  // 客户端据此把「本轮」指向真正在跑的那一轮，而不是上一个已收尾的 turn。
  let inFlightTurn = null
  for (const item of pending.values()) inFlightTurn = item.turn

  return {
    steps,
    totals,
    turns: turnObject,
    // 没有 turn/start 事件（老会话、被截断的事件流）时，退化为最后一步所在的 turn。
    currentTurn: currentTurn === null ? lastAssistantTurn : currentTurn,
    lastAssistantTurn,
    inFlightTurn,
    models,
    unknownModels: [...unknown],
    firstStepAt,
    lastStepAt,
    hasPricedSteps: steps > 0,
  }
}
