/**
 * dsh-cabinet —— 浏览器半端（设置在「设置 → 内阁」里）
 * ============================================================================
 * ⭐ client bundle 不是 ESM，是自注册脚本（跟 dsh-bili-scroll 抄的同一套约定）：
 *
 *     window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => ({ inject, apply }) })
 *
 * 这一页要干的事：把席位（谁、擅长什么、用哪个模型）配好，存到宿主那边；
 * 议题来了就让首辅召集，席位配置每次都能改（用户要求：席位我自己选，但记住上次）。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-cabinet',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/cabinet'

    const asJson = async (res) => {
      if (res.ok) return res.json()
      const why = res.status === 401 ? '（未登录 / 没权限）' : res.status === 403 ? '（被宿主拦了）' : ''
      throw new Error('HTTP ' + res.status + why)
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    const CSS = `
[data-cb-page]{display:flex;flex-direction:column;gap:16px;max-width:720px;padding:2px 2px 10px;}
[data-cb-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-cb-note]{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-cb-card]{display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:10px;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(128,128,128,.22));
  background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.06));}
[data-cb-row]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
[data-cb-input]{box-sizing:border-box;padding:6px 9px;border-radius:8px;font-size:12px;font-family:inherit;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(128,128,128,.24));
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.12));color:inherit;}
[data-cb-input]:focus{outline:none;border-color:#3b82f6;}
[data-cb-btn]{padding:6px 11px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(128,128,128,.24));
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.14));color:inherit;}
[data-cb-btn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.26));}
[data-cb-btn][data-primary]{background:#3b82f6;border-color:#3b82f6;color:#fff;}
[data-cb-btn][disabled]{opacity:.5;cursor:default;}
[data-cb-msg]{font-size:11px;line-height:16px;padding:7px 9px;border-radius:8px;word-break:break-all;}
[data-cb-msg][data-bad]{background:rgba(239,68,68,.12);color:#ef4444;}
[data-cb-msg][data-good]{background:rgba(34,197,94,.12);color:#22c55e;}

/* ── 会场面板 ── */
[data-cb-room]{display:flex;flex-direction:column;gap:14px;height:100%;overflow:auto;padding:18px 22px 40px;box-sizing:border-box;}
[data-cb-room-head]{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;}
[data-cb-room-title]{font-size:16px;font-weight:600;}
[data-cb-chip]{font-size:11px;padding:2px 8px;border-radius:999px;white-space:nowrap;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(128,128,128,.3));color:var(--dsw-alias-label-secondary,#b6bcc4);}
[data-cb-chip][data-st="debate"]{background:rgba(59,130,246,.14);border-color:rgba(59,130,246,.4);color:#60a5fa;}
[data-cb-chip][data-st="proposed"]{background:rgba(234,179,8,.14);border-color:rgba(234,179,8,.4);color:#eab308;}
[data-cb-chip][data-st="decided"],[data-cb-chip][data-st="framed"]{background:rgba(168,85,247,.14);border-color:rgba(168,85,247,.4);color:#c084fc;}
[data-cb-chip][data-st="dispatched"],[data-cb-chip][data-st="running"],[data-cb-chip][data-st="integrating"],[data-cb-chip][data-st="auditing"]{background:rgba(59,130,246,.14);border-color:rgba(59,130,246,.4);color:#60a5fa;}
[data-cb-chip][data-st="blocked"]{background:rgba(239,68,68,.14);border-color:rgba(239,68,68,.4);color:#ef4444;}
[data-cb-chip][data-st="delivered"]{background:rgba(34,197,94,.14);border-color:rgba(34,197,94,.4);color:#22c55e;}
[data-cb-seats]{display:flex;gap:6px;flex-wrap:wrap;}
[data-cb-seat]{font-size:11px;padding:3px 9px;border-radius:8px;white-space:nowrap;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(128,128,128,.24));
  background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.06));color:var(--dsw-alias-label-secondary,#b6bcc4);}
[data-cb-seat][data-speaking]{border-color:#3b82f6;background:rgba(59,130,246,.16);color:#60a5fa;font-weight:600;}
[data-cb-seat] b{font-weight:600;color:var(--dsw-alias-label-primary,inherit);}
[data-cb-say]{display:flex;flex-direction:column;gap:3px;padding:9px 0;border-top:1px solid var(--dsw-alias-bg-layer-3,rgba(128,128,128,.14));}
[data-cb-say]:first-child{border-top:none;}
[data-cb-who]{display:flex;align-items:baseline;gap:8px;font-size:11px;}
[data-cb-who] b{font-size:12px;font-weight:600;}
[data-cb-who] span[data-dim]{color:var(--dsw-alias-label-tertiary,#8b9199);font-family:ui-monospace,Menlo,monospace;}
[data-cb-say-text]{font-size:12.5px;line-height:20px;white-space:pre-wrap;word-break:break-word;}
[data-cb-prop]{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border-radius:10px;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(128,128,128,.24));background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.05));}
[data-cb-prop][data-picked]{border-color:#22c55e;background:rgba(34,197,94,.08);}
[data-cb-prop] .t{font-size:12.5px;font-weight:600;}
[data-cb-prop] .s{font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-secondary,#b6bcc4);margin-top:3px;white-space:pre-wrap;}
[data-cb-tbl]{width:100%;border-collapse:collapse;font-size:11.5px;}
[data-cb-tbl] th{text-align:left;font-weight:600;font-size:10.5px;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#8b9199);padding:0 8px 6px 0;}
[data-cb-tbl] td{padding:5px 8px 5px 0;vertical-align:top;border-top:1px solid var(--dsw-alias-bg-layer-3,rgba(128,128,128,.14));}
[data-cb-tbl] td[data-mono]{font-family:ui-monospace,Menlo,monospace;}
[data-cb-empty]{font-size:12px;line-height:19px;color:var(--dsw-alias-label-tertiary,#8b9199);}

/* ── 阁老活动卡 ── */
[data-cb-acts]{display:grid;grid-template-columns:repeat(auto-fill,minmax(178px,1fr));gap:8px;}
[data-cb-act]{display:flex;flex-direction:column;gap:5px;padding:10px 11px;border-radius:10px;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(128,128,128,.24));
  background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.05));}
[data-cb-act][data-st="speaking"]{border-color:#3b82f6;background:rgba(59,130,246,.10);}
[data-cb-act][data-st="working"]{border-color:#3b82f6;background:rgba(59,130,246,.08);}
[data-cb-act][data-st="blocked"]{border-color:rgba(239,68,68,.6);background:rgba(239,68,68,.08);}
[data-cb-act][data-st="done"]{border-color:rgba(34,197,94,.5);background:rgba(34,197,94,.07);}
[data-cb-act-head]{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;}
[data-cb-act-head] b{font-size:12.5px;font-weight:600;}
[data-cb-act-head] span[data-dim]{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8b9199);
  font-family:ui-monospace,Menlo,monospace;}
[data-cb-act-doing]{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#b6bcc4);word-break:break-word;}
[data-cb-act-meta]{font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-tertiary,#8b9199);
  font-family:ui-monospace,Menlo,monospace;word-break:break-all;}
[data-cb-dot]{width:6px;height:6px;border-radius:999px;background:#6b7280;flex:0 0 auto;align-self:center;}
[data-cb-dot][data-st="speaking"],[data-cb-dot][data-st="working"]{background:#3b82f6;}
[data-cb-dot][data-st="done"]{background:#22c55e;}
[data-cb-dot][data-st="blocked"]{background:#ef4444;}
[data-cb-dot][data-st="waiting"]{background:#eab308;}
[data-cb-dot][data-st="listening"]{background:#8b5cf6;}
/* 会话内的方案卡（tool.call.toolview · cabinet_propose） */
[data-cb-pick]{margin:8px 0 10px;padding:10px 12px;border:1px solid var(--dsw-alias-bg-layer-3,rgba(128,128,128,.24));
  border-radius:10px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.05));}
[data-cb-pick-head]{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:8px;}
[data-cb-pick-head] b{font-size:13px;font-weight:600;}
[data-cb-pick-head] span{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b9199);}
[data-cb-pick-item]{padding:9px 11px;border:1px solid var(--dsw-alias-bg-layer-3,rgba(128,128,128,.2));
  border-radius:8px;margin-bottom:7px;}
[data-cb-pick-item][data-on]{border-color:#3b82f6;background:rgba(59,130,246,.08);}
[data-cb-pick-t]{font-size:12.5px;font-weight:600;display:flex;align-items:baseline;gap:7px;flex-wrap:wrap;}
[data-cb-pick-tag]{font-size:10.5px;font-weight:400;padding:1px 6px;border-radius:999px;
  background:var(--dsw-alias-bg-layer-3,rgba(128,128,128,.18));color:var(--dsw-alias-label-secondary,#b6bcc4);}
[data-cb-pick-s]{font-size:11.5px;line-height:17px;margin-top:4px;color:var(--dsw-alias-label-secondary,#b6bcc4);}
[data-cb-pick-m]{font-size:11px;line-height:16px;margin-top:3px;color:var(--dsw-alias-label-tertiary,#8b9199);}
[data-cb-pick-act]{display:flex;align-items:center;gap:8px;margin-top:8px;}
[data-cb-pick-note]{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b9199);}
`

    const useStyle = () => {
      React.useEffect(() => {
        const id = 'dsh-cabinet-style'
        if (document.getElementById(id)) return
        const el = document.createElement('style')
        el.id = id
        el.textContent = CSS
        document.head.appendChild(el)
      }, [])
    }

    const Field = ({ label, value, onChange, placeholder, width }) => h('label', {
      style: { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11, flex: width ? `0 0 ${width}` : '1 1 120px', minWidth: 0 },
    }, [
      h('span', { key: 'l', 'data-cb-h': '' }, label),
      h('input', {
        key: 'i',
        'data-cb-input': '',
        value: value || '',
        placeholder: placeholder || '',
        onChange: (e) => onChange(e.target.value),
      }),
    ])

    // 宿主版本不同，/models 可能给 [{id,name}] 也可能给纯字符串数组；这里统一成 {id,name}，
    // 否则下拉框里会渲染出一排空白项（value/label 都取到 undefined）。
    const normModel = (m) => {
      if (typeof m === 'string') return m ? { id: m, name: m } : null
      const id = String(m?.id ?? m?.model ?? m?.value ?? '')
      if (!id) return null
      return { id, name: String(m?.name ?? m?.displayName ?? m?.title ?? id) || id }
    }

    const normProvider = (p) => ({
      provider: String(p?.provider ?? p?.id ?? p?.name ?? ''),
      label: String(p?.label ?? p?.title ?? '') || String(p?.provider ?? p?.id ?? p?.name ?? ''),
      models: (Array.isArray(p?.models) ? p.models : []).map(normModel).filter(Boolean),
    })

    function Panel() {
      useStyle()
      const [seats, setSeats] = React.useState([])
      const [chairLabel, setChairLabel] = React.useState('内阁首辅')
      const [catalogue, setCatalogue] = React.useState([])
      const [msg, setMsg] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [loaded, setLoaded] = React.useState(false)

      React.useEffect(() => {
        let alive = true
        ;(async () => {
          try {
            const s = await jget('/seats')
            if (!alive) return
            setSeats(Array.isArray(s.seats) ? s.seats : [])
            setChairLabel(s.chairLabel || '内阁首辅')
          } catch (e) {
            if (alive) setMsg({ bad: true, text: '读席位失败：' + e.message })
          }
          try {
            const m = await jget('/models')
            if (!alive) return
            setCatalogue(Array.isArray(m.providers) ? m.providers.map(normProvider) : [])
            if (m.ok === false && m.error) setMsg({ bad: true, text: '拉模型列表失败：' + m.error + '（可以手填 provider / model）' })
          } catch (e) {
            if (alive) setMsg({ bad: true, text: '拉模型列表失败：' + e.message })
          }
          if (alive) setLoaded(true)
        })()
        return () => { alive = false }
      }, [])

      const patch = (i, key, value) => setSeats((prev) => prev.map((s, j) => (j === i ? { ...s, [key]: value } : s)))

      const addSeat = () => {
        const first = catalogue[0]
        setSeats((prev) => prev.length >= 8 ? prev : [...prev, {
          id: 's' + (prev.length + 1) + '-' + Math.random().toString(36).slice(2, 6),
          label: '阁员' + (prev.length + 1),
          skill: '',
          provider: first ? first.provider : '',
          model: first && first.models[0] ? first.models[0].id : '',
          reasoningEffort: null,
        }])
      }

      const removeSeat = (i) => setSeats((prev) => prev.filter((_, j) => j !== i))

      // 用户要的是"填人数和模型"：一键把席位增/减到 N 位，比一位一位点更省事
      const setCount = (n) => setSeats((prev) => {
        const want = Math.max(1, Math.min(8, Number(n) || prev.length))
        if (want === prev.length) return prev
        if (want < prev.length) return prev.slice(0, want)
        const first = catalogue[0]
        const add = []
        for (let i = prev.length; i < want; i++) {
          add.push({
            id: 's' + (i + 1),
            label: '阁员' + (i + 1),
            skill: '',
            provider: first ? first.provider : '',
            model: first && first.models[0] ? first.models[0].id : '',
            reasoningEffort: null,
          })
        }
        return [...prev, ...add]
      })

      const save = async () => {
        const blank = seats.find((s) => !String(s.provider || '').trim() || !String(s.model || '').trim())
        if (blank) {
          setMsg({ bad: true, text: `「${blank.label || blank.id}」还没选 provider / model —— 先补上再保存。` })
          return
        }
        setBusy(true)
        setMsg(null)
        try {
          const r = await jpost('/seats', { chairLabel, seats })
          if (!r.ok) throw new Error(r.error || '保存失败')
          setSeats(r.seats || [])
          setChairLabel(r.chairLabel || '内阁首辅')
          setMsg({ good: true, text: `已存下 ${(r.seats || []).length} 位阁员。下次召集就用这套。` })
        } catch (e) {
          setMsg({ bad: true, text: '保存失败：' + e.message })
        } finally { setBusy(false) }
      }

      const modelsOf = (provider, current) => {
        const p = catalogue.find((x) => x.provider === provider)
        const list = (p && p.models) || []
        // 当前值不在列表里（手填的、或模型改名了）就补一个选项，否则下拉框会显示成空白
        if (current && !list.some((m) => m.id === current)) return [{ id: current, name: current + ' （当前）' }].concat(list)
        return list
      }

      return h('div', { 'data-cb-page': '' }, [
        h('div', { key: 'title', style: { fontSize: 14, fontWeight: 600 } }, '内阁'),
        h('div', { key: 'note', 'data-cb-note': '' }, [
          '在一条对话里让多个模型轮流发言：首辅统筹、阁员各说各的判断，一轮走完首辅写小结，',
          '你说「继续」就再议一轮，你说「出方案」他就把 2–3 个方案摆出来让你挑。',
          h('br', { key: 'br' }),
          '这里配的是「谁会坐进内阁」—— 每次召集都用这套，想换人随时改。',
        ].join('')),

        h('div', { key: 'chair', 'data-cb-card': '' }, [
          h('div', { key: 'h', 'data-cb-h': '' }, '首辅'),
          h('div', { key: 'r', 'data-cb-row': '' }, [
            h(Field, {
              key: 'f',
              label: '称号（首辅就是这条对话当前的模型）',
              value: chairLabel,
              onChange: setChairLabel,
              placeholder: '内阁首辅',
              width: 260,
            }),
          ]),
        ]),

        h('div', { key: 'seats', 'data-cb-card': '' }, [
          h('div', { key: 'h', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } }, [
            h('span', { key: 'a', 'data-cb-h': '' }, '阁老（人数 / 每人什么模型）'),
            h('label', { key: 'n', style: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 } }, [
              h('span', { key: 'l', 'data-cb-h': '' }, '人数'),
              h('select', {
                key: 's', 'data-cb-input': '', value: String(seats.length || 1),
                onChange: (e) => setCount(Number(e.target.value)),
              }, [1, 2, 3, 4, 5, 6, 7, 8].map((n) => h('option', { key: n, value: String(n) }, String(n)))),
            ]),
            h('span', { key: 'b', style: { flex: 1 } }),
            h('button', { key: 'c', 'data-cb-btn': '', disabled: seats.length >= 8, onClick: addSeat }, '加一位'),
          ]),
          seats.length === 0
            ? h('div', { key: 'empty', 'data-cb-note': '' }, loaded ? '还没有阁员。至少要有 2 位才能召集。' : '读取中…')
            : seats.map((s, i) => h('div', {
              key: s.id || i,
              style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 0', borderTop: i ? '1px solid var(--dsw-alias-bg-layer-3,rgba(128,128,128,.18))' : 'none' },
            }, [
              h('div', { key: 'r1', 'data-cb-row': '' }, [
                h(Field, { key: 'l', label: '席位名', value: s.label, onChange: (v) => patch(i, 'label', v), width: 120 }),
                h(Field, { key: 'k', label: '擅长（一句话，会写进它的任务提示）', value: s.skill, onChange: (v) => patch(i, 'skill', v), placeholder: '例如：架构 / 抠细节 / 挑毛病' }),
                h('button', {
                  key: 'x', 'data-cb-btn': '', title: '移出内阁',
                  style: { alignSelf: 'flex-end' },
                  onClick: () => removeSeat(i),
                }, '移出'),
              ]),
              h('div', { key: 'r2', 'data-cb-row': '' }, [
                h('label', { key: 'p', style: { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11 } }, [
                  h('span', { key: 'l', 'data-cb-h': '' }, 'provider'),
                  h('select', {
                    key: 's', 'data-cb-input': '', value: s.provider,
                    onChange: (e) => {
                      const provider = e.target.value
                      const first = modelsOf(provider)[0]
                      setSeats((prev) => prev.map((x, j) => (j === i ? { ...x, provider, model: first ? first.id : '' } : x)))
                    },
                  }, catalogue.length
                    ? catalogue.map((p) => h('option', { key: p.provider, value: p.provider }, p.label || p.provider))
                    : [h('option', { key: '__cur', value: s.provider }, s.provider || '（手填）')]),
                ]),
                h('label', { key: 'm', style: { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11, minWidth: 200 } }, [
                  h('span', { key: 'l', 'data-cb-h': '' }, modelsOf(s.provider, s.model).length ? 'model' : 'model（这个 provider 没报列表，手填）'),
                  modelsOf(s.provider).length
                    ? h('select', {
                      key: 's', 'data-cb-input': '', value: s.model,
                      onChange: (e) => patch(i, 'model', e.target.value),
                    }, modelsOf(s.provider, s.model).map((m) => h('option', { key: m.id, value: m.id }, m.name || m.id)))
                    : h('input', {
                      key: 's', 'data-cb-input': '', value: s.model || '',
                      placeholder: '例如 deepseek-v4-pro',
                      onChange: (e) => patch(i, 'model', e.target.value),
                    }),
                ]),
                h('div', { key: 'grow', style: { flex: 1 } }),
              ]),
            ])),
          h('div', { key: 'r', 'data-cb-row': '', style: { marginTop: 4 } }, [
            h('button', { key: 's', 'data-cb-btn': '', 'data-primary': '', disabled: busy, onClick: save }, busy ? '保存中…' : '保存这套内阁'),
            h('span', { key: 'n', 'data-cb-note': '' }, '存在 $DSH_HOME/cabinet/seats.json'),
          ]),
        ]),

        msg ? h('div', { key: 'msg', 'data-cb-msg': '', 'data-bad': msg.bad ? '' : undefined, 'data-good': msg.good ? '' : undefined }, msg.text) : null,

        h('div', { key: 'how', 'data-cb-card': '' }, [
          h('div', { key: 'h', 'data-cb-h': '' }, '怎么用'),
          h('div', { key: 'n', 'data-cb-note': '' }, [
            '在对话里说一句：', h('b', { key: 'b' }, '「开个内阁讨论一下：<你的议题>」'), '。',
            h('br', { key: 'b2' }),
            '首辅会先开题，然后把话筒依次交给几位阁员 —— 每条回复都会显示是哪个模型说的。',
            h('br', { key: 'b3' }),
            '一轮结束后他会停下；你说「继续」就再议一轮，说「出方案」他就摆 2–3 个方案让你挑。',
          ].join('')),
        ]),
      ])
    }

    const fmtTime = (at) => {
      if (!at) return ''
      const d = new Date(at)
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
    }

    const ST_LABEL = {
      debate: '议政中', proposed: '待你挑方案', decided: '方案已定', framed: '框架待确认',
      dispatched: '已派活', running: '并行中', auditing: '质检中', blocked: '卡住了',
      integrating: '待整合', delivered: '已交付', closed: '已散会',
    }

    const ACT_LABEL = {
      speaking: '发言中', listening: '在听', working: '干活中', waiting: '等材料',
      done: '已交', blocked: '卡住', idle: '待命',
    }

    const Chip = ({ st, text }) => h('span', { 'data-cb-chip': '', 'data-st': st || '' }, text || st || '')

    function Room() {
      useStyle()
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [picked, setPicked] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState(null)

      React.useEffect(() => {
        let alive = true
        const pull = async () => {
          try {
            const s = await jget('/state')
            if (!alive) return
            setData(s)
            setErr(null)
          } catch (e) {
            if (alive) setErr(e.message)
          }
        }
        pull()
        const t = setInterval(pull, 2000)
        return () => { alive = false; clearInterval(t) }
      }, [])

      const debates = (data && Array.isArray(data.debates)) ? data.debates : []
      const d = debates.find((x) => x.sessionId === picked) || debates[0] || null

      const decide = async (n) => {
        setBusy(true)
        setMsg(null)
        try {
          const r = await jpost('/decide', { sessionId: d.sessionId, n })
          if (!r.ok) throw new Error(r.error || '没选上')
          setMsg({ good: true, text: `已选「${r.decision.title}」。回到对话里说一句「继续」，首辅就去做框架。` })
        } catch (e) {
          setMsg({ bad: true, text: '选方案失败：' + e.message })
        } finally { setBusy(false) }
      }

      const close = async () => {
        setBusy(true)
        try {
          await jpost('/close', { sessionId: d.sessionId })
          setMsg({ good: true, text: '已散会。' })
        } catch (e) {
          setMsg({ bad: true, text: '散会失败：' + e.message })
        } finally { setBusy(false) }
      }

      const head = h('div', { key: 'head', 'data-cb-room-head': '' }, [
        h('span', { key: 't', 'data-cb-room-title': '' }, '内阁'),
        d ? h(Chip, { key: 'st', st: d.status, text: ST_LABEL[d.status] || d.status }) : null,
        d ? h('span', { key: 'sp', 'data-cb-note': '' }, '话筒：' + (d.speaker || '—')) : null,
        d && d.speeches ? h('span', { key: 'n', 'data-cb-note': '' }, `已说 ${d.speeches} 次`) : null,
        h('span', { key: 'g', style: { flex: 1 } }),
        data ? h('span', { key: 'b', 'data-cb-note': '' }, 'build ' + data.build) : null,
        d ? h('button', { key: 'x', 'data-cb-btn': '', disabled: busy, onClick: close, title: '这只清掉面板里的这场会，对话里的记录不动' }, '散会') : null,
      ])

      if (err) {
        return h('div', { 'data-cb-room': '' }, [head,
          h('div', { key: 'e', 'data-cb-msg': '', 'data-bad': '' }, '读不到会场状态：' + err + '（宿主那边 /api/cabinet/state 没通？）')])
      }

      if (!data) {
        return h('div', { 'data-cb-room': '' }, [head, h('div', { key: 'l', 'data-cb-empty': '' }, '读取中…')])
      }

      if (!d) {
        return h('div', { 'data-cb-room': '' }, [head,
          h('div', { key: 'e', 'data-cb-empty': '' }, [
            '现在没有在进行中的议政。',
            h('br', { key: 'b' }),
            '在对话里说一句「开个内阁讨论一下：<议题>」，首辅召集之后这里会实时长出来 —— 谁在说、说了什么、话筒在谁手上、方案有几个、模块写到哪一步。',
          ].join('')),
          h('div', { key: 'n', 'data-cb-note': '' }, '席位和模型在「设置 → 内阁」里改。'),
        ])
      }

      const seatsRow = h('div', { key: 'seats', 'data-cb-seats': '' },
        (d.seats || []).map((s) => h('span', {
          key: s.id,
          'data-cb-seat': s.id === d.speakerId ? '' : undefined,
          'data-speaking': s.id === d.speakerId ? '' : undefined,
          title: s.model,
        }, [h('b', { key: 'l' }, s.label), ' ', h('span', { key: 'm', style: { opacity: .62 } }, s.model.split('/').pop())])))

      const acts = Array.isArray(d.seatActivity) ? d.seatActivity : []
      const working = acts.filter((a) => a.state === 'working').length
      const chairState = d.status === 'debate' && d.speaker === 'chair' ? 'speaking' : 'idle'
      const actCard = (key, label, model, state, doing, meta, extra) => h('div', {
        key, 'data-cb-act': '', 'data-st': state,
      }, [
        h('div', { key: 'h', 'data-cb-act-head': '' }, [
          h('span', { key: 'd', 'data-cb-dot': '', 'data-st': state }),
          h('b', { key: 'b' }, label),
          h('span', { key: 'm', 'data-dim': '' }, model || ''),
        ]),
        h('div', { key: 'x', 'data-cb-act-doing': '' }, doing || ''),
        meta ? h('div', { key: 'mm', 'data-cb-act-meta': '' }, meta) : null,
        extra ? h('div', { key: 'e', 'data-cb-act-meta': '' }, extra) : null,
      ])
      const actsBlock = h('div', { key: 'acts', 'data-cb-card': '' }, [
        h('div', { key: 'h', 'data-cb-h': '' }, `阁老正在干什么（${acts.length} 位）`),
        h('div', { key: 'g', 'data-cb-acts': '' }, [
          actCard('chair', d.chairLabel || '内阁首辅', '主持',
            chairState,
            d.speaker === 'chair'
              ? (d.status === 'debate' ? '话筒在手上，正在挑事' : '场子归他管，等你发话')
              : '听阁员说，等话筒回来',
            d.status ? (ST_LABEL[d.status] || d.status) : ''),
          ...acts.map((a) => actCard(
            a.id, a.label, (a.model || '').split('/').pop(), a.state, a.doing,
            a.modules && a.modules.length ? a.modules.join(' · ') : a.module,
            [a.child ? '子会话 ' + String(a.child).slice(0, 8) : '', a.speaks ? `说过 ${a.speaks} 次` : ''].filter(Boolean).join(' · '),
          )),
        ]),
        working > 0
          ? h('div', { key: 'p', 'data-cb-note': '' },
            `${working} 个模块正在各自的子会话里同时跑（上限 5 个）—— 这就是"多线不成就多会话"的落点：每个阁老一条独立会话，互不打断。`)
          : null,
      ])

      const propBlock = (d.proposals && d.proposals.length)
        ? h('div', { key: 'props', 'data-cb-card': '' }, [
          h('div', { key: 'h', 'data-cb-h': '' }, d.decision ? '方案（已选）' : '方案（挑一个）'),
          ...d.proposals.map((p, i) => h('div', {
            key: i,
            'data-cb-prop': '',
            'data-picked': d.decision && d.decision.n === i + 1 ? '' : undefined,
          }, [
            h('div', { key: 'c', style: { flex: 1, minWidth: 0 } }, [
              h('div', { key: 't', className: 't' }, `${i + 1}. ${p.title}`),
              p.stance ? h('div', { key: 's', 'data-cb-note': '' }, '立场：' + p.stance) : null,
              p.summary ? h('div', { key: 'm', className: 's' }, p.summary) : null,
            ]),
            d.status === 'proposed' || d.status === 'debate'
              ? h('button', {
                key: 'b', 'data-cb-btn': '', 'data-primary': '', disabled: busy,
                onClick: () => decide(i + 1),
              }, '选这个')
              : (d.decision && d.decision.n === i + 1 ? h(Chip, { key: 'b', st: 'delivered', text: '已选' }) : null),
          ])),
          d.status === 'proposed'
            ? h('div', { key: 'n', 'data-cb-note': '' }, '点了之后回对话说「继续」，首辅照着这个方案做框架。')
            : null,
        ])
        : null

      const mods = d.dispatch && d.dispatch.modules
      const modBlock = (mods && mods.length)
        ? h('div', { key: 'mods', 'data-cb-card': '' }, [
          h('div', { key: 'h', 'data-cb-h': '' }, `分工（${mods.filter((m) => m.status === 'done').length}/${mods.length} 完成）`),
          h('table', { key: 't', 'data-cb-tbl': '' }, [
            h('thead', { key: 'hd' }, h('tr', null, ['模块', '席位', '状态', '返工', '文件', '问题'].map((x) => h('th', { key: x }, x)))),
            h('tbody', { key: 'bd' }, mods.map((m) => h('tr', { key: m.id }, [
              h('td', { key: 'i', 'data-mono': '' }, m.id),
              h('td', { key: 's' }, ((d.seats || []).find((x) => x.id === m.seat) || {}).label || m.seat || '—'),
              h('td', { key: 'st' }, h(Chip, { st: m.status === 'blocked' ? 'blocked' : m.status === 'done' ? 'delivered' : 'running', text: m.status })),
              h('td', { key: 'r', 'data-mono': '' }, m.rework ? '×' + (m.rework + 1) : '—'),
              h('td', { key: 'f', 'data-mono': '', style: { maxWidth: 220, wordBreak: 'break-all' } }, (m.files || []).join(' ')),
              h('td', { key: 'e', style: { maxWidth: 260 } }, [
                ...(m.status === 'blocked' ? [{ k: 'i', t: (m.issues || []).filter((x) => x.level === 'error').map((x) => x.msg).slice(0, 2).join('；') }] : [])
                  .map((x) => h('div', { key: x.k, style: { color: '#ef4444' } }, x.t)),
                m.audit ? h('div', { key: 'a', 'data-cb-note': '' }, '质检：' + (m.audit.verdict || '未给结论') + (m.audit.by ? '（' + m.audit.by + '）' : '')) : null,
              ]),
            ]))),
          ]),
          d.dispatch.cwd ? h('div', { key: 'c', 'data-cb-note': '' }, '工作区：' + d.dispatch.cwd) : null,
        ])
        : null

      const frameIssues = (d.frameIssues || []).length
        ? h('div', { key: 'fi', 'data-cb-card': '' }, [
          h('div', { key: 'h', 'data-cb-h': '' }, '框架没过（拼不上的地方）'),
          ...d.frameIssues.map((x, i) => h('div', {
            key: i,
            style: { fontSize: 11.5, lineHeight: 18, color: x.level === 'error' ? '#ef4444' : '#eab308' },
          }, `${x.level === 'error' ? '✗' : '!'} ${x.where ? x.where + '：' : ''}${x.msg}`)),
        ])
        : null

      const speeches = (d.recent || []).length
        ? h('div', { key: 'talk', 'data-cb-card': '' }, [
          h('div', { key: 'h', 'data-cb-h': '' }, '发言（最近 ' + d.recent.length + ' 条）'),
          ...d.recent.map((s, i) => h('div', { key: i, 'data-cb-say': '' }, [
            h('div', { key: 'w', 'data-cb-who': '' }, [
              h('b', { key: 'l' }, s.label || s.seat),
              h('span', { key: 'm', 'data-dim': '' }, (s.model || '').split('/').pop()),
              h('span', { key: 't', 'data-dim': '' }, fmtTime(s.at)),
            ]),
            h('div', { key: 'x', 'data-cb-say-text': '' }, s.text),
          ])),
        ])
        : h('div', { key: 'talk', 'data-cb-card': '' }, h('div', { 'data-cb-empty': '' }, '还没有人开口。'))

      const delivered = d.delivered
        ? h('div', { key: 'dl', 'data-cb-card': '' }, [
          h('div', { key: 'h', 'data-cb-h': '' }, '交付'),
          h('div', { key: 's', 'data-cb-note': '' }, d.delivered.summary || ''),
          h('div', { key: 'f', 'data-cb-note': '', style: { fontFamily: 'ui-monospace,Menlo,monospace' } }, (d.delivered.files || []).join('\n')),
        ])
        : null

      return h('div', { 'data-cb-room': '' }, [
        head,
        h('div', { key: 'topic', style: { fontSize: 14, lineHeight: 22, fontWeight: 600 } }, d.topic || '（无议题）'),
        d.paused ? h('div', { key: 'pz', 'data-cb-note': '' }, '⚠️ 上一回合' + d.paused + '—— 对话里说一句「继续」就能接上。') : null,
        d.pendingAsk ? h('div', { key: 'pa', 'data-cb-note': '' }, `留给 ${d.speaker} 的问题：${d.pendingAsk.ask || ''}`) : null,
        seatsRow,
        actsBlock,
        propBlock,
        frameIssues,
        modBlock,
        delivered,
        speeches,
        msg ? h('div', { key: 'm', 'data-cb-msg': '', 'data-bad': msg.bad ? '' : undefined, 'data-good': msg.good ? '' : undefined }, msg.text) : null,
        h('div', { key: 'sid', 'data-cb-note': '' }, '会话 ' + String(d.sessionId).slice(0, 8) + ' · 每 2 秒自动刷新'),
      ])
    }

    const CabinetIcon = (props) => {
      const size = (props && props.size) || 16
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
      }, [
        h('circle', { key: 'a', cx: 12, cy: 5.6, r: 2.2 }),
        h('circle', { key: 'b', cx: 4.9, cy: 11.6, r: 1.9 }),
        h('circle', { key: 'c', cx: 19.1, cy: 11.6, r: 1.9 }),
        h('rect', { key: 'd', x: 6, y: 15, width: 12, height: 3.8, rx: 1.9 }),
      ])
    }

    // 会话内方案卡：cabinet_propose 这一条工具调用直接渲染成可点的方案列表，
    // 让用户在当前对话里挑，而不是切到侧栏面板去挑。
    const ProposalPicker = (props) => {
      useStyle()
      const sid = String(props?.sessionId || '')
      const [st, setSt] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [err, setErr] = React.useState(null)
      const [local, setLocal] = React.useState(null)

      React.useEffect(() => {
        let alive = true
        jget('/state').then((j) => { if (alive) setSt(j) }).catch((e) => { if (alive) setErr(e.message) })
        return () => { alive = false }
      }, [])

      const all = (st && st.debates) || []
      // 优先按 sessionId 精确对；对不上（历史消息、别的会话）就退到"最近一场有方案的会"
      const mine = all.find((d) => String(d.sessionId) === sid)
        || all.filter((d) => Array.isArray(d.proposals) && d.proposals.length)
          .sort((a, b) => (b.status === 'proposed' ? 1 : 0) - (a.status === 'proposed' ? 1 : 0))[0]
      const d = mine
      const decision = local || (d && d.decision) || null
      if (err) return null
      if (!d || !Array.isArray(d.proposals) || !d.proposals.length) return null

      const choose = async (n) => {
        setBusy(true)
        try {
          const r = await jpost('/decide', { sessionId: d.sessionId, n, via: 'chat' })
          if (!r.ok) throw new Error(r.error || '选定失败')
          setLocal(r.decision)
          setErr(null)
        } catch (e) {
          setErr(e.message)
        } finally { setBusy(false) }
      }

      return h('div', { 'data-cb-pick': '' }, [
        h('div', { key: 'h', 'data-cb-pick-head': '' }, [
          h('b', { key: 't' }, decision ? '方案已定' : '内阁出方案了 · 挑一个'),
          h('span', { key: 's' }, `议题：${d.topic || '（未记录）'}　${d.proposals.length} 个方案`),
        ]),
        ...d.proposals.map((p) => {
          const on = decision && Number(decision.n) === Number(p.n)
          const dim = decision && !on
          return h('div', {
            key: 'p' + p.n,
            'data-cb-pick-item': '',
            'data-on': on ? '' : undefined,
            style: dim ? { opacity: .5 } : undefined,
          }, [
            h('div', { key: 't', 'data-cb-pick-t': '' }, [
              h('span', { key: 'n' }, `${p.n}. ${p.title}`),
              p.stance ? h('span', { key: 'g', 'data-cb-pick-tag': '' }, p.stance) : null,
            ]),
            p.summary ? h('div', { key: 's', 'data-cb-pick-s': '' }, p.summary) : null,
            p.pros ? h('div', { key: 'a', 'data-cb-pick-m': '' }, '✅ ' + p.pros) : null,
            p.cons ? h('div', { key: 'b', 'data-cb-pick-m': '' }, '⚠ ' + p.cons) : null,
            h('div', { key: 'act', 'data-cb-pick-act': '' }, [
              on
                ? h('span', { key: 'ok', 'data-cb-pick-note': '' }, '已选这个')
                : h('button', {
                  key: 'btn', 'data-cb-btn': '',
                  disabled: busy || !!decision,
                  onClick: () => choose(p.n),
                }, busy ? '…' : '选这个'),
            ]),
          ])
        }),
        h('div', { key: 'f', 'data-cb-pick-act': '' }, [
          h('span', { key: 'n', 'data-cb-pick-note': '' }, decision
            ? '选好了 —— 回对话说一句「继续」，首辅就照这个方案写框架。'
            : '也可以直接回一句「选 2」，同样算数。'),
          err ? h('span', { key: 'e', 'data-cb-pick-note': '', style: { color: '#ef4444' } }, err) : null,
        ]),
      ])
    }

    return {
      inject: [],
      apply(ctx) {
        const slots = ctx.get('slots')
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'cabinet', order: 31, label: '内阁' },
          () => h(Panel),
        ))
        slots.inject('sidebar.panellist', () => slots.register(
          { name: 'sidebar.panellist', id: 'cabinet', order: 20, label: '内阁' },
          () => h(CabinetIcon),
        ))
        slots.inject('main', () => slots.register(
          { name: 'main', key: 'cabinet' },
          () => h(Room),
        ))
        // 方案卡：cabinet_propose 那条工具调用在对话里直接渲染成可选列表
        slots.inject('tool.call.toolview', () => slots.register(
          { name: 'tool.call.toolview', key: 'cabinet_propose' },
          () => h(ProposalPicker),
        ))
      },
    }
  },
})