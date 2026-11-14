window.__ModuleLoader__.load({
  id: '@local/cost-meter',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    let createPortal = null
    try { createPortal = require('react-dom').createPortal } catch (_) { createPortal = null }

    // 官方定价（CNY / 百万 tokens，2026-11 官网）。空闲价为高峰价的一半。
    // 高峰 = 北京时间周一至周五 9:00–12:00、14:00–18:00（法定节假日未单独处理）。
    // 来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
    const PRICES = {
      'deepseek-flash': { off: { cacheRead: 0.02, input: 1, output: 4 }, peak: { cacheRead: 0.04, input: 2, output: 8 } },
      'deepseek-v4-pro': { off: { cacheRead: 0.15, input: 4.5, output: 13.5 }, peak: { cacheRead: 0.30, input: 9, output: 27 } },
    }
    const ALIAS = { 'deepseek-v4-flash': 'deepseek-flash', 'deepseek-v4-flash-vision-exp': 'deepseek-flash' }
    const FALLBACK_MODEL = 'deepseek-flash'

    function beijingPeak(date) {
      try {
        const parts = new Intl.DateTimeFormat('en-US', {
          timeZone: 'Asia/Shanghai', hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit',
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

    function rateFor(modelName, date) {
      const entry = PRICES[ALIAS[modelName] || modelName] || PRICES[FALLBACK_MODEL]
      const peak = beijingPeak(date)
      return { ...(peak ? entry.peak : entry.off), peak }
    }

    // 下一个峰谷切换点（北京时区）。高峰窗口是工作日 9–12、14–18，周末整天空闲，
    // 所以周六、周日之后的下一个切换点是周一 9:00。
    // 返回 { kind: 'peak' | 'off', mins }，mins 为距切换的分钟数。
    function nextBoundary(date) {
      try {
        const parts = new Intl.DateTimeFormat('en-US', {
          timeZone: 'Asia/Shanghai', hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit',
        }).formatToParts(date)
        const f = {}
        for (const p of parts) f[p.type] = p.value
        const wd = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[f.weekday]
        if (wd === undefined) return null
        const nowMins = wd * 1440 + (Number(f.hour) % 24) * 60 + Number(f.minute)
        const marks = [[540, 'peak'], [720, 'off'], [840, 'peak'], [1080, 'off']]
        let best = null
        for (let d = 0; d < 14; d += 1) {
          const dow = (wd + d) % 7
          if (dow >= 5) continue
          for (const [m, kind] of marks) {
            const at = (wd + d) * 1440 + m
            if (at <= nowMins) continue
            if (!best || at < best.at) best = { at, kind, m }
          }
        }
        if (!best) return null
        // 具体到「周一 09:00」，比只有倒计时更好定位——这是用户最容易被忽略的信息。
        const WEEK = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
        const day = WEEK[Math.floor(best.at / 1440) % 7]
        const hm = `${String(Math.floor(best.m / 60)).padStart(2, '0')}:${String(best.m % 60).padStart(2, '0')}`
        return { kind: best.kind, mins: best.at - nowMins, label: `${day} ${hm}` }
      } catch (_) {
        return null
      }
    }

    // 「1 小时 12 分」这类短时长，避免提示里出现只剩两位数的折行；跨天时用「1 天 23 小时」。
    function dur(mins) {
      const dd = Math.floor(mins / 1440)
      const hh = Math.floor((mins % 1440) / 60)
      const mm = mins % 60
      if (dd > 0) return hh ? `${dd} 天 ${hh} 小时` : `${dd} 天`
      if (hh <= 0) return `${mm} 分钟`
      return mm ? `${hh} 小时 ${mm} 分` : `${hh} 小时`
    }

    // 判据（1.3.2 起）：两条正交指标，任一越线就变色。
    // ① 每步上下文 = 每步要重付一次的输入量（cacheRead + 非缓存输入）。切换会话真正能省的是它，
    //    且与「这轮跑了几步」无关——旧口径「本轮缓存命中金额」把步数也乘进去了，短轮多步会误报。
    // 用 token 而不是人民币当阈值，是因为它不该跟着峰谷时段跳：空闲价打折，上下文不会变轻。
    // ② 会话累计成本：钱包的真实支出，绝对预算兜底。
    // 旧口径（本轮缓存命中 ¥0.1/¥0.3）只保留给「账本拿不到」的退路。
    const WARN_CTX_TOKENS = 200_000
    const RED_CTX_TOKENS = 400_000
    const WARN_SESSION_YUAN = 3
    const RED_SESSION_YUAN = 8
    const RED_CACHE_YUAN = 0.3
    const WARN_CACHE_YUAN = 0.1

    // 切到新会话后，每步上下文大致回落到这个量级（经验值：系统提示 + 首轮重读必要文件）。
    const FRESH_CTX_TOKENS = 20_000
    const PREDICT_TURNS = 10

    // 与内置 ContextMeter 同一套排版常量。
    const FONT_SECONDARY = 'var(--dsh-content-font-size-secondary, 13px)'
    const LINE_SECONDARY = 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))'

    // 本轮起点：按 sessionId 记住本轮开始时的累计用量（模块级，组件重挂载后仍在）。
    // 每个会话一条记录，互不影响：切会话、并行多会话都不会串账。
    // 本轮成本 = 当前累计用量 − 起点；回合结束后不冻结，继续吸收结算延迟补来的最后一步。
    const turnBySession = new Map()

    // 金额显示：小额给足精度，避免一切成本都被压成「<0.01」。
    const yuan = (v) => {
      const n = Number(v)
      if (!(n > 0)) return '0.00'
      if (n >= 0.1) return n.toFixed(2)
      if (n >= 0.0005) return n.toFixed(3)
      return '<0.001'
    }
    const cost = (tokens, unit) => (tokens / 1e6) * unit
    const ktok = (n) => (n < 1000 ? String(n) : n < 1e6 ? `${Math.round(n / 100) / 10}k` : `${Math.round(n / 1e5) / 10}M`)
    const money = (v) => `¥${yuan(v)}`
    // 文案里的阈值占位符 {warn} / {red} 按常量填充。
    const fill = (s, vars) =>
      String(s == null ? '' : s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined ? '' : String(vars[k])))

    function CostMeter(props) {
      const { useProjection, sessionId, t } = props

      // 会话行的 running 用来切分「本轮」。没有 useSessions 时退化为「一直在本轮」，
      // 数字仍会增长，只是不做上/本轮切换。
      const canWatch = typeof props.useSessions === 'function'
      const getSessions = canWatch ? props.useSessions : () => null
      const catalog = getSessions((s) => s)
      const row = catalog && catalog.byId ? catalog.byId[sessionId] : null
      const running = canWatch ? !!(row && row.running) : true

      const usage = useProjection('tokenUsage')
      const selection = useProjection('modelSelection')
      const [turn, setTurn] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const [hover, setHover] = React.useState(false)
      const [pos, setPos] = React.useState(null)
      const triggerRef = React.useRef(null)
      const panelRef = React.useRef(null)

      const cached = usage ? usage.cacheReadTokens || 0 : 0
      const uncached = usage ? usage.uncachedInputTokens || 0 : 0
      const output = usage ? usage.outputTokens || 0 : 0

      React.useEffect(() => {
        if (!usage || !sessionId) return
        const now = { cache: cached, input: uncached, output }
        const st = turnBySession.get(sessionId) || { running: null, base: null }
        if (st.running === null) {
          // 首次观测：正在跑就以此刻为起点（挂载前的几步算不进来），空闲则不设起点。
          st.base = running ? now : null
        } else if (running && !st.running) {
          st.base = now
        }
        st.running = running
        turnBySession.set(sessionId, st)

        const next = st.base
          ? {
              cache: Math.max(0, now.cache - st.base.cache),
              input: Math.max(0, now.input - st.base.input),
              output: Math.max(0, now.output - st.base.output),
            }
          : null
        setTurn((prev) => {
          if (!prev && !next) return prev
          if (prev && next && prev.cache === next.cache && prev.input === next.input && prev.output === next.output) return prev
          return next
        })
      }, [sessionId, running, cached, uncached, output, usage])

      // 宿主账本：每一步按它**请求发生时**的峰谷价与模型计价后求和。
      // 客户端投影 tokenUsage 只有累计数，缺「哪一步、什么时间、什么模型」，
      // 只能拿当前价去乘历史总量——一跨峰谷分界，历史金额就整体改写。
      const [ledger, setLedger] = React.useState(null)
      React.useEffect(() => {
        if (!sessionId) return undefined
        let cancelled = false
        const timer = setTimeout(() => {
          const q = `id=${encodeURIComponent(sessionId)}&t=${Date.now()}`
          fetch(`/api/cost-meter/ledger?${q}`, { headers: { 'x-cost-meter': '1' }, cache: 'no-store' })
            .then((res) => (res.ok ? res.json() : null))
            .then((body) => {
              if (cancelled || !body || !body.ok) return
              // 记下取数那刻的 running：账本里的「本轮」只在 running 未变时才可信。
              setLedger({ ...body, runningAtFetch: running })
            })
            .catch(() => {})
        }, 400)
        return () => {
          cancelled = true
          clearTimeout(timer)
        }
      }, [sessionId, running, cached, uncached, output])

      React.useLayoutEffect(() => {
        if (!open || !triggerRef.current) return
        const r = triggerRef.current.getBoundingClientRect()
        setPos({
          bottom: Math.max(8, window.innerHeight - r.top + 8),
          left: Math.max(8, Math.min(r.left - 8, window.innerWidth - 360)),
        })
      }, [open])

      React.useEffect(() => {
        if (!open) return
        const onDown = (e) => {
          if (panelRef.current && panelRef.current.contains(e.target)) return
          if (triggerRef.current && triggerRef.current.contains(e.target)) return
          setOpen(false)
        }
        const onKey = (e) => {
          if (e.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('pointerdown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      if (!usage) return null
      if (cached + uncached + output === 0) return null

      const model = selection ? selection.next || selection.lastUsed : null
      // 现价只用于「下一步」的提示与账本缺席时的退路，不再乘历史总量。
      const price = rateFor(model && model.model, new Date())

      // 有账本就用账本的累计（历史已冻结）；running 只决定哪一桶算「本轮」。
      const led = ledger && ledger.sessionId === sessionId && ledger.hasPricedSteps ? ledger : null
      const ledTotals = led ? led.totals : null
      const ledSynced = !!(led && led.runningAtFetch === running)

      const cacheCost = ledTotals ? ledTotals.cacheCost : cost(cached, price.cacheRead)
      const inputCost = ledTotals ? ledTotals.inputCost : cost(uncached, price.input)
      const outputCost = ledTotals ? ledTotals.outputCost : cost(output, price.output)
      const total = ledTotals ? ledTotals.cost : cacheCost + inputCost + outputCost

      // 本轮：有在跑的 step 就指向它所在的 turn，否则用最新 turn；上一轮固定取最后一个有 usage 的 turn。
      const turnNo = ledSynced
        ? running
          ? led.inFlightTurn !== null && led.inFlightTurn !== undefined
            ? led.inFlightTurn
            : led.currentTurn
          : led.lastAssistantTurn
        : null
      const bucket = turnNo === null || turnNo === undefined ? null : led.turns[String(turnNo)] || null
      const turnCost = ledSynced
        ? bucket
          ? bucket.cost
          : running
            ? 0
            : null
        : turn
          ? cost(turn.cache, price.cacheRead) + cost(turn.input, price.input) + cost(turn.output, price.output)
          : null
      const turnCache = ledSynced
        ? bucket
          ? bucket.cacheCost
          : running
            ? 0
            : null
        : turn
          ? cost(turn.cache, price.cacheRead)
          : null

      // ---- 判据：两条正交指标 ------------------------------------------------
      // 每轮按账本里的 turn 桶求「每步上下文」（cacheRead + 非缓存输入）与「本轮成本」，
      // 取最近 3 轮的中位数做平滑，避免单轮步数抖动。
      const turnNums = led
        ? Object.keys(led.turns).map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b)
        : []
      const turnInfo = turnNums.map((n) => {
        const b = led.turns[String(n)]
        const st = b.steps || 0
        return { n, cost: b.cost || 0, ctx: st ? (b.cache + b.input) / st : 0 }
      })
      const median = (arr) => {
        if (!arr.length) return null
        const a = [...arr].sort((x, y) => x - y)
        const m = Math.floor(a.length / 2)
        return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
      }
      const recent = turnInfo.slice(-3)
      const ctxNow = recent.length ? median(recent.map((x) => x.ctx)) : null
      const perTurnCost = recent.length ? median(recent.map((x) => x.cost)) : null
      // 上下文每轮增长：首轮到末轮的平均斜率，用来预测「再跑几轮会有多重」。
      const ctxGrowth = turnInfo.length >= 2
        ? (turnInfo[turnInfo.length - 1].ctx - turnInfo[0].ctx) / (turnInfo.length - 1)
        : 0

      const ctxRedHit = ctxNow !== null && ctxNow >= RED_CTX_TOKENS
      const ctxWarnHit = !ctxRedHit && ctxNow !== null && ctxNow >= WARN_CTX_TOKENS
      const costRedHit = ledTotals ? ledTotals.cost >= RED_SESSION_YUAN : false
      const costWarnHit = !costRedHit && ledTotals ? ledTotals.cost >= WARN_SESSION_YUAN : false

      // 账本拿不到时退回旧口径（只看本轮缓存命中金额），面板会明说。
      const red = led ? ctxRedHit || costRedHit : turnCache !== null && turnCache >= RED_CACHE_YUAN
      const hitWarn = !red && (led ? ctxWarnHit || costWarnHit : turnCache !== null && turnCache >= WARN_CACHE_YUAN)

      const tone = red
        ? 'var(--dsw-alias-state-error-primary)'
        : hitWarn
          ? 'var(--dsw-alias-state-warn-primary)'
          : 'var(--dsw-alias-label-tertiary)'

      const turnLabel = running ? t('turn') : t('lastTurn')

      // 旧口径的插值变量（退路用），以及新口径的两组阈值。
      const lvLegacy = { warn: String(WARN_CACHE_YUAN), red: String(RED_CACHE_YUAN) }
      const lv = {
        warn: String(WARN_SESSION_YUAN), red: String(RED_SESSION_YUAN),
        wct: ktok(WARN_CTX_TOKENS), rct: ktok(RED_CTX_TOKENS),
      }
      const costNow = ledTotals ? ledTotals.cost : null

      // 每条提示独立成行，且都短到不会在面板宽度内折行。
      let reason
      if (led) {
        if (ctxRedHit && costRedHit) reason = t('reasonBothRed')
        else if (ctxRedHit) reason = fill(t('reasonCtxRed'), { ctx: ktok(ctxNow) })
        else if (costRedHit) reason = fill(t('reasonCostRed'), lv)
        else if (ctxWarnHit && costWarnHit) reason = t('reasonBothWarn')
        else if (ctxWarnHit) reason = fill(t('reasonCtxWarn'), { ctx: ktok(ctxNow) })
        else if (costWarnHit) reason = fill(t('reasonCostWarn'), lv)
        else reason = t('reasonOk')
      } else if (turnCache === null) reason = t('reasonUnknown')
      else if (red) reason = fill(t('reasonRed'), lvLegacy)
      else if (hitWarn) reason = fill(t('reasonWarn'), lvLegacy)
      else reason = fill(t('reasonLegacyOk'), lvLegacy)

      // 差额：同时给出两条指标各自离黄线还差多少，便于判断先撞哪条。
      let gapLine = null
      if (led && !red && ctxNow !== null) {
        const ctxTarget = ctxWarnHit ? RED_CTX_TOKENS : WARN_CTX_TOKENS
        const costTarget = costWarnHit ? RED_SESSION_YUAN : WARN_SESSION_YUAN
        gapLine = fill(t(ctxWarnHit || costWarnHit ? 'gapToRed' : 'gapToWarn'), {
          ctx: ktok(Math.max(1000, ctxTarget - ctxNow)),
          cost: money(Math.max(0, costTarget - (costNow || 0))),
        })
      } else if (!led && turnCache !== null && !red) {
        const target = hitWarn ? RED_CACHE_YUAN : WARN_CACHE_YUAN
        gapLine = `${fill(t('toWarn'), lvLegacy)} ${money(target - turnCache)}`
      }

      // 预测：按近 3 轮的每轮成本外推；上下文增长另起一行；切换后的回本代价单独一行。
      const ctxLine = led && ctxNow !== null
        ? fill(t('ctxLine'), {
            ctx: ktok(ctxNow),
            grow: ctxGrowth >= 1000 ? `+${ktok(ctxGrowth)}` : '持平',
          })
        : null
      const predictLine = led && perTurnCost !== null && perTurnCost > 0
        ? fill(t('predict'), { n: String(PREDICT_TURNS), cost: money(perTurnCost * PREDICT_TURNS) })
        : null
      const switchLine = led && ctxNow !== null && perTurnCost !== null && perTurnCost > 0
        && ctxNow > FRESH_CTX_TOKENS * 2
        ? fill(t('switchLine'), { cost: money(perTurnCost * (FRESH_CTX_TOKENS / ctxNow) * 3) })
        : null

      const ruleCtx = led ? fill(t('ruleCtx'), lv) : null
      const ruleCost = led ? fill(t('ruleCost'), lv) : fill(t('rule'), lvLegacy)
      // 计价口径写清楚：账本在就说明「历史按当时价」，没接上就明说在按现价折算。
      const sourceLine = led ? t('ledgerExact') : t('ledgerFallback')
      const unknownLine = led && led.unknownModels && led.unknownModels.length
        ? fill(t('ledgerUnknown'), { models: led.unknownModels.join('、') })
        : null

      // 当前处于高峰还是空闲，以及距下一次切换还有多久——这是最容易被忽略的一行，
      // 单独放进一个描边框里，不和判据、口径混在一起。
      const boundary = nextBoundary(new Date())
      const statusText = red
        ? t('stRed')
        : hitWarn
          ? t('stWarn')
          : turnCache === null
            ? t('stUnknown')
            : t('stOk')

      // 成本构成：一条三色堆叠条，整条 = 累计总成本（100%），每段按该项成本占比切分。
      // 颜色固定「缓存命中=品牌蓝、非缓存=琥珀、输出=红」，越靠右越贵，图例里带色点对齐。
      const SPLIT = [
        { key: 'cache', label: t('cache'), tokens: cached, value: cacheCost, color: 'var(--dsw-alias-brand-primary)' },
        { key: 'input', label: t('input'), tokens: uncached, value: inputCost, color: 'var(--dsw-alias-state-warn-primary)' },
        { key: 'output', label: t('output'), tokens: output, value: outputCost, color: 'var(--dsw-alias-state-error-primary)' },
      ]
      const shareOf = (v) => (total > 0 ? Math.max(0, Math.min(1, v / total)) : 0)
      const pct = (v) => `${Math.round(shareOf(v) * 100)}%`

      const splitBar = h('div', {
        key: 'split-bar',
        style: {
          display: 'flex', height: '8px', borderRadius: '4px', overflow: 'hidden',
          background: 'var(--dsw-alias-border-l1)', marginTop: '2px',
        },
      }, SPLIT.map((s) => h('span', {
        key: s.key,
        title: `${s.label} ${pct(s.value)}`,
        style: {
          display: 'block', height: '100%', width: `${(shareOf(s.value) * 100).toFixed(2)}%`,
          background: s.color, flex: 'none',
        },
      })))

      // 图例行：色点 + 名称 + token 量 + 成本占比 + 金额，三行左右对齐，和上面那条堆叠条一一对应。
      const legendRow = (s) =>
        h('div', {
          key: s.key,
          style: { display: 'flex', alignItems: 'center', gap: '6px', lineHeight: '18px' },
        }, [
          h('span', {
            key: 'd',
            style: { flex: 'none', width: '6px', height: '6px', borderRadius: '3px', background: s.color },
          }),
          h('span', {
            key: 'l',
            style: { flex: 'none', color: 'var(--dsw-alias-label-secondary)' },
          }, s.label),
          h('span', {
            key: 't',
            style: {
              marginLeft: 'auto', flex: 'none', width: '46px', textAlign: 'right', fontSize: '11px',
              color: 'var(--dsw-alias-label-tertiary)', fontVariantNumeric: 'tabular-nums',
            },
          }, ktok(s.tokens)),
          h('span', {
            key: 'p',
            style: {
              flex: 'none', width: '36px', textAlign: 'right', fontSize: '11px',
              color: 'var(--dsw-alias-label-secondary)', fontVariantNumeric: 'tabular-nums',
            },
          }, pct(s.value)),
          h('span', {
            key: 'v',
            style: {
              flex: 'none', width: '56px', textAlign: 'right', whiteSpace: 'nowrap',
              color: 'var(--dsw-alias-label-primary)', fontWeight: 600,
              fontVariantNumeric: 'tabular-nums',
            },
          }, money(s.value)),
        ])

      const flatRow = (key, label, value, color) =>
        h('div', {
          key,
          style: { display: 'flex', alignItems: 'baseline', gap: '8px', lineHeight: '20px' },
        }, [
          h('span', { key: 'l', style: { flex: 'none', color: 'var(--dsw-alias-label-secondary)' } }, label),
          h('span', {
            key: 'v',
            style: {
              marginLeft: 'auto', flex: 'none', whiteSpace: 'nowrap',
              fontVariantNumeric: 'tabular-nums', fontWeight: 600,
              color: color || 'var(--dsw-alias-label-primary)',
            },
          }, value),
        ])

      // 分区标题：小一号、加粗、带字距，和正文行拉开层次。
      const sectionLabel = (key, text) =>
        h('div', {
          key,
          style: {
            fontSize: '11px', lineHeight: '16px', fontWeight: 600,
            color: 'var(--dsw-alias-label-tertiary)', letterSpacing: '0.04em',
          },
        }, text)

      const hint = (key, text, color) =>
        h('div', {
          key,
          style: { fontSize: '11px', lineHeight: '16px', color: color || 'var(--dsw-alias-label-tertiary)' },
        }, text)

      const divider = (key) =>
        h('div', {
          key,
          style: { height: '1px', background: 'var(--dsw-alias-border-l1)', margin: '6px 0' },
        })

      // 计时段：当前是高峰还是空闲、单价多少、窗口怎么算、多久后切换。
      // 四行短句，任意一行都不会折行，也不会和判据混在一起。
      const periodBox = h('div', {
        key: 'period',
        style: {
          marginTop: '6px', padding: '6px 8px', borderRadius: 'var(--dsw-radius-sm)',
          border: '1px solid var(--dsw-alias-border-l1)',
          display: 'flex', flexDirection: 'column', gap: '1px',
        },
      }, [
        h('div', {
          key: 'h',
          style: { display: 'flex', alignItems: 'baseline', gap: '8px', lineHeight: '16px' },
        }, [
          h('span', {
            key: 'b',
            style: { flex: 'none', fontSize: '11px', fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' },
          }, t('priceBrand')),
          h('span', {
            key: 'r',
            style: {
              marginLeft: 'auto', fontSize: '11px', fontVariantNumeric: 'tabular-nums',
              color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap',
            },
          }, fill(t('cacheRate'), { rate: String(price.cacheRead) })),
        ]),
        h('div', {
          key: 't',
          style: { display: 'flex', alignItems: 'center', gap: '6px', lineHeight: '18px' },
        }, [
          h('span', {
            key: 'd',
            style: {
              flex: 'none', width: '6px', height: '6px', borderRadius: '3px',
              background: price.peak ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-brand-primary)',
            },
          }),
          h('span', {
            key: 'k',
            style: { fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
          }, price.peak ? t('peakNow') : t('offNow')),
        ]),
        hint('w1', t('peakWindows')),
        hint('w2', t('offWindows')),
        hint('nx', boundary
          ? fill(price.peak ? t('nextOff') : t('nextPeak'), { d: dur(boundary.mins), at: boundary.label })
          : t('nextUnknown'), 'var(--dsw-alias-label-secondary)'),
        hint('note', t('priceNote'), 'var(--dsw-alias-label-tertiary)'),
      ])

      // 状态徽标 + 距阈值差额：颜色含义直接写在徽标文字里，不用只靠颜色猜。
      const statusRow = h('div', {
        key: 'status',
        style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px', lineHeight: '18px' },
      }, [
        h('span', {
          key: 'pill',
          style: {
            flex: 'none', padding: '0 6px', borderRadius: '9px', whiteSpace: 'nowrap',
            border: `1px solid ${tone}`, color: tone, fontSize: '11px', fontWeight: 600,
          },
        }, statusText),
        gapLine === null ? null : h('span', {
          key: 'gap',
          style: {
            marginLeft: 'auto', fontSize: '11px', whiteSpace: 'nowrap',
            color: 'var(--dsw-alias-label-secondary)', fontVariantNumeric: 'tabular-nums',
          },
        }, gapLine),
      ])

      const panelBody = open && pos
        ? h('div', {
            ref: panelRef,
            role: 'dialog',
            'aria-label': t('title'),
            style: {
              position: 'fixed', bottom: `${pos.bottom}px`, left: `${pos.left}px`,
              zIndex: 1100, boxSizing: 'border-box',
              width: 'min(340px, calc(100vw - 24px))',
              borderRadius: 'var(--dsw-radius-lg)',
              background: 'var(--dsw-specific-menu)',
              backdropFilter: 'var(--dsw-menu-backdrop-filter)',
              boxShadow: 'var(--dsw-elevation-prominent)',
              color: 'var(--dsw-alias-label-secondary)',
              border: 'none', padding: '12px',
              fontSize: '12px', lineHeight: '20px',
              display: 'flex', flexDirection: 'column', gap: '2px',
            },
          }, [
            // 累计：标签小、金额大，一眼分清「标题」与「读数」。
            h('div', {
              key: 'head',
              style: { display: 'flex', alignItems: 'baseline', gap: '8px' },
            }, [
              h('span', {
                key: 'l',
                style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
              }, t('total')),
              h('span', {
                key: 'v',
                style: {
                  marginLeft: 'auto', fontSize: '18px', lineHeight: '24px', fontWeight: 600,
                  color: 'var(--dsw-alias-label-primary)', fontVariantNumeric: 'tabular-nums',
                },
              }, money(total)),
            ]),
            periodBox,
            divider('hr1'),
            sectionLabel('split', t('split')),
            splitBar,
            ...SPLIT.map(legendRow),
            divider('hr2'),
            sectionLabel('sec', turnLabel),
            flatRow('turn', t('cost'), turnCost === null ? '—' : money(turnCost), tone),
            flatRow('turnCache', t('turnCache'), turnCache === null ? '—' : money(turnCache), red || hitWarn ? tone : undefined),
            statusRow,
            hint('reason', reason, tone),
            divider('hr3'),
            hint('rule-ctx', ruleCost, 'var(--dsw-alias-label-tertiary)'),
            ruleCtx === null ? null : hint('rule-cost', ruleCtx, 'var(--dsw-alias-label-tertiary)'),
            ctxLine === null ? null : hint('ctx-line', ctxLine, 'var(--dsw-alias-label-secondary)'),
            predictLine === null ? null : hint('predict', predictLine, 'var(--dsw-alias-label-secondary)'),
            switchLine === null ? null : hint('switch', switchLine, 'var(--dsw-alias-label-secondary)'),
            hint('source', sourceLine),
            unknownLine === null ? null : hint('unknown', unknownLine, 'var(--dsw-alias-state-warn-primary)'),
          ])
        : null

      // createPortal 必须给挂载容器；没有 react-dom 时就地渲染，绝不让组件抛错。
      const panel = panelBody === null
        ? null
        : createPortal
          ? createPortal(panelBody, document.body)
          : panelBody

      return h('div', { style: { display: 'inline-flex', flex: 'none' } }, [
        h('button', {
          key: 'trigger',
          ref: triggerRef,
          type: 'button',
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          // 悬停就能看到计价时段，不必先点开面板。
          title: `${price.peak ? t('peakNow') : t('offNow')} · ${t('peakWindows')}`,
          onClick: () => setOpen(!open),
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            display: 'inline-flex', alignItems: 'center', gap: '6px',
            padding: '1px 8px', margin: 0, border: 'none',
            borderRadius: 'var(--dsw-radius-sm)',
            background: hover || open ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
            color: hover || open ? 'var(--dsw-alias-label-secondary)' : tone,
            fontFamily: 'inherit', fontSize: FONT_SECONDARY, lineHeight: LINE_SECONDARY,
            fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
            cursor: 'pointer', flex: 'none',
          },
        }, [
          h('span', { key: 'a' }, money(total)),
          h('span', { key: 's', style: { opacity: 0.45 } }, '·'),
          h('span', { key: 'b' }, `${turnLabel} ${turnCost === null ? '—' : money(turnCost)}`),
        ]),
        panel,
      ])
    }

    // 所有提示句都控制在面板宽度内（≤ 24 字），避免出现只剩两三个字的短换行。
    // 文案按用户要求固定中文：即使界面语言是英文也不会切成英文。
    const ZH = {
      title: '会话成本',
      total: '累计',
      turn: '本轮',
      lastTurn: '上一轮',
      cost: '成本合计',
      split: '成本构成',
      turnCache: '缓存命中',
      cache: '缓存命中',
      input: '非缓存',
      output: '输出',
      priceBrand: 'DeepSeek 官方价',
      cacheRate: '缓存命中 ¥{rate}/百万 tokens',
      priceNote: '人民币；法定节假日未按高峰计',
      peakNow: '当前高峰时段',
      offNow: '当前空闲时段',
      peakWindows: '高峰：工作日 9–12、14–18 点',
      offWindows: '其余时段与周末按空闲价',
      nextPeak: '距进入高峰 {d}（{at}）',
      nextOff: '距进入空闲 {d}（{at}）',
      nextUnknown: '距切换时间未知',
      stOk: '正常',
      stWarn: '注意',
      stRed: '超限',
      stUnknown: '待定',
      // 判据 v2：每步上下文与会话累计两条线，任一越线就变色。
      reasonOk: '每步上下文与累计都在黄线内',
      reasonBothWarn: '上下文与累计都已过黄线',
      reasonCtxWarn: '每步上下文已过 {ctx} 黄线',
      reasonCostWarn: '会话累计已过 ¥{warn} 黄线',
      reasonBothRed: '上下文与累计都超红线，该交接',
      reasonCtxRed: '每步上下文已过 {ctx} 红线',
      reasonCostRed: '会话累计已过 ¥{red} 红线',
      // 账本拿不到时的旧口径文案。
      reasonLegacyOk: '本轮缓存未到 ¥{warn} 黄线',
      reasonWarn: '本轮缓存已过 ¥{warn} 黄线',
      reasonRed: '本轮缓存已过 ¥{red} 红线',
      reasonUnknown: '本轮起点未知，下一轮恢复',
      toWarn: '距黄线还差',
      gapToWarn: '距黄线：每步 +{ctx} / 累计 +{cost}',
      gapToRed: '距红线：每步 +{ctx} / 累计 +{cost}',
      ctxLine: '每步上下文 {ctx} · 每轮 {grow}',
      predict: '按近 3 轮节奏，再 {n} 轮约 {cost}',
      switchLine: '切新会话每步约 2 万，前 3 轮约 {cost}',
      ruleCtx: '判据：每步上下文 {wct} 黄、{rct} 红',
      ruleCost: '判据：会话累计 ¥{warn} 黄、¥{red} 红',
      rule: '判据：本轮缓存 ¥{warn} 黄、¥{red} 红',
      ledgerExact: '累计按每步当时价计，不漂移',
      ledgerFallback: '累计暂按现价折算，会漂移',
      ledgerUnknown: '未收录模型按默认价：{models}',
    }
    const EN = {
      title: 'Session cost',
      total: 'total',
      turn: 'this turn',
      lastTurn: 'last turn',
      cost: 'cost',
      split: 'cost split',
      turnCache: 'cache hit',
      cache: 'cache hit',
      input: 'uncached',
      output: 'output',
      priceBrand: 'DeepSeek list price',
      cacheRate: 'cache hit ¥{rate}/M tokens',
      priceNote: 'CNY; public holidays billed as off-peak',
      peakNow: 'peak window now',
      offNow: 'off-peak now',
      peakWindows: 'Peak: weekdays 9–12, 14–18',
      offWindows: 'Everything else is off-peak',
      nextPeak: 'Peak in {d} ({at})',
      nextOff: 'Off-peak in {d} ({at})',
      nextUnknown: 'Next switch unknown',
      stOk: 'ok',
      stWarn: 'watch',
      stRed: 'over',
      stUnknown: 'n/a',
      reasonOk: 'Per-step context and total are inside the amber line',
      reasonBothWarn: 'Both context and total passed the amber line',
      reasonCtxWarn: 'Per-step context passed {ctx}',
      reasonCostWarn: 'Session total passed ¥{warn}',
      reasonBothRed: 'Context and total both over the red line; time to hand off',
      reasonCtxRed: 'Per-step context passed {ctx}',
      reasonCostRed: 'Session total passed ¥{red}',
      reasonLegacyOk: 'Cache cost this turn is below the ¥{warn} amber line',
      reasonWarn: 'Cache cost this turn passed ¥{warn}',
      reasonRed: 'Cache cost this turn passed ¥{red}',
      reasonUnknown: 'Turn start unknown; it recovers on the next turn.',
      toWarn: 'Until the amber line:',
      gapToWarn: 'Until amber: +{ctx} per step / +{cost} total',
      gapToRed: 'Until red: +{ctx} per step / +{cost} total',
      ctxLine: 'Context per step {ctx} · per turn {grow}',
      predict: 'At the last 3 turns pace, {n} more turns ≈ {cost}',
      switchLine: 'Fresh session starts near 20k; first 3 turns ≈ {cost}',
      ruleCtx: 'Judged on per-step context: {wct} amber, {rct} red',
      ruleCost: 'Judged on session total: ¥{warn} amber, ¥{red} red',
      rule: 'Judged on cache cost this turn: ¥{warn} amber, ¥{red} red',
      ledgerExact: 'Each step priced at its own rate; the total never drifts.',
      ledgerFallback: 'Host ledger unavailable; the total is converted at the current rate and drifts.',
      ledgerUnknown: 'Unknown models priced at the default rate: {models}',
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register('cost-meter', 'zh-CN', ZH))
        // EN 字典保留供将来恢复多语言时使用；当前面板按用户要求固定中文，不走界面语言。
        ctx.effect(() => ctx.locale.register('cost-meter', 'en', EN))
        const bound = ctx.locale.bind('cost-meter')
        // 固定中文：界面语言是英文、或 locale 命名空间未命中回退成原始 key 时，面板仍显示中文文案。
        const t = (key) => (ZH[key] === undefined ? bound(key) : ZH[key])
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            { name: 'conversation.composer.dock', id: 'cost-meter', order: 2 },
            (props) => h(CostMeter, { ...props, t }),
          ),
        )
      },
    }
  },
})
