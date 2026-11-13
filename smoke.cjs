/* 一次性冒烟：把 client.js 的组件在有数据的情况下真的执行一遍（不渲染 DOM）。
 * 目的不是替代浏览器，而是把 h() 嵌套里的错名/错字段在 node 里先炸出来。 */
const fs = require('fs')
const path = require('path')

const SRC = path.join(__dirname, 'client.js')
const payload = JSON.parse(fs.readFileSync(path.join(__dirname, 'samples', 'state.json'), 'utf8').replace(/^\uFEFF/, ''))

let mod = null
global.window = { __ModuleLoader__: { load: (o) => { mod = o } } }

const queue = []
const h = (type, props, ...kids) => {
  const p = Object.assign({}, props || {})
  if (kids.length === 1) p.children = kids[0]
  else if (kids.length > 1) p.children = kids
  return { type, props: p, kids }
}
const React = {
  createElement: h,
  useState: (init) => {
    const v = queue.length ? queue.shift() : (typeof init === 'function' ? init() : init)
    return [v, () => {}]
  },
  useEffect: () => {},
  useMemo: (f) => f(),
  useCallback: (f) => f,
  useRef: (v) => ({ current: v }),
}
global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })

// 加载客户端脚本（它只调 window.__ModuleLoader__.load）
new Function('require', 'window', 'document', 'globalThis', fs.readFileSync(SRC, 'utf8'))(
  (name) => (name === 'react' ? React : require(name)),
  global.window,
  { getElementById: () => null, createElement: () => ({ set textContent(v) {}, set id(v) {} }), head: { appendChild() {} } },
  globalThis,
)
if (!mod) throw new Error('client.js 没有调用 __ModuleLoader__.load')
console.log('id =', mod.id)

const regs = []
const slots = {
  inject: (_slot, fn) => fn(),
  register: (meta, comp) => { regs.push({ meta, comp }); return () => {} },
}
const api = mod.factory((name) => (name === 'react' ? React : require(name)))
api.apply({ get: (k) => (k === 'slots' ? slots : null) })
console.log('registrations =', regs.map((r) => JSON.stringify(r.meta)).join('  '))

const walk = (v, depth = 0) => {
  if (v == null || v === false || v === true) return 0
  if (Array.isArray(v)) return v.reduce((n, x) => n + walk(x, depth), 0)
  if (typeof v === 'string' || typeof v === 'number') return 1
  if (typeof v === 'object' && v.type) {
    if (typeof v.type === 'function') {
      const fn = v.type
      const props = Object.assign({ size: 16, active: false }, v.props)
      return walk(fn(props), depth + 1)
    }
    return walk(v.props.children, depth + 1)
  }
  return 0
}

const run = (label, dataArr) => {
  queue.length = 0
  queue.push(...dataArr)
  const room = regs.find((r) => r.meta.name === 'main')
  const el = room.comp()
  const n = walk(el)
  console.log(`✓ ${label} → ${n} 个节点`)
}

const withData = payload.debates.map((d) => ({ ...d, recent: d.recent || [], dispatch: d.dispatch }))
run('有进行中的会场（真实 /state 数据）', [payload, null, null, false, null])
run('没有会场', [{ ok: true, build: 'x', debates: [] }, null, null, false, null])
run('还在读', [null, null, null, false, null])
run('读失败', [null, 'HTTP 500', null, false, null])
run('delivered 会场', [{ ok: true, build: 'x', debates: [Object.assign({}, withData[0] || {}, { status: 'delivered', dispatch: null, delivered: { summary: 's', files: ['a.js'] } })] }, null, null, false, null])
run('blocked + 模块表', [{ ok: true, build: 'x', debates: [{ sessionId: 's', topic: 't', status: 'blocked', speaker: '内阁首辅', speakerId: 'chair', seats: [{ id: 's1', label: 'A', model: 'p/m' }], proposals: [{ title: '甲' }], decision: null, frameIssues: [{ level: 'error', where: 'a', msg: 'x' }], dispatch: { cwd: '/x', modules: [{ id: 'a', seat: 's1', status: 'blocked', rework: 1, files: ['a.js'], issues: [{ level: 'error', msg: 'boom' }], audit: { verdict: 'ok', by: 'B' } }] }, recent: [{ label: 'A', model: 'p/m', text: 'hi', at: Date.now() }] }] }, null, null, false, null])
console.log('smoke ok')

// ── 设置页：model 下拉框不能出现空白项 ────────────────────────────────
const models = JSON.parse(fs.readFileSync(path.join(__dirname, 'samples', 'models.json'), 'utf8').replace(/^\uFEFF/, ''))
const seatSeed = [
  { id: 's1', label: '务实派', skill: 'x', provider: 'qwen-token-plan-cn', model: 'deepseek-v4-pro' },
  { id: 's2', label: '挑刺派', skill: 'y', provider: 'deepseek-official', model: 'no-such-model' },
  { id: 's3', label: '奇想派', skill: 'z', provider: 'qwen-token-plan-cn', model: '' },
]
queue.length = 0
queue.push(seatSeed, '内阁首辅', models.providers, null, false, true)
const settings = regs.find((r) => r.meta.name === 'settings.section')
const panelTree = settings.comp()

const options = []
const collect = (v) => {
  if (v == null || typeof v === 'boolean') return
  if (Array.isArray(v)) return v.forEach(collect)
  if (typeof v === 'object' && v.type) {
    if (v.type === 'option') options.push(v)
    if (typeof v.type === 'function') return collect(v.type(v.props))
    return collect(v.props.children)
  }
}
collect(panelTree)
const labelOf = (o) => {
  const c = o.props.children
  return Array.isArray(c) ? c.join('') : String(c == null ? '' : c)
}
const blank = options.filter((o) => !labelOf(o).trim() || String(o.props.value || '').trim() === '')
console.log(`设置页 option 数 = ${options.length}`)
console.log('前 6 个：' + options.slice(0, 6).map((o) => `${o.props.value}=${labelOf(o)}`).join(' | '))
console.log('provider 选项：' + options.filter((o) => ['deepseek-official', 'deepseek-account', 'qwen-token-plan-cn'].includes(String(o.props.value))).map((o) => labelOf(o)).join(' | '))
if (blank.length) { console.log('✗ 有空白 option：' + JSON.stringify(blank.map((o) => o.props))); process.exit(1) }
console.log('✓ 没有空白 option（含"当前值不在列表"的兜底项）')

// ── 会话内方案卡：cabinet_propose 的 tool.call.toolview ────────────────
const tv = regs.find((r) => r.meta.name === 'tool.call.toolview')
if (!tv) throw new Error('没有注册 tool.call.toolview')
console.log('toolview key = ' + tv.meta.key)
const fakeState = {
  ok: true,
  debates: [{
    sessionId: 'session-x', topic: '给插件写一份介绍', status: 'proposed',
    proposals: [
      { n: 1, title: '一条时间轴', stance: '奇想派', summary: '单页 HTML + SVG 时间轴', pros: '一眼看懂', cons: '信息密度高' },
      { n: 2, title: '手册流', stance: '务实派', summary: 'Markdown 长文', pros: '好写', cons: '没人读' },
    ],
    decision: null,
  }],
}
const runPick = (label, st, seed, expect) => {
  queue.length = 0
  queue.push(st, ...seed)
  const tree = tv.comp({ sessionId: 'session-x', phase: 'result', block: {} })
  // 一次遍历同时数节点、收文本 —— 组件函数只能调一次（hook 队列会被消耗光）
  const texts = []
  const collect = (v) => {
    if (v == null || v === false || v === true) return 0
    if (Array.isArray(v)) return v.reduce((n, x) => n + collect(x), 0)
    if (typeof v === 'string' || typeof v === 'number') { texts.push(String(v)); return 1 }
    if (typeof v === 'object' && v.type) {
      if (typeof v.type === 'function') return collect(v.type(Object.assign({ size: 16, active: false }, v.props)))
      return collect(v.props.children)
    }
    return 0
  }
  const n = collect(tree)
  const hasPick = texts.some((t) => t === '选这个')
  const picked = texts.some((t) => t === '已选这个')
  const hasTimeline = texts.some((t) => t.includes('一条时间轴'))
  console.log(`✓ ${label} → ${n} 个节点，按钮=${hasPick}，已选标记=${picked}，含"一条时间轴"=${hasTimeline}`)
  if (expect === 'empty') {
    if (n !== 0) { console.log('✗ 没有方案时不该渲染卡片'); process.exit(1) }
    return
  }
  if (n === 0 || !hasPick || !hasTimeline) { console.log('✗ 方案卡没渲染出可选按钮'); process.exit(1) }
}
runPick('方案卡（待选）', fakeState, [false, null, null], 'pick')
runPick('方案卡（已选 1）', { ok: true, debates: [{ ...fakeState.debates[0], status: 'decided', decision: { n: 1, title: '一条时间轴' } }] }, [false, null, null], 'pick')
runPick('方案卡（还没有方案）', { ok: true, debates: [{ sessionId: 'session-x', topic: 't', status: 'debate', proposals: null }] }, [false, null, null], 'empty')