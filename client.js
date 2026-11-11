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

    // 颜色判据落在「本轮缓存命中成本」上：≥ ¥0.3 红，≥ ¥0.1 黄。
    // 为什么不看「单条消息」：单条请求的缓存命中成本 ≈ 上下文 × 缓存单价
    // （flash 高峰 ¥0.04/百万），70k 上下文一步只有 ¥0.003，永远到不了阈值；
    // 本轮会随步数累加，同样的判据才有意义。
    // 档位：¥0.1 / ¥0.3 是按本机实测的单轮成本量级（¥0.1–0.3）定的；
    // 上下文 70k 时约 35 步到黄、105 步到红，与「单会话 40 回合就该考虑交接」基本对齐。
    const RED_CACHE_YUAN = 0.3
    const WARN_CACHE_YUAN = 0.1

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
          left: Math.max(8, Math.min(r.left - 8, window.innerWidth - 300)),
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

      const red = turnCache !== null && turnCache >= RED_CACHE_YUAN
      const hitWarn = !red && turnCache !== null && turnCache >= WARN_CACHE_YUAN

      const tone = red
        ? 'var(--dsw-alias-state-error-primary)'
        : hitWarn
          ? 'var(--dsw-alias-state-warn-primary)'
          : 'var(--dsw-alias-label-tertiary)'

      const turnLabel = running ? t('turn') : t('lastTurn')

      // 文案里的 ¥0.1 / ¥0.3 由常量插值，调档位只改上面两个常量。
      const lv = { warn: String(WARN_CACHE_YUAN), red: String(RED_CACHE_YUAN) }

      // 变色原因：面板里直接写清读数位置、还差多少、以及判据本身，不用再猜。
      const small = { marginTop: '2px', fontSize: '11px', lineHeight: '16px' }
      let reason = fill(t('reasonOk'), lv)
      let gapLine = null
      if (turnCache === null) {
        reason = fill(t('reasonUnknown'), lv)
      } else if (red) {
        reason = fill(t('reasonRed'), lv)
      } else if (hitWarn) {
        reason = fill(t('reasonWarn'), lv)
        gapLine = `${fill(t('toRed'), lv)} ${money(RED_CACHE_YUAN - turnCache)}`
      } else {
        gapLine = `${fill(t('toWarn'), lv)} ${money(WARN_CACHE_YUAN - turnCache)}`
      }
      const ruleLine = `${fill(t('rule'), lv)} · ¥${price.cacheRead}/M ${price.peak ? t('peak') : t('offPeak')}`
      // 计价口径写清楚：账本在就说明「历史按当时价」，没接上就明说在按现价折算。
      const sourceLine = led
        ? led.unknownModels && led.unknownModels.length
          ? fill(`${t('ledgerExact')} ${t('ledgerUnknown')}`, { models: led.unknownModels.join('、') })
          : t('ledgerExact')
        : t('ledgerFallback')

      const statRow = (key, label, value, share) =>
        h('div', {
          key,
          style: { display: 'flex', alignItems: 'center', gap: '8px' },
        }, [
          h('span', { key: 'l', style: { flex: 'none' } }, label),
          h('span', {
            key: 'b',
            style: {
              flex: '1 1 auto', height: '4px', borderRadius: '2px',
              background: 'var(--dsw-alias-border-l1)', overflow: 'hidden',
            },
          }, h('span', {
            style: {
              display: 'block', height: '100%', width: `${Math.round(share * 100)}%`,
              background: 'var(--dsw-alias-brand-primary)', opacity: 0.8,
            },
          })),
          h('span', {
            key: 'v',
            style: {
              flex: 'none', width: '56px', textAlign: 'right',
              color: 'var(--dsw-alias-label-primary)', fontWeight: 500,
            },
          }, value),
        ])

      const flatRow = (key, label, value, color) =>
        h('div', {
          key,
          style: { display: 'flex', alignItems: 'center', gap: '6px', color },
        }, [
          h('span', { key: 'l' }, label),
          h('span', {
            key: 'v',
            style: { marginLeft: 'auto', fontVariantNumeric: 'tabular-nums', fontWeight: 500 },
          }, value),
        ])

      const panelBody = open && pos
        ? h('div', {
            ref: panelRef,
            role: 'dialog',
            'aria-label': t('title'),
            style: {
              position: 'fixed', bottom: `${pos.bottom}px`, left: `${pos.left}px`,
              zIndex: 1100, boxSizing: 'border-box',
              width: 'min(288px, calc(100vw - 24px))',
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
            flatRow('head', t('total'), money(total), 'var(--dsw-alias-label-secondary)'),
            statRow('cache', `${t('cache')} ${ktok(cached)}`, money(cacheCost), total ? cacheCost / total : 0),
            statRow('input', `${t('input')} ${ktok(uncached)}`, money(inputCost), total ? inputCost / total : 0),
            statRow('output', `${t('output')} ${ktok(output)}`, money(outputCost), total ? outputCost / total : 0),
            h('div', {
              key: 'hr',
              style: { height: '1px', background: 'var(--dsw-alias-border-l1)', margin: '6px 0' },
            }),
            flatRow('turn', turnLabel, turnCost === null ? '—' : money(turnCost), tone),
            flatRow('turnCache', t('turnCache'), turnCache === null ? '—' : money(turnCache), red || hitWarn ? tone : undefined),
            h('div', { key: 'reason', style: { ...small, color: tone } }, reason),
            gapLine === null ? null : h('div', {
              key: 'gap',
              style: { ...small, color: 'var(--dsw-alias-label-secondary)' },
            }, gapLine),
            h('div', {
              key: 'rule',
              style: { ...small, color: 'var(--dsw-alias-label-tertiary)' },
            }, ruleLine),
            h('div', {
              key: 'source',
              style: { ...small, color: 'var(--dsw-alias-label-tertiary)' },
            }, sourceLine),
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

    const ZH = {
      title: '会话成本',
      total: '累计',
      turn: '本轮',
      lastTurn: '上一轮',
      turnCache: '本轮缓存命中',
      cache: '缓存命中',
      input: '非缓存',
      output: '输出',
      reasonOk: '本轮缓存命中未到 ¥{warn} 黄线，所以不变色。',
      reasonWarn: '本轮缓存命中已过 ¥{warn} 黄线，所以变黄。',
      reasonRed: '本轮缓存命中已过 ¥{red} 红线，所以变红。',
      reasonUnknown: '本轮起点未知（刚刷新或刚挂载），下一轮开始后恢复。',
      toWarn: '距黄线（¥{warn}）还差',
      toRed: '距红线（¥{red}）还差',
      rule: '判据只看本轮缓存命中：¥{warn} 黄、¥{red} 红',
      peak: '高峰',
      offPeak: '空闲',
      ledgerExact: '累计按每步请求时的峰谷价分别计价，历史不会随后续时段变化。',
      ledgerFallback: '宿主计价未接入，累计暂按当前价折算，跨峰谷分界会漂移。',
      ledgerUnknown: '含未收录模型，按默认价估算：{models}',
    }
    const EN = {
      title: 'Session cost',
      total: 'total',
      turn: 'this turn',
      lastTurn: 'last turn',
      turnCache: 'cache hit this turn',
      cache: 'cache hit',
      input: 'uncached',
      output: 'output',
      reasonOk: 'Cache-read cost of this turn is below the ¥{warn} amber line, so the reading stays neutral.',
      reasonWarn: 'Cache-read cost of this turn passed ¥{warn}, so the reading turned amber.',
      reasonRed: 'Cache-read cost of this turn passed ¥{red}, so the reading turned red.',
      reasonUnknown: 'Turn start unknown (just reloaded); it recovers on the next turn.',
      toWarn: 'Until the amber line (¥{warn}):',
      toRed: 'Until the red line (¥{red}):',
      rule: 'Judged on cache-read cost of this turn: ¥{warn} amber, ¥{red} red',
      peak: 'peak',
      offPeak: 'off-peak',
      ledgerExact: 'Total is priced per step at the peak/off-peak rate in force when that step ran, so it never drifts later.',
      ledgerFallback: 'Host ledger unavailable; the total is converted at the current rate and drifts across peak boundaries.',
      ledgerUnknown: 'Priced at the default rate for models it does not know: {models}',
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
