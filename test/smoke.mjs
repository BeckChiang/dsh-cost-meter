// cost-meter 面板冒烟：用最小 React 替身渲染 dock 组件，检查文案层次与峰谷提示。
// 用法：node test/smoke.mjs（需 node 20+，无第三方依赖）
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(resolve(here, '../client.js'), 'utf8')

let failed = 0
function check(name, ok, extra) {
  if (ok) console.log(`  ok   ${name}`)
  else { failed++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`) }
}

// ---- 最小 React 替身 -------------------------------------------------------
let hookState = []
let hookIdx = 0
let pending = []
let dirty = false
const h = (tag, props, ...kids) => ({
  tag,
  key: props && props.key,
  props: { ...(props || {}), children: kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false) },
})
const React = {
  createElement: h,
  useState: (init) => {
    const i = hookIdx++
    if (!(i in hookState)) hookState[i] = typeof init === 'function' ? init() : init
    const set = (v) => {
      const next = typeof v === 'function' ? v(hookState[i]) : v
      if (!Object.is(next, hookState[i])) { hookState[i] = next; dirty = true }
    }
    return [hookState[i], set]
  },
  useRef: (init) => {
    const i = hookIdx++
    if (!(i in hookState)) hookState[i] = { current: init }
    return hookState[i]
  },
  useEffect: (fn, deps) => scheduleEffect(fn, deps),
  useLayoutEffect: (fn, deps) => scheduleEffect(fn, deps),
}

// 按 hook 序号记住上一次的依赖数组，依赖没变就不重跑（否则 setLedger 每轮都换新对象，无限重渲染）。
const effectSlots = []
function depsEqual(a, b) {
  if (!a || !b) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false
  return true
}
function scheduleEffect(fn, deps) {
  const i = hookIdx++
  const slot = effectSlots[i]
  if (slot && depsEqual(slot.deps, deps)) return
  effectSlots[i] = { deps: deps ? deps.slice() : null }
  pending.push(fn)
}

// ---- 宿主环境桩 -----------------------------------------------------------
globalThis.window = { innerWidth: 1280, innerHeight: 900, __ModuleLoader__: { load: (m) => { globalThis.__mod = m } } }
globalThis.document = { body: {}, addEventListener() {}, removeEventListener() {} }
const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = (fn) => { fn(); return 0 }

let fetchBody = null
globalThis.fetch = (url, init) => {
  globalThis.__lastUrl = url
  globalThis.__lastInit = init
  return Promise.resolve({ ok: fetchBody !== null, json: () => Promise.resolve(fetchBody) })
}

const requireStub = (name) => {
  if (name === 'react') return React
  if (name === 'react-dom') return { createPortal: (el) => el }
  throw new Error(`unexpected require: ${name}`)
}

// ---- 加载插件 -------------------------------------------------------------
new Function('window', src)(globalThis.window)
check('模块被 ModuleLoader 接管', !!globalThis.__mod)
const api = globalThis.__mod.factory(requireStub)

let render = null
const ctx = {
  effect: (fn) => { fn(); return () => {} },
  locale: { register: () => () => {}, bind: () => (key) => `__missing_${key}__` },
  slots: {
    inject: (name, fn) => { fn(); return () => {} },
    register: (spec, fn) => { render = fn; return () => {} },
  },
}
api.apply(ctx)
check('dock 已注册', typeof render === 'function')

const props = {
  sessionId: 's1',
  useProjection: (k) => (k === 'tokenUsage'
    ? { cacheReadTokens: 1_000_000, uncachedInputTokens: 2_000_000, outputTokens: 500_000 }
    : { next: { model: 'deepseek-flash' } }),
}
const root = render(props)
const t = root.props.t

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

async function paint() {
  for (let i = 0; i < 6; i++) {
    dirty = false
    hookIdx = 0
    pending = []
    const out = root.tag(root.props)
    const effects = pending
    pending = []
    for (const fn of effects) { const r = fn(); if (typeof r === 'function') cleanups.push(r) }
    await flush()
    if (!dirty) return out
    dirty = false
  }
  throw new Error('paint did not settle')
}

function collect(node, texts, attrs) {
  if (node === null || node === undefined || node === false) return
  if (typeof node === 'string' || typeof node === 'number') { texts.push(String(node)); return }
  if (Array.isArray(node)) { for (const n of node) collect(n, texts, attrs); return }
  if (!node || !node.props) return
  if (node.tag === 'button' || node.tag === 'div' || node.tag === 'span') attrs.push({ tag: node.tag, key: node.key, ...node.props })
  collect(node.props.children, texts, attrs)
}
function snapOf(node) {
  const texts = []
  const attrs = []
  collect(node, texts, attrs)
  return { texts, all: texts.join(' | '), attrs }
}

let cleanups = []

function nodesOf(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) { for (const n of node) nodesOf(n, out); return out }
  if (typeof node === 'string' || typeof node === 'number') return out
  if (!node || !node.props) return out
  out.push(node)
  nodesOf(node.props.children, out)
  return out
}

async function mount() {
  for (const c of cleanups) { try { c() } catch (_) {} }
  cleanups = []
  hookState = []
  hookIdx = 0
  effectSlots.length = 0
  return paint()
}
async function clickTrigger(tree) {
  const btn = snapOf(tree).attrs.find((a) => a.tag === 'button' && typeof a.onClick === 'function')
  if (!btn) throw new Error('trigger button missing')
  // 真实 React 里 ref 由 DOM 提供，这里给按钮的 ref.current 塞一个可测量节点。
  if (btn.ref) btn.ref.current = { getBoundingClientRect: () => ({ top: 840, left: 900, width: 120, height: 20 }), contains: () => false }
  btn.onClick()
  return paint()
}

// ---- 1. 空闲/高峰徽标（未接账本）------------------------------------------
let tree = await mount()
let snap = snapOf(tree)
const trigger = snap.attrs.find((a) => a.tag === 'button')
check('折叠态显示金额', /¥/.test(snap.all), snap.all.slice(0, 100))
check('触发按钮 title 点明当前计时段', !!trigger && /高峰时段计价|空闲时段计价/.test(String(trigger.title)), trigger && trigger.title)

tree = await clickTrigger(tree)
snap = snapOf(tree)
const has = (s) => snap.all.includes(s)
check('面板展开：显示「累计」', has('累计'))
check('显示当前计时段', has('高峰时段计价') || has('空闲时段计价'))
check('显示缓存单价', /缓存命中 ¥0\.0[24]\/M/.test(snap.all), snap.all.slice(0, 200))
check('显示高峰窗口', has('高峰：工作日 9–12、14–18 点'))
check('显示空闲规则', has('其余时段与周末按空闲价'))
check('显示距切换倒计时', /距进入高峰|距进入空闲|距切换时间未知/.test(snap.all))
check('显示状态徽标', /正常|注意|超限|待定/.test(snap.all))
check('显示本轮分区', has('本轮') || has('上一轮'))
check('显示成本合计行', has('成本合计'))
check('显示「成本构成」分区', has('成本构成'))
check('显示判据短句', /判据：本轮缓存 ¥0\.1 黄、¥0\.3 红/.test(snap.all))
check('账本缺席时说明按现价折算', has('累计暂按现价折算，会漂移'))
check('未出现旧长句', !has('历史不会随后续时段变化') && !has('距黄线（'))
const long = snap.texts.filter((s) => s.length > 26)
check('所有文案 ≤ 26 字（不折行）', long.length === 0, long.join(' / '))

// ---- 2. 账本命中 ---------------------------------------------------------
fetchBody = {
  ok: true, sessionId: 's1', hasPricedSteps: true,
  totals: { cost: 0.0719, cacheCost: 0.0116, inputCost: 0.0382, outputCost: 0.0221 },
  turns: { 1: { cost: 0.031, cacheCost: 0.01, inputCost: 0.011, outputCost: 0.01 } },
  currentTurn: 1, lastAssistantTurn: 1, inFlightTurn: null,
  unknownModels: ['mystery-model'],
}
tree = await mount()
tree = await clickTrigger(tree)
snap = snapOf(tree)
check('账本命中：显示账本金额', /¥0\.0719|¥0\.072/.test(snap.all), snap.all.slice(0, 200))
check('账本命中：说明按每步当时价计', has('累计按每步当时价计，不漂移'))
check('账本命中：点名未收录模型', /未收录模型按默认价：mystery-model/.test(snap.all))
check('账本命中：不显示按现价折算', !has('累计暂按现价折算，会漂移'))
check('fetch 命中 ledger 路由', String(globalThis.__lastUrl || '').startsWith('/api/cost-meter/ledger?id=s1'), globalThis.__lastUrl)
check('fetch 带面板头', !!globalThis.__lastInit && globalThis.__lastInit.headers['x-cost-meter'] === '1')

// 单条三色堆叠条：整条 = 累计成本，宽度按成本占比
const all = nodesOf(tree)
const bar = all.find((n) => n.key === 'split-bar')
check('存在单条堆叠条', !!bar)
const segs = bar ? (Array.isArray(bar.props.children) ? bar.props.children.flat(9) : []).filter(Boolean) : []
check('堆叠条分三段', segs.length === 3, String(segs.length))
const widths = segs.map((x) => parseFloat(String(x.props.style.width)))
check('三段宽度合计 100%', Math.abs(widths.reduce((a, b) => a + b, 0) - 100) < 0.5, widths.join(' / '))
const colors = new Set(segs.map((x) => String(x.props.style.background)))
check('三段颜色互不相同', colors.size === 3, [...colors].join(' / '))
check('三段宽度与账本占比一致', Math.abs(widths[0] - 16.13) < 0.3 && Math.abs(widths[1] - 53.13) < 0.3 && Math.abs(widths[2] - 30.74) < 0.3, widths.join(' / '))
check('图例给出成本占比', ['16%', '53%', '31%'].every((x) => snap.all.includes(x)), snap.all)
check('图例给出 token 量', ['1M', '2M', '500k'].every((x) => snap.all.includes(x)), snap.all)

// ---- 3. 峰谷两态（拨时钟）------------------------------------------------
for (const [label, iso, expect] of [
  ['周三 11:00 高峰', '2026-11-11T03:00:00Z', '高峰时段计价'],
  ['周三 20:30 空闲', '2026-11-11T12:30:00Z', '空闲时段计价'],
]) {
  const RealDate = Date
  const Fixed = class extends RealDate {
    constructor(...a) { super(...(a.length ? a : [iso])) }
    static now() { return new RealDate(iso).getTime() }
  }
  globalThis.Date = Fixed
  tree = await mount()
  tree = await clickTrigger(tree)
  const s2 = snapOf(tree)
  check(`${label}：显示「${expect}」`, s2.all.includes(expect), s2.all.slice(0, 160))
  check(`${label}：倒计时方向正确`, expect === '高峰时段计价' ? s2.all.includes('距进入空闲') : s2.all.includes('距进入高峰'))
  check(`${label}：给出切换的具体星期与时刻`, /（周[一二三四五六日] \d{2}:\d{2}）/.test(s2.all), s2.all.slice(0, 200))
  globalThis.Date = RealDate
}

globalThis.setTimeout = realSetTimeout
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
