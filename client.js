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

      // 每条提示独立成行，且都短到不会在面板宽度内折行：
      // 短句 + 宽面板，避免出现「只剩两三个字」的短换行。
      let reason = fill(t('reasonOk'), lv)
      if (turnCache === null) reason = fill(t('reasonUnknown'), lv)
      else if (red) reason = fill(t('reasonRed'), lv)
      else if (hitWarn) reason = fill(t('reasonWarn'), lv)

      // 差额单独一行：只写「距某线还差多少」，不和其他口径信息挤在一起。
      let gapLine = null
      if (turnCache !== null) {
        if (red) gapLine = null
        else if (hitWarn) gapLine = `${fill(t('toRed'), lv)} ${money(RED_CACHE_YUAN - turnCache)}`
        else gapLine = `${fill(t('toWarn'), lv)} ${money(WARN_CACHE_YUAN - turnCache)}`
      }
      const ruleLine = fill(t('rule'), lv)
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
          h('span', {
            key: 'r',
            style: {
              marginLeft: 'auto', fontSize: '11px', fontVariantNumeric: 'tabular-nums',
              color: 'var(--dsw-alias-label-secondary)',
            },
          }, fill(t('cacheRate'), { rate: String(price.cacheRead) })),
        ]),
        hint('w1', t('peakWindows')),
        hint('w2', t('offWindows')),
        hint('nx', boundary
          ? fill(price.peak ? t('nextOff') : t('nextPeak'), { d: dur(boundary.mins), at: boundary.label })
          : t('nextUnknown'), 'var(--dsw-alias-label-secondary)'),
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
            hint('rule', ruleLine),
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
      reasonOk: '本轮缓存未到 ¥{warn} 黄线，不变色',
      reasonWarn: '本轮缓存已过 ¥{warn} 黄线，变黄',
      reasonRed: '本轮缓存已过 ¥{red} 红线，变红',
      reasonUnknown: '本轮起点未知，下一轮恢复',
      toWarn: '距黄线还差',
      toRed: '距红线还差',
      rule: '判据：本轮缓存 ¥{warn} 黄、¥{red} 红',
      peakNow: '高峰时段计价',
      offNow: '空闲时段计价',
      cacheRate: '缓存命中 ¥{rate}/M',
      peakWindows: '高峰：工作日 9–12、14–18 点',
      offWindows: '其余时段与周末按空闲价',
      nextPeak: '距进入高峰 {d}（{at}）',
      nextOff: '距进入空闲 {d}（{at}）',
      nextUnknown: '距切换时间未知',
      stOk: '正常',
      stWarn: '注意',
      stRed: '超限',
      stUnknown: '待定',
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
      reasonOk: 'Cache cost this turn is below the ¥{warn} amber line; the reading stays neutral.',
      reasonWarn: 'Cache cost this turn passed ¥{warn}; the reading turned amber.',
      reasonRed: 'Cache cost this turn passed ¥{red}; the reading turned red.',
      reasonUnknown: 'Turn start unknown; it recovers on the next turn.',
      toWarn: 'Until the amber line:',
      toRed: 'Until the red line:',
      rule: 'Judged on cache cost this turn: ¥{warn} amber, ¥{red} red',
      peakNow: 'peak pricing',
      offNow: 'off-peak pricing',
      cacheRate: 'cache hit ¥{rate}/M',
      peakWindows: 'Peak: weekdays 9–12, 14–18',
      offWindows: 'Off-peak the rest of the time',
      nextPeak: 'Peak in {d} ({at})',
      nextOff: 'Off-peak in {d} ({at})',
      nextUnknown: 'Next switch unknown',
      stOk: 'ok',
      stWarn: 'watch',
      stRed: 'over',
      stUnknown: 'n/a',
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
