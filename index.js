/**
 * dsh-cabinet —— host 半端（「内阁」）
 * ============================================================================
 * 一条对话 = 一个房间。里面坐着一个首辅（= 会话自己的模型）和若干阁员（各自不同的模型）。
 *
 *   · 谁在说话 = 「当前发言人」；每次模型调用前（`agent/request` 瀑布）按发言人
 *     把 provider/model 换掉 —— 所以每条回复在会话里都自带"谁说的"归属。
 *   · 同一个会话 = 同一份上下文 ⇒ 后说的人**看得见**前面所有人说过的话。
 *     这就是"房间"：不是轮流念稿，是接着上一个人的话往下打。
 *   · 没人被限定只能讲一次。想反驳谁就点谁的名，交棒时给下一位留一个必须回答的问题。
 *   · 首辅不写稿、不总结陈词；它负责**挑事**：指出谁和谁在哪儿对不上，逼人回应。
 *   · 吵够了就收敛成 2–3 个方案，每个方案对应一派立场，交给用户挑。
 *
 * 关键实现约束（踩过的坑，改代码前先读）：
 *   1. `assistant/message` / `turn/end` / `user/message` **不在**宿主事件总线上，
 *      只能从 `session/event`（提交后的追加流）拿到。
 *   2. 换人时不要 `delete cfg.reasoningEffort` —— 适配器会把它翻译成 enable_thinking:false，
 *      有的模型直接 400。要问 `llm.resolveModelInfo()` 该模型支持哪些档位再定。
 *   3. 模型忘了交棒时 `agent.followup()` 实测唤不醒，所以会场状态必须常驻系统提示。
 * ============================================================================
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'cabinet'
export const inject = ['tools', 'systemPrompt', 'webServer']

const HOME = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'cabinet')
/** 打包号：只在需要确认宿主是否重载了本模块时才有用（GET /api/cabinet/state 会带出来） */
const BUILD = '0.8.6'
const SEATS_FILE = join(HOME, 'seats.json')
const DEBATES_FILE = join(HOME, 'debates.json')
const MAX_SEATS = 8
/** 一场议政最多允许发言几次（防跑飞；正常收敛远用不到） */
const MAX_SPEECHES = 40
/** 每个人至少说过几次，才允许首辅收口出方案（不够就还得再吵） */
const MIN_SPEECHES_BEFORE_PROPOSE = 3
/** 阁员忘了交棒时，最多替他补几次"把话筒交出去"的催促（防死循环） */
const MAX_NUDGES = 8
/** 单个模块返工上限：超过就停下问人，不许首辅自己无限重派（默认值 2，用户拍过板） */
const MAX_REWORK = 2
/** 议政发言中的阁员还能用哪些工具：说话、交棒、查资料 —— 除此之外一律不许（改文件、派活、出方案都是首辅/用户的事） */
const MEMBER_TOOLS = new Set(['cabinet_pass', 'cabinet_status', 'read', 'grep', 'glob', 'web_search', 'web_fetch'])

/* ──────────────────────────── 席位配置（落盘） ──────────────────────────── */

function ensureHome() {
  try { mkdirSync(HOME, { recursive: true }) } catch { /* 忽略 */ }
}

function normalizeSeats(raw) {
  const list = Array.isArray(raw?.seats) ? raw.seats : []
  return {
    chairLabel: typeof raw?.chairLabel === 'string' && raw.chairLabel.trim() ? raw.chairLabel.trim() : '内阁首辅',
    seats: list
      .filter((s) => s && s.provider && s.model)
      .slice(0, MAX_SEATS)
      .map((s, i) => ({
        id: String(s.id || `s${i + 1}`),
        label: String(s.label || `阁员${i + 1}`),
        skill: String(s.skill || ''),
        provider: String(s.provider),
        model: String(s.model),
        reasoningEffort: s.reasoningEffort ? String(s.reasoningEffort) : null,
      })),
  }
}

function loadSeats() {
  ensureHome()
  try {
    // 去掉 BOM：Windows 上用 PowerShell 的 Set-Content / 记事本改过这个文件，开头会带 U+FEFF，
    // 直接 JSON.parse 会抛"Unexpected token"，然后整份席位配置被当成空 → 开会时说"0 位阁员"。
    const raw = readFileSync(SEATS_FILE, 'utf8').replace(/^\uFEFF/, '')
    return normalizeSeats(JSON.parse(raw))
  } catch { return normalizeSeats(null) }
}

function saveSeats(value) {
  ensureHome()
  const clean = normalizeSeats(value)
  writeFileSync(SEATS_FILE, JSON.stringify(clean, null, 2) + '\n', 'utf8')
  return clean
}

/* ──────────────────────────── 会场状态 ──────────────────────────── */

/**
 * sessionId -> 会场
 * {
 *   topic, seats, chairLabel,
 *   speaker,           // 'chair' | 席位 id  —— 决定下一次请求用谁的模型
 *   pendingAsk,        // { from, ask } 上一位留给当前发言人的问题
 *   paused,            // { seat, label, at } 有人端着话筒把回合结束了
 *   status,            // debate | proposed | decided | framed | dispatched | running | blocked | integrating | delivered | closed
 *   speeches: [{ seat, label, model, text, at }],
 *   proposals, decision, contract, frameIssues, dispatch, delivered, nudges, notes, touchedAt,
 * }
 * 会场落盘到 $DSH_HOME/cabinet/debates.json（只存纯数据；Agent 引用另放内存里的 agents）。
 * 宿主重载后能接着开，不会像 0.5.3 之前那样"重载一次，在飞的会全丢"。
 */
const debates = new Map()
/** agentKey → Agent（只在 agent/request 里能拿到；补催交棒时要用它唤醒回合） */
const agents = new Map()
/** 最近 40 次"换模型"的判断记录 —— 只给诊断用：为什么这一次没换成 */
const reqLog = []

const agentKey = (agent) => String(agent?.id ?? agent?.session?.id ?? agent ?? '') || 'default'

/** 只留能 JSON 化的字段：这是"能重开"和"会炸"的分界线 */
function plainDebate(d) {
  return {
    topic: d.topic,
    seats: d.seats,
    chairLabel: d.chairLabel,
    chairCfg: d.chairCfg ?? null,
    speaker: d.speaker,
    pendingAsk: d.pendingAsk ?? null,
    paused: d.paused ?? null,
    status: d.status,
    speeches: (d.speeches || []).slice(-200),
    proposals: d.proposals ?? null,
    decision: d.decision ?? null,
    contract: d.contract ?? null,
    frameIssues: d.frameIssues ?? null,
    dispatch: d.dispatch ?? null,
    delivered: d.delivered ?? null,
    cwd: d.cwd ?? null,
    nudges: d.nudges || 0,
    notes: (d.notes || []).slice(-40),
    touchedAt: d.touchedAt || 0,
  }
}

let saveTimer = null
function persistSoon() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      ensureHome()
      const out = { version: 1, savedAt: Date.now(), debates: {} }
      for (const [k, d] of debates) out.debates[k] = plainDebate(d)
      writeFileSync(DEBATES_FILE, JSON.stringify(out), 'utf8')
    } catch { /* 落盘失败不该影响开会 */ }
  }, 400)
  saveTimer.unref?.()
}

function loadDebates() {
  ensureHome()
  let raw
  try { raw = JSON.parse(readFileSync(DEBATES_FILE, 'utf8').replace(/^\uFEFF/, '')) } catch { return }
  const map = raw?.debates
  if (!map || typeof map !== 'object') return
  const now = Date.now()
  let n = 0
  for (const [k, v] of Object.entries(map)) {
    if (!v || typeof v !== 'object' || !v.topic) continue
    // 6 小时没动静的旧会不再恢复：它们只会把无关请求的模型换掉
    if (v.status !== 'closed' && now - (v.touchedAt || 0) > 6 * 60 * 60 * 1000) continue
    debates.set(k, {
      ...v,
      speeches: Array.isArray(v.speeches) ? v.speeches : [],
      notes: Array.isArray(v.notes) ? v.notes : [],
      seats: Array.isArray(v.seats) ? v.seats : [],
      dispatch: v.dispatch && typeof v.dispatch === 'object' ? v.dispatch : null,
      turnAlive: false,
    })
    n++
  }
  if (n) console.log(`[cabinet] 恢复了 ${n} 场会场（宿主重载前开的会可以接着说）`)
}

function debateOf(agent) {
  const key = agentKey(agent)
  const d = key ? debates.get(key) : null
  if (!d) return null
  // 30 分钟没人动过就作废：否则残留的旧会场会把无关请求的模型换掉
  if (d.status !== 'closed' && Date.now() - (d.touchedAt || 0) > 30 * 60 * 1000) {
    d.status = 'closed'
    return null
  }
  return d
}

const speakerSeat = (d) => (d && d.speaker && d.speaker !== 'chair' ? d.seats.find((s) => s.id === d.speaker) : null)

function whoLabel(d) {
  if (!d) return ''
  if (d.speaker === 'chair') return d.chairLabel
  return d.seats.find((s) => s.id === d.speaker)?.label || d.speaker
}

const seatLine = (s) => `- 【${s.label}】id=${s.id}${s.skill ? ` 擅长：${s.skill}` : ''}（${s.provider} / ${s.model}）`
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n)

/** 给首辅看的"刚才谁说了什么"——首辅要靠这个挑事，不能靠自己回忆 */
function digest(d, n = 4) {
  const last = d.speeches.slice(-n)
  if (!last.length) return ''
  return [
    '刚才房间里说过的话（摘要，全文你自己往上翻）：',
    ...last.map((s) => `· ${s.label}：${clip(s.text, 140)}`),
  ].join('\n')
}

/** 每个席位说过几次，用来判断"是不是有人还没被挑战过" */
function speechCounts(d) {
  const c = new Map()
  for (const s of d.speeches) c.set(s.seat, (c.get(s.seat) || 0) + 1)
  return d.seats.map((s) => `${s.label}×${c.get(s.id) || 0}`).join('　')
}

/** 下一个该谁接话：优先说最少的人，且不把话筒递回刚刚说完的那个 */
function pickNext(d, exceptId) {
  const c = new Map()
  for (const s of d.speeches) c.set(s.seat, (c.get(s.seat) || 0) + 1)
  const pool = d.seats.filter((s) => s.id !== exceptId)
  if (!pool.length) return null
  return pool.reduce((a, b) => ((c.get(a.id) || 0) <= (c.get(b.id) || 0) ? a : b))
}

/** 每个阁老此刻在干什么 —— 面板上那排"活动卡"就靠这个。
 *  用户的原话是"工作开始时，ui 里面会出现一些小卡片告诉你各个阁老正在干什么"，
 *  所以这里只输出人话（doing）+ 一个机器可读的 state，不要让前端自己猜。 */
function seatActivityOf(d) {
  if (!d || !Array.isArray(d.seats)) return []
  const spoke = new Map()
  const lastAt = new Map()
  for (const s of d.speeches || []) {
    spoke.set(s.seat, (spoke.get(s.seat) || 0) + 1)
    if (!lastAt.get(s.seat) || s.at > lastAt.get(s.seat)) lastAt.set(s.seat, s.at)
  }
  const mods = d.dispatch ? Object.values(d.dispatch.modules || {}) : []
  const decl = (d.contract && Array.isArray(d.contract.modules)) ? d.contract.modules : []
  const titleOf = (m) => ((decl.find((c) => c.id === m.id) || {}).title) || m.id

  return (d.seats || []).map((s) => {
    const mine = mods.filter((m) => m.seat === s.id)
    const card = {
      id: s.id, label: s.label, skill: s.skill || '',
      provider: s.provider, model: s.model,
      speaks: spoke.get(s.id) || 0, lastAt: lastAt.get(s.id) || null,
      state: 'idle', doing: '待命', module: '', modules: [], child: '', since: null,
    }

    // ① 派过活就看模块（比"谁在发言"更接近真相）
    const run = mine.find((m) => m.status === 'running')
    if (run) {
      card.state = 'working'
      card.module = run.id
      card.doing = `正在写 ${titleOf(run)}`
      card.child = String(run.childId || '')
      card.since = d.dispatch?.startedAt || null
      return card
    }
    const bad = mine.find((m) => m.status === 'blocked')
    if (bad) {
      card.state = 'blocked'
      card.module = bad.id
      card.doing = `卡在 ${titleOf(bad)}`
      card.child = String(bad.childId || '')
      return card
    }
    const done = mine.filter((m) => m.status === 'done')
    if (mine.length && done.length === mine.length) {
      card.state = 'done'
      card.module = done.map((m) => m.id).join(',')
      card.modules = done.map((m) => m.id)
      card.doing = `已交 ${done.map((m) => titleOf(m)).join('、')}`
      return card
    }
    if (mine.length) {
      card.state = 'waiting'
      card.module = mine[0].id
      card.doing = `等别人先交，再写 ${titleOf(mine[0])}`
      return card
    }

    // ② 议政阶段：话筒在谁手上谁就是"正在说话"
    if (d.status === 'debate') {
      if (d.speaker === s.id) { card.state = 'speaking'; card.doing = '正在发言' }
      else { card.state = 'listening'; card.doing = '在听，等话筒' }
      return card
    }
    if (d.status === 'proposed') { card.state = 'idle'; card.doing = '方案已摆出，等用户挑' }
    else if (d.status === 'framed' || d.status === 'decided') { card.state = 'waiting'; card.doing = '框架还没派活' }
    else if (d.status === 'delivered') { card.state = 'done'; card.doing = '已交付' }
    else if (d.status === 'closed') { card.state = 'idle'; card.doing = '散会了' }
    return card
  })
}

/** 会场里的小事件（催交棒、失败原因）：只留最近 20 条，/state 里能看 */
function note(d, msg) {
  if (!d) return
  if (!Array.isArray(d.notes)) d.notes = []
  d.notes.push({ at: Date.now(), msg: String(msg) })
  if (d.notes.length > 20) d.notes.splice(0, d.notes.length - 20)
}

/* ──────────────────────── 席位体检：能不能真的上场 ────────────────────────
 * 只在开会前查 provider/model 是否存在。注意：这个检查查不出版权问题 ——
 * 席位指向一个"没登录的账号型 provider"（如 deepseek-account）时，这里完全正常，
 * 直到换模型那一步整个回合才会挂掉。所以文档里反复强调：用当前对话在用的那个 provider。
 */
async function vetSeats(ctx, seats) {
  const llm = ctx.get?.('llm')
  if (!llm || typeof llm.listProviders !== 'function') return { seats, bad: [] }
  try {
    const provs = await Promise.resolve(llm.listProviders() ?? [])
    const ids = new Set((provs || []).map((p) => String(p?.provider ?? p?.id ?? p?.name ?? '')).filter(Boolean))
    const ok = []
    const bad = []
    for (const s of seats) {
      if (ids.size && !ids.has(s.provider)) { bad.push(`${s.label}（没有 provider ${s.provider}）`); continue }
      let models = []
      try { models = await Promise.resolve(llm.listModels?.(s.provider) ?? []) } catch { models = [] }
      const mids = new Set((models || []).map((m) => String(m?.id ?? m?.model ?? m)).filter(Boolean))
      if (mids.size && !mids.has(s.model)) { bad.push(`${s.label}（${s.provider} 下没有模型 ${s.model}）`); continue }
      ok.push(s)
    }
    return { seats: ok, bad }
  } catch { return { seats, bad: [] } }
}

/** 用户当场点名的模型 → 它属于哪个 provider：先在设置页那几位用过的 provider 里找，找不到再全网扫。
 *  为什么要这一步：模型名是全局的，provider 是局部的；用户只会说"用 glm-5.3"，不会说它在哪个 provider 下。 */
async function providerForModel(ctx, model, prefer) {
  const want = String(model || '')
  if (!want) return ''
  const llm = ctx.get?.('llm')
  let provs = []
  try { provs = (await Promise.resolve(llm?.listProviders?.() ?? [])) || [] } catch { provs = [] }
  const ids = (provs || []).map((p) => String(p?.provider ?? p?.id ?? p?.name ?? '')).filter(Boolean)
  const ordered = [...(prefer || []).filter((x) => ids.includes(x)), ...ids.filter((x) => !(prefer || []).includes(x))]
  for (const pid of ordered) {
    let models = []
    try { models = (await Promise.resolve(llm?.listModels?.(pid) ?? [])) || [] } catch { models = [] }
    if ((models || []).some((x) => String(x?.id ?? x?.model ?? x) === want)) return pid
  }
  return ''
}

/* ──────────────────── 换人时的"思考强度"怎么定 ────────────────────
 * 这里的坑是同一个字段两头都会炸：
 *   - 原样删掉 reasoningEffort → 适配器按"关掉思考"下发 enable_thinking:false，
 *     glm-5.3 直接 400「The value of the enable_thinking parameter is restricted to True」；
 *   - 原样继承会话的 high → qwen3.8-max 直接报 UNSUPPORTED_REASONING_EFFORT。
 * 所以不能猜，要问宿主：llm.resolveModelInfo(p, m) 会给出 reasoning.efforts 与 defaultEffort。
 * 规则：席位显式指定且该模型支持 → 用它；否则用该模型自己的档位；模型完全不带 reasoning
 * 元数据 → 不带这个字段（普通模型没有思考开关）。
 */
const modelInfoCache = new Map()

async function modelInfoOf(ctx, provider, model) {
  const key = `${provider}/${model}`
  if (modelInfoCache.has(key)) return modelInfoCache.get(key)
  let info = null
  try {
    const llm = ctx.get?.('llm')
    info = (await Promise.resolve(llm?.resolveModelInfo?.(provider, model))) || null
  } catch { info = null }
  modelInfoCache.set(key, info)
  return info
}

function effortIds(info) {
  const efforts = info?.reasoning?.efforts
  return Array.isArray(efforts) ? efforts.map((e) => String(e?.id ?? e)).filter(Boolean) : []
}

async function configForSeat(ctx, cfg, seat) {
  const out = { ...cfg, provider: seat.provider, model: seat.model }
  const info = await modelInfoOf(ctx, seat.provider, seat.model)
  const ids = effortIds(info)
  const want = seat.reasoningEffort || cfg.reasoningEffort
  if (want && ids.includes(String(want))) {
    out.reasoningEffort = want
  } else if (info?.reasoning) {
    // 会话的 high 这个模型不支持 → 退到它自己档位里最接近"认真想"的一档
    const PREFER = ['high', 'xhigh', 'max', 'medium', 'low']
    const def = info.reasoning.defaultEffort || PREFER.find((x) => ids.includes(x)) || ids[0]
    if (def) out.reasoningEffort = def
    else delete out.reasoningEffort
  } else if (!info && seat.reasoningEffort) {
    out.reasoningEffort = seat.reasoningEffort // 查不到元数据但用户显式指定 → 尊重用户
  } else {
    delete out.reasoningEffort
  }
  return out
}

/**
 * 给"独立子会话"算一份 agentOptions。
 *
 * 这是踩过坑的：子会话只带 `{provider, model}` 时，`reasoningEffort` 是空的，
 * 适配器就把 `enable_thinking` 发成 false —— glm-5.3 直接 400
 * （"The value of the enable_thinking parameter is restricted to True."），
 * 整个子会话 `stopReason=error`，活没干、回执也没有。
 * 所以派活前必须像议政里换人一样，按模型能力把党位档位显式写进去。
 */
async function seatAgentOptions(ctx, seat) {
  const out = { provider: seat.provider, model: seat.model }
  const info = await modelInfoOf(ctx, seat.provider, seat.model)
  const ids = effortIds(info)
  const want = seat.reasoningEffort ? String(seat.reasoningEffort) : ''
  if (want && ids.includes(want)) {
    out.reasoningEffort = want
  } else if (info?.reasoning) {
    const PREFER = ['high', 'xhigh', 'max', 'medium', 'low']
    const def = info.reasoning.defaultEffort || PREFER.find((x) => ids.includes(x)) || ids[0]
    if (def) out.reasoningEffort = def
  } else if (want) {
    out.reasoningEffort = want
  }
  return out
}

/* ══════════════════════ 二期：框架 → 分工 → 并行 → 拼接 ══════════════════════
 * 并行干活最容易死在"各干各的、拼不上"。所以开工前先把「写哪里、交什么、依赖谁」
 * 写成数据（contract），这些检查全是纯函数、不花模型钱 —— 能机械查出来的，绝不问模型。
 */

const normPath = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
/** 把 `src/render/**` 这种写域收敛成目录前缀 `src/render` */
const globRoot = (g) => normPath(g).replace(/\/\*\*?$/, '').replace(/\*.*$/, '').replace(/\/$/, '')

function overlap(a, b) {
  const A = globRoot(a)
  const B = globRoot(b)
  if (!A || !B) return false
  return A === B || A.startsWith(`${B}/`) || B.startsWith(`${A}/`)
}

function inside(file, glob) {
  const f = normPath(file)
  const g = globRoot(glob)
  return !!g && (f === g || f.startsWith(`${g}/`))
}

/** 出口/依赖能不能被机械地验收：只认 file 与 symbol 两种 kind */
function exportKeys(mod) {
  const out = []
  for (const e of Array.isArray(mod?.exports) ? mod.exports : []) {
    if (!e) continue
    if (e.kind === 'file' && e.path) out.push(`file:${normPath(e.path)}`)
    if (e.kind === 'symbol' && e.name) out.push(`symbol:${String(e.name)}`)
  }
  return out
}

function findModule(contract, id) {
  return (contract?.modules || []).find((m) => String(m?.id) === String(id)) || null
}

/** 开工前 5 项静态检查。返回 [{ level:'error'|'warn', msg, where }] */
function checkContract(contract) {
  const issues = []
  const bad = (where, msg) => issues.push({ level: 'error', where, msg })
  const mods = Array.isArray(contract?.modules) ? contract.modules : []
  if (!mods.length) bad('contract', '没有任何模块：至少要有 1 个')
  if (!contract?.integration?.entry) bad('contract', '缺少 integration.entry（最终接在哪个文件）')

  // 1) 写域两两不相交
  for (let i = 0; i < mods.length; i++) {
    for (let j = i + 1; j < mods.length; j++) {
      for (const a of mods[i].writes || []) {
        for (const b of mods[j].writes || []) {
          if (overlap(a, b)) bad(`${mods[i].id}/${mods[j].id}`, `写域重叠：「${mods[i].id}」的 ${a} 与「${mods[j].id}」的 ${b} 会互相覆盖（并行安全的前提是写域不相交）`)
        }
      }
    }
  }

  // 2) 依赖可满足：imports 指向真实模块，且对方 exports 真有该 symbol/file
  for (const m of mods) {
    for (const imp of m.imports || []) {
      const target = findModule(contract, imp?.from)
      if (!target) { bad(m.id, `依赖的模块 "${imp?.from}" 不存在`); continue }
      const keys = exportKeys(target)
      if (imp.symbol && !keys.includes(`symbol:${imp.symbol}`) && !keys.includes(`file:${normPath(imp.symbol)}`)) {
        bad(m.id, `依赖 ${imp.from} 的 "${imp.symbol}"，但它没有在 exports 里承诺这个出口`)
      }
    }
  }

  // 3) 导出路径落在自己的写域里
  for (const m of mods) {
    for (const e of m.exports || []) {
      if (e?.kind !== 'file' || !e.path) continue
      const own = (m.writes || []).some((w) => inside(e.path, w))
      if (!own) bad(m.id, `导出的文件 ${e.path} 不在自己的 writes 里 —— 交出来的东西必须是它写过的`)
    }
  }

  // 4) 依赖图无环
  const state = new Map()
  const visit = (id, stack) => {
    if (state.get(id) === 'done') return
    if (state.get(id) === 'doing') { bad(id, `依赖成环：${[...stack, id].join(' → ')}`); return }
    state.set(id, 'doing')
    const m = findModule(contract, id)
    for (const imp of m?.imports || []) if (findModule(contract, imp?.from)) visit(String(imp.from), [...stack, id])
    state.set(id, 'done')
  }
  for (const m of mods) visit(String(m.id), [])

  // 5) 入口唯一：integration.entry 必须落在某个模块的写域里，且只能落一个
  if (contract?.integration?.entry) {
    const owners = mods.filter((m) => (m.writes || []).some((w) => inside(contract.integration.entry, w)))
    if (owners.length === 0) {
      issues.push({ level: 'warn', where: 'integration', msg: `入口 ${contract.integration.entry} 不在任何模块的写域里 —— 那就得由你（首辅）自己接` })
    } else if (owners.length > 1) {
      bad('integration', `入口 ${contract.integration.entry} 同时属于 ${owners.map((m) => m.id).join('、')} 的写域`)
    }
  }
  return issues
}

/** 分工检查：每个模块必须落到一位**真实存在**的阁老头上，而且别把活堆给同一个人 */
function seatIssuesOf(d, contract) {
  const issues = []
  const mods = (contract?.modules || [])
  const seats = d?.seats || []
  const ids = new Set(seats.map((s) => String(s.id)))
  for (const m of mods) {
    const id = String(m?.id ?? '?')
    if (!m.seat) {
      issues.push({ level: 'error', where: id, msg: '没有指派席位（seat）—— 每个模块必须交给一位阁老，不能留在"谁有空谁写"' })
    } else if (!ids.has(String(m.seat))) {
      issues.push({ level: 'error', where: id, msg: `席位 "${m.seat}" 不在这次的内阁里（现有：${seats.map((s) => s.id).join(' / ')}）` })
    }
  }
  // 按擅长分，不是轮着分：有人背两个、却有人一个都没有时提醒一句
  const load = new Map(seats.map((s) => [String(s.id), 0]))
  for (const m of mods) if (load.has(String(m.seat))) load.set(String(m.seat), load.get(String(m.seat)) + 1)
  const idle = [...load.entries()].filter(([, n]) => n === 0).map(([id]) => id)
  const heavy = [...load.entries()].filter(([, n]) => n > 1).map(([id, n]) => `${id}×${n}`)
  if (idle.length && heavy.length) {
    issues.push({
      level: 'warn', where: 'seats',
      msg: `${heavy.join('、')} 一个人扛了多块，而 ${idle.join('、')} 一块没有 —— 按各自擅长分，别把活堆给同一个人`,
    })
  }
  return issues
}

/** 文件用的是哪套模块系统（ESM / CommonJS）—— 两套混用是所有"拼不上"里最难查的一种 */
function detectModuleSystem(text) {
  const esm = /^\s*(export|import)\b/m.test(text)
  const cjs = /\bmodule\.exports\b|\bexports\.[A-Za-z_$]|\brequire\s*\(/.test(text)
  if (esm && !cjs) return 'esm'
  if (cjs && !esm) return 'cjs'
  if (esm && cjs) return 'mixed'
  return 'unknown'
}

/** 收活后的机械检查：文件在不在、写域越没越界、承诺的 export 有没有真的出现 */
function checkDelivery(cwd, mod, receipt) {
  const issues = []
  const files = Array.isArray(receipt?.files) ? receipt.files.map(normPath) : []
  if (!files.length) issues.push({ level: 'error', where: mod.id, msg: '回执里没有任何文件（files 为空）' })
  for (const f of files) {
    if (!(mod.writes || []).some((w) => inside(f, w))) {
      issues.push({ level: 'error', where: mod.id, msg: `越界写入：${f} 不在写域 ${(mod.writes || []).join(' / ')} 内` })
    }
    try {
      const text = readFileSync(join(cwd, f), 'utf8')
      if (!text.trim()) issues.push({ level: 'error', where: mod.id, msg: `文件是空的：${f}` })
      const sys = detectModuleSystem(text)
      for (const e of mod.exports || []) {
        if (e?.kind !== 'symbol' || !e.name) continue
        const esmRe = new RegExp(`(export\\s+(default\\s+)?(async\\s+)?(function|class|const|let|var)\\s+${e.name}\\b)|(export\\s*\\{[^}]*\\b${e.name}\\b)`)
        // CommonJS 也认：整份项目统一用 CJS 时它是合法的（混用才由下面的跨模块检查抓）
        const cjsRe = new RegExp(`(module\\.exports\\s*=\\s*\\{[^}]*\\b${e.name}\\b[^}]*\\})|(exports\\.${e.name}\\s*=)|(module\\.exports\\s*=\\s*${e.name}\\b)`)
        const own = files.includes(normPath(e.from || e.path || ''))
        if (own && !esmRe.test(text) && !cjsRe.test(text)) {
          issues.push({
            level: 'error',
            where: mod.id,
            msg: sys === 'mixed'
              ? `${f} 里 ESM 和 CommonJS 混着用，而且找不到承诺的出口 ${e.name} —— 这种文件谁 import 都会出问题。`
              : `承诺的出口没出现：${e.name}（在 ${e.from || e.path}，既没有 ESM 的 export，也没有 module.exports 出来）`,
          })
        }
      }
    } catch {
      issues.push({ level: 'error', where: mod.id, msg: `文件不存在：${f}` })
    }
  }
  if (receipt?.done === false) issues.push({ level: 'error', where: mod.id, msg: '它自己报告没干完（done=false）' })
  return issues
}

/** 挑一个 subagent 后端：优先能指定 agentOptions 的（那样才换得动模型） */
function pickBackend(ctx) {
  const sub = ctx.get?.('subagents')
  if (!sub || typeof sub.startActivation !== 'function') return null
  const names = (typeof sub.list === 'function' ? sub.list() : []) || []
  if (!names.length) return null
  const withOpts = names.find((n) => {
    try { return sub.getProvider?.(n)?.capabilities?.agentOptions } catch { return false }
  })
  return { sub, name: withOpts || names[0] }
}

const RECEIPT_SCHEMA = {
  type: 'object',
  properties: {
    moduleId: { type: 'string' },
    done: { type: 'boolean' },
    files: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['moduleId', 'done', 'files'],
  additionalProperties: false,
}

/**
 * 从子会话的文字输出里兜一个审计结论出来。
 * 结构化回执是本意，但模型有时不调 structured_output，或者子会话在收尾前就结束了；
 * 这时候把它的话当成"没结论"会把好好的模块拦在门外，不如从文本里捞一眼。
 */
function parseVerdict(output) {
  const text = Array.isArray(output)
    ? output.map((b) => (typeof b === 'string' ? b : b?.type === 'text' ? (b.text || '') : '')).join('\n')
    : String(output ?? '')
  if (!text.trim()) return {}
  const m = text.match(/\{[\s\S]*?"verdict"[\s\S]*?\}/)
  if (m) {
    try {
      const j = JSON.parse(m[0])
      if (j && typeof j.verdict === 'string') return j
    } catch { /* 不是合法 JSON，往下走 */ }
  }
  if (/"verdict"\s*:\s*"ok"/i.test(text) || /verdict\s*[:：]\s*ok/i.test(text)) {
    return { verdict: 'ok', seamIssues: [], evidence: clip(text, 1200) }
  }
  if (/"verdict"\s*:\s*"suspect"/i.test(text) || /verdict\s*[:：]\s*suspect/i.test(text)) {
    return { verdict: 'suspect', seamIssues: [clip(text, 400)] }
  }
  return {}
}

/* ──────────────────────────────── 插件入口 ──────────────────────────────── */

export function apply(ctx) {
  // 先恢复上次没开完的会：宿主重载（改代码、进程重启）不该把在飞的会场弄丢
  loadDebates()

  /* ── ① 换人：每次模型调用前的瀑布 ──
   * 坑（0.7.4 实测）：同样的返回，在子会话里真的换了模型，在主会话里却换不掉 ——
   * 主会话上还有别的插件（UI 的"模型选择"）在更外层改写 config.model，只留下我们改的
   * maxTokens。所以这里同时挂两处：全局一份（子会话用），并且在每个 agent 自己的 ctx 上
   * 再挂一份（作用域更内层，抢在改写之后拿到最后一句话）。
   */
  const scopedAgents = new Set()
  async function swapFor(payload, next, tag) {
    const cfg = await next()
    const agent = payload?.agent
    if (agent) {
      const key = String(agent.id ?? agent.sessionId ?? '')
      if (key) agents.set(key, agent)
    }
    const d = debateOf(agent)
    const seat0 = d && d.status === 'debate' ? speakerSeat(d) : null
    reqLog.push({
      at: Date.now(), tag, key: String(agent?.id ?? ''), hasDebate: !!d, status: d?.status || '', speaker: d?.speaker || '',
      seat: seat0?.id || '', wantModel: seat0 ? `${seat0.provider}/${seat0.model}` : '', gotModel: String(cfg?.model || ''),
    })
    if (reqLog.length > 40) reqLog.shift()
    // 记住"首辅用的是哪个模型"：首辅发言不换人，但质检要由首辅来做（不能拿阁员的模型审阁员）。
    if (d && d.status !== 'closed' && !(seat0 && seat0.id) && cfg?.model) {
      d.chairCfg = { provider: String(cfg.provider || ''), model: String(cfg.model || '') }
    }
    if (!d || d.status !== 'debate') return cfg
    const seat = speakerSeat(d)
    if (!seat) return cfg // 首辅发言 = 用会话自己的模型
    const out = await configForSeat(ctx, cfg, seat)
    // 阁员发言要短：不设上限的话它会写成一篇报告，用户要在一屏里看清"谁在争什么"。
    // 2000 而不是几百：思考型模型会先花 token 想，压太狠会把话截断在半句上。
    if (!out.maxTokens || out.maxTokens > 2000) out.maxTokens = 2000
    if (reqLog.length) reqLog[reqLog.length - 1].retModel = `${out.provider}/${out.model}`
    return out
  }

  ctx.effect(() => ctx.on('agent/request', async (payload, next) => {
    const key = String(payload?.agent?.id ?? '')
    const agent = payload?.agent
    if (agent) {
      const k = String(agent.id ?? agent.sessionId ?? '')
      if (k) agents.set(k, agent)
    }
    return swapFor(payload, next, 'prepend')
  }, { global: true, prepend: true }), 'cabinet: 按当前发言人切换 provider/model')

  /* ── ② 会场记忆 + 兜底 ──
   * 注意：`assistant/message` / `turn/end` / `user/message` **不是**宿主事件总线上的事件，
   * 它们是会话日志里的持久事件，只能通过 `session/event`（提交后的追加流）拿到。
   * 之前直接 ctx.on('assistant/message') 注册，一次都没触发过 —— 首辅因此拿不到
   * "刚才谁说了什么"，`/state` 里的 lastSpeeches 也永远是空的。
   */
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    const sid = String(session?.id ?? session?.sessionId ?? '')
    const d = sid ? debates.get(sid) : null
    if (!d || d.status === 'closed') return

    if (event?.type === 'assistant/message' && d.status === 'debate') {
      const msg = event.data?.message
      const blocks = Array.isArray(msg?.content) ? msg.content : []
      const text = blocks.filter((b) => b?.type === 'text').map((b) => String(b.text || '')).join('\n').trim()
      if (!text) return // 纯工具调用的一步，不算一次发言
      const seat = speakerSeat(d)
      d.speeches.push({
        seat: seat?.id || 'chair',
        label: seat?.label || d.chairLabel,
        model: seat ? `${seat.provider}/${seat.model}` : 'chair',
        text,
        at: Date.now(),
      })
      d.touchedAt = Date.now()
      persistSoon()
      return
    }

    // 用户插话 ⇒ 话筒先收回首辅。
    // 否则用户这句话会被"当前发言人"那个阁员的模型接走：用户想跟主持人说话，回他的却是个阁员。
    if (event?.type === 'user/message') {
      if (d.speaker !== 'chair') {
        note(d, `用户插话，话筒从 ${whoLabel(d)} 收回 ${d.chairLabel}`)
        d.speaker = 'chair'
      }
      d.paused = null
      d.pendingAsk = null
      d.touchedAt = Date.now()
      persistSoon()
      return
    }

    // 新回合开始 ⇒ 房间里有人接上了，把上一轮的"催交棒"状态清掉
    if (event?.type === 'turn/start') {
      d.turnAlive = true
      d.paused = null
      return
    }

    // 谁端着话筒没交棒就把回合结束了（模型忘了调工具）→ 话筒自动收回首辅，
    // 否则下一条用户消息会被错误的阁员模型接走。
    if (event?.type === 'turn/end') {
      const seat = speakerSeat(d)
      d.turnAlive = false
      const forgot = d.speaker !== 'chair' && d.status === 'debate'
      if (forgot) d.speaker = 'chair'
      d.touchedAt = Date.now()
      persistSoon()
      if (!forgot) return

      /* 阁员端着话筒把回合结束了（模型忘了调 cabinet_pass）：
       * 不能就这么算了——房间里一句话说完就静音，用户看到的是"卡住了"。
       * 试过 agent.followup() 唤醒，实测唤不起来（nudge 记下来了，回合没起来），
       * 所以真正的兜底是 ③ 的常驻系统提示：用户下一句话进来，首辅照样知道房间停在哪。
       * 这里仍然试一次 followup，能成就省用户一次输入。
       */
      d.paused = { seat: seat?.id || '', label: seat?.label || '阁员', at: Date.now() }
      if ((d.nudges || 0) >= MAX_NUDGES) return
      const agent = agents.get(sid)
      if (!agent || typeof agent.followup !== 'function') {
        note(d, '发言结束但没交棒，也拿不到 agent 来催 —— 等用户说"继续"')
        return
      }
      d.nudges = (d.nudges || 0) + 1
      const nextPick = pickNext(d, seat?.id)
      const nudge = `【主持人提醒·不是新话题】你刚才那段发言已经记进会场了，但你**没有交棒**，房间正停在你这里。`
        + `现在只做一件事：调用 cabinet_pass，把话筒交给 ${nextPick ? `${nextPick.label}（${nextPick.id}）` : '别人或 chair'}，`
        + `ask 里给你的下一句话/那个必须回答的问题。不要复述刚才说过的内容，不要另起一段新的论证。`
      // 唤醒要试几次：turn/end 刚触发时 agent 还没完全空闲，太早调 followup 会石沉大海
      for (const delay of [120, 800, 2000]) {
        setTimeout(() => {
          if (d.turnAlive) return
          try {
            const p = agent.followup(nudge)
            if (p && typeof p.catch === 'function') p.catch((e) => note(d, `催交棒被拒：${e?.message || e}`))
          } catch (e) {
            note(d, `催交棒抛错：${e?.message || e}`)
          }
        }, delay)
      }
      note(d, `已催 ${seat?.label || '阁员'} 交棒（第 ${d.nudges} 次）`)
    }
  }), 'cabinet: 记录会场发言 / 收回话筒')

  /* ── ②.5 议政中阁员不许抢法槌（硬拦，不只靠提示词） ──
   * 说话的人一换，模型就爱"越权"：自己出方案、自己派活、直接改文件。
   * 光在提示词里写"别调别的工具"没用（实测照样调），所以在工具执行前同步否决。
   * 只拦"话筒在阁员手上 + 状态是 debate"这一种情形：首辅、用户、分工阶段的子会话都不受影响。
   */
  ctx.effect(() => ctx.tools.guard((execution) => {
    const d = debateOf(execution?.agent)
    if (!d || d.status !== 'debate' || d.speaker === 'chair') return
    const name = String(execution?.name || '')
    if (MEMBER_TOOLS.has(name)) return
    return `现在话筒在「${whoLabel(d)}」手上 —— 你这一轮只能用 ${[...MEMBER_TOOLS].join(' / ')}。`
      + `要说话就直接说；说完必须调用 cabinet_pass 把话筒交出去并留下一个对方必须回答的问题。`
      + `改文件、派活、出方案、散会这些是首辅和用户的事，你越权了。`
  }), 'cabinet: 议政中限制阁员只能用 cabinet_pass 等少数工具')

  /* ── ③ 会场状态常驻系统提示 ──
   * 为什么要有这一条：模型的回合随时可能结束（它忘了调 cabinet_pass），用户也会中途插话。
   * 只要会场状态躺在一个"每次都重新求值"的 prompt section 里，首辅下一次醒来
   * （用户说"继续"、还是自己接着干）就一定知道：议题是什么、话筒在哪、刚才谁说了什么。
   * 这比把摘要塞进工具返回值可靠得多 —— 工具返回值只在调工具那一步有效。
   *
   * 而且这段必须**换个口吻**写：谁在说话，就用"你"称呼谁。
   * 早先这永远是第三人称（"话筒在务实派手上"），换人之后那个模型只从工具返回值里
   * 隐约知道自己是谁，于是常见病是：它开始以主持人身份报流程、或者反过来给自己分派任务。
   */
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'cabinet-room',
    order: 60,
    text: (ac) => {
      const key = agentKey(ac?.scope)
      const d = key ? debates.get(key) : null
      if (!d || d.status === 'closed') return ''
      const seat = speakerSeat(d)
      const lastWords = d.speeches.length
        ? ['最近说过的话（节选）：', ...d.speeches.slice(-3).map((s) => `- ${s.label}：${clip(s.text, 160)}`)]
        : ['还没人开口。']

      if (seat) {
        return [
          `【内阁会场 · 轮到你说话】议题：${d.topic}`,
          `**你现在就是「${seat.label}」**${seat.skill ? `，你的立场/擅长：${seat.skill}` : ''}。你不是首辅，不要主持、不要分配任务、不要复述议题。`,
          '别人刚把话筒递给你 —— 上面那条"话筒已交…"的消息不是你说的，是别人说的；接着往下讲就行。',
          d.pendingAsk?.ask ? `上一位（${d.pendingAsk.from || '屋里的人'}）留给你的问题：${d.pendingAsk.ask}` : '',
          '',
          ...lastWords,
          speechCounts(d) ? `发言分布：${speechCounts(d)}` : '',
          '',
          '你怎么说：直接开口，对屋里的人说话（第一句点明你接的是谁的那句话）；不同意就直说不同意；不要"综上所述"。',
          '**说短一点**：一次只说一个点，两三句、不超过 80 字。不要铺垫、不要小标题、不要 1/2/3 罗列 —— 这是当面抢话，不是写报告。',
          '**不要写流程旁白**："话筒已交…""等待…发言""当前进度""我记录一下"这类话一句都不要有。',
          `说完**必须**调用 cabinet_pass 交棒（可交给：${d.seats.map((s) => s.id).join(' / ')} / chair），ask 里留下一个对方必须回答的问题。`,
        ].filter(Boolean).join('\n')
      }

      const statusLine = {
        debate: '辩论中',
        proposed: '已出方案，等用户挑',
        decided: '方案已定，等你出框架（cabinet_frame）',
        framed: '框架已通过，等用户确认后派活（cabinet_dispatch）',
        dispatched: '已派活，模块在做',
        blocked: '有模块没交齐/拼不上，等返工',
        integrating: '模块都交了，等整合与交付（cabinet_integrate）',
        delivered: '已交付',
      }[d.status] || d.status

      const nextStep = {
        debate: '你接着做：先说话（挑事/回应），再调用 cabinet_pass 交棒 —— 每次回话都必须以 cabinet_pass 结束；吵够了就用 cabinet_propose 收敛。',
        proposed: '用户挑方案：他说了挑哪个就 cabinet_decide；想接着吵就 cabinet_pass。',
        decided: d.frameIssues?.length
          ? `框架没过检查，按这些逐条改再提交：\n${d.frameIssues.filter((i) => i.level === 'error').map((i) => `- [${i.where}] ${i.msg}`).join('\n')}`
          : `把交付拆成模块，**每块指定一位阁老（seat）**——按擅长分，不要轮流分；一个人最多带一到两块。然后用 cabinet_frame 提交，提交后我会跑静态检查（含"分工是否落到了真人头上"）。`,
        framed: '等用户点头。点头后 cabinet_dispatch 并行派活：每个模块起一个子会话、跑那位阁老自己的模型，一次最多 5 个同时。',
        blocked: '看 /state 里各模块的 issues，按具体差异改契约或只重派失败的那几个（cabinet_dispatch 带 only）。',
        integrating: '把模块接到 integration.entry，跑一次真的构建/测试，然后 cabinet_integrate 交付。',
        delivered: '已交付。有意见就按用户说的继续改（可以重新 frame 派活），没事就 cabinet_close。',
      }[d.status] || ''

      const modLine = d.dispatch
        ? `模块：${Object.values(d.dispatch.modules).map((r) => `${r.id}=${r.status}`).join(' / ')}`
        : ''

      return [
        `【内阁会场】议题：${d.topic}`,
        `状态：${statusLine}；话筒在**你（${d.chairLabel}）**手上${d.paused ? `（上一回合 ${d.paused.label} 忘了交棒，房间停在这儿）` : ''}。`,
        d.decision ? `已定方案：【${d.decision.n}】${d.decision.title}` : '',
        modLine,
        d.pendingAsk?.ask ? `刚才有人问全屋的是：${d.pendingAsk.ask}` : '',
        '',
        ...lastWords,
        speechCounts(d) ? `发言分布：${speechCounts(d)}` : '',
        '',
        nextStep,
      ].filter(Boolean).join('\n')
    },
  }), 'cabinet: 会场状态常驻系统提示')

  /* ── ④ 工具 ── */
  const textOutput = {
    schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    render: (_args, value) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : String(value ?? '') }],
  }

  const tool = (spec) => ctx.tools.register({
    name: spec.name,
    description: spec.description,
    parameters: { type: 'object', properties: spec.properties || {}, additionalProperties: false },
    output: textOutput,
    execute: async (args, exec) => {
      try {
        return { text: String(await spec.run(args || {}, exec || {})) }
      } finally {
        // 每个工具跑完都落一次盘：宿主重载/崩溃不该把一场正在开的会弄丢
        persistSoon()
      }
    },
  })

  const T = (s) => String(s ?? '').trim()

  tool({
    name: 'cabinet_convene',
    description: '召开内阁议政：把议题摆到桌面上，让几位不同模型的阁员在**同一个房间里**互相回应、争辩，然后收敛成方案。'
      + '**只在用户明确要求"开个内阁 / 多模型讨论 / 叫几个人一起吵"时调用**；闲聊或普通提问不要用。\n'
      + '用户当场指定了"几个人、用哪些模型"时，就按他说的传 `seats`（或简写 `models`）；没指定就留空，用设置页那套。\n'
      + '调用后你先开题（拆出真正有争议的点），然后必须调用 cabinet_pass 点名第一个人。',
    properties: {
      topic: { type: 'string', description: '要说清的议题：要解决什么、边界在哪、期望产出什么' },
      seats: {
        type: 'array',
        description: '这次坐哪几位（用户点名时用）。不填 = 用「设置 → 内阁」里那套。',
        items: {
          type: 'object',
          properties: {
            model: { type: 'string', description: '模型 id，例如 deepseek-v4-pro' },
            label: { type: 'string', description: '席位名（不填就用模型名）' },
            skill: { type: 'string', description: '擅长什么，一句话；会写进它的发言提示' },
            provider: { type: 'string', description: '不填就自动找：哪个 provider 下有这个模型就用哪个' },
          },
          required: ['model'],
          additionalProperties: false,
        },
      },
      models: {
        type: 'array',
        items: { type: 'string' },
        description: '更省事的写法：只报模型名（["deepseek-v4-pro","glm-5.3"]），席位名与 provider 自动补。',
      },
    },
    async run(args, exec) {
      const cfg = loadSeats()
      const topic = T(args.topic)
      if (!topic) return '议题是空的：请把要讨论的事写清后再召集。'
      // 用户当场点名的阵容优先于设置页那套 —— 「谁坐进来」是用户的权利，不该只能去设置页改。
      const asked = Array.isArray(args.seats) && args.seats.length
        ? args.seats
        : (Array.isArray(args.models) && args.models.length ? args.models.map((m) => ({ model: m })) : null)
      let base = cfg.seats
      const rosterNote = []
      if (asked) {
        const preferProv = [...new Set(cfg.seats.map((s) => s.provider).filter(Boolean))]
        const built = []
        for (const s of asked.slice(0, MAX_SEATS)) {
          const model = T(typeof s === 'string' ? s : s?.model)
          if (!model) continue
          const provider = T(typeof s === 'object' ? s?.provider : '') || await providerForModel(ctx, model, preferProv)
          // 点名的模型如果本来就在设置页配过，就沿用那位的名字与擅长 —— 否则"按擅长分工"没东西可分
          const known = cfg.seats.find((x) => String(x.model) === model)
          built.push({
            id: 's' + (built.length + 1),
            label: T(typeof s === 'object' ? s?.label : '') || (known?.label || model.split('/').pop()),
            skill: T(typeof s === 'object' ? s?.skill : '') || (known?.skill || ''),
            provider,
            model,
            reasoningEffort: null,
          })
        }
        if (built.length) {
          base = built
          rosterNote.push(`这次按用户点名的阵容组阁（${built.length} 位）。`)
        }
      }
      if (base.length < 2) return `内阁只有 ${base.length} 位阁员，至少要有 2 位（去「设置 → 内阁」里加人，或在 convene 的 seats 里点名）。`
      const { seats, bad } = await vetSeats(ctx, base)
      const warn = bad.length ? `\n⚠️ 这几位这次不参会（provider/model 对不上）：${bad.join('、')}` : ''
      if (seats.length < 2) {
        return `能上场的阁员不足 2 位，议政开不起来。${warn}\n去「设置 → 内阁」把席位指向**当前对话在用的那个 provider** 下的模型，或点名时就带上 provider。`
      }
      const key = agentKey(exec.agent)
      debates.set(key, {
        topic,
        seats,
        chairLabel: cfg.chairLabel,
        speaker: 'chair',
        pendingAsk: null,
        status: 'debate',
        turnAlive: true,
        speeches: [],
        proposals: null,
        nudges: 0,
        notes: [],
        touchedAt: Date.now(),
      })
      return [
        `内阁已就座（${seats.length} 位）。议题：${topic}`,
        ...rosterNote,
        bad.length ? `⚠️ 被剔掉的：${bad.join('、')}` : '',
        '',
        `你是${cfg.chairLabel}——这场讨论的组织者，不是主讲人。阁员如下：`,
        ...seats.map(seatLine),
        '',
        '**这是一屋子人当面吵，不是轮流念稿。** 规则：',
        '1) 你先**开题**：2–4 句，把议题拆成真正有争议的几个点，明说你觉得最可能吵起来的是哪一处。',
        `2) 紧接着调用 cabinet_pass({ to: "${seats[0].id}", ask: "..." })，ask 里给 ${seats[0].label} 一个**具体的、必须回答**的问题。`,
        '3) 之后每次话筒回到你，**不要总结、不要和稀泥**。你要做的是挑事：',
        '   · 指出谁和谁在哪一句上对不上（点名，引原话）；',
        '   · 把话筒交给最该回应的人，ask 写清"回应什么、别绕开什么"；',
        '   · 谁的观点还没被正面挑战过，就点名让别人去打它。',
        '4) 你和阁员都可以被反驳。你自己的判断也可以丢出去让人打。',
        '5) **所有人都说短话**（两三句、80 字以内）：用户要在一屏里看清谁在争什么，不是读报告。你自己说话同样短。',
        `6) 吵够了（每人至少说过 ${MIN_SPEECHES_BEFORE_PROPOSE} 次、核心分歧都被正面碰过）就调用 cabinet_propose 出 2–3 个方案，**每个方案对应一派立场**。`,
        '7) 用户随时可能插话 —— 他说什么，就按他的意思改议程。',
      ].filter(Boolean).join('\n')
    },
  })

  tool({
    name: 'cabinet_pass',
    description: '交话筒：把发言权交给下一位（另一个阁员，或 "chair" 交回首辅）。'
      + '`ask` 里必须写一个具体问题/一句挑衅 —— 下一位要接的就是它。不交棒这场讨论就停在这里。',
    properties: {
      to: { type: 'string', description: '下一位的席位 id；交回首辅写 "chair"' },
      ask: { type: 'string', description: '给下一位的具体问题：回应哪一句、凭什么、别绕开什么' },
    },
    async run(args, exec) {
      const d = debateOf(exec.agent)
      if (!d) return '当前没有进行中的议政。'
      if (d.status !== 'debate') return `议政已经进入 ${d.status}，不用再交棒。`
      const to = T(args.to) || 'chair'
      const ask = T(args.ask)
      const me = whoLabel(d)
      d.touchedAt = Date.now()

      if (d.speeches.length >= MAX_SPEECHES) {
        d.speaker = 'chair'
        d.pendingAsk = null
        return `发言次数到上限（${MAX_SPEECHES}）。话筒强制回到你（${d.chairLabel}）：请直接调用 cabinet_propose 收敛成方案。`
      }

      if (to === 'chair') {
        d.speaker = 'chair'
        d.pendingAsk = ask ? { from: me, ask } : null
        return [
          `【话筒到你了】上面这次 cabinet_pass 不是你做的，是「${me}」交回来的。`,
          `你现在是**${d.chairLabel}**（主持人），不是 ${me}。`,
          '',
          digest(d),
          '',
          speechCounts(d) ? `发言分布：${speechCounts(d)}` : '',
          '',
          '现在轮到你**挑事**（不是总结）：',
          '· 指出刚才谁和谁在哪一句上真正对不上，把原话点出来；',
          '· 挑最该回应的那个人，cabinet_pass 到他那，ask 里写清"回应哪一句、别绕开什么"；',
          '· 谁还没被正面挑战过，就派个人去打；',
          '· 你也可以把自己的判断丢出去让人打（你是发言人时模型不变）。',
          '⚠️ 不要说"大家说得都很好"，也不要收口 —— 除非核心分歧真的都被碰过了。',
          '⚠️ 不要写"话筒已交…""等待某位发言""当前进度"这类流程旁白：你是在场上说话，不是在播报流程。',
        ].filter(Boolean).join('\n')
      }

      const seat = d.seats.find((s) => s.id === to)
      if (!seat) return `没有 id 为 "${to}" 的阁员。可选：${d.seats.map((s) => s.id).join(' / ')} / chair`
      d.speaker = seat.id
      d.pendingAsk = ask ? { from: me, ask } : null
      return [
        `【话筒到你了】上面那次 cabinet_pass 不是你做的，是「${me}」把你点了上来 —— 别把它当成你自己的动作，也别接着当主持人。`,
        `你现在就是**${seat.label}**（模型 ${seat.model}）${seat.skill ? `，擅长 ${seat.skill}` : ''}。议题：${d.topic}`,
        ask ? `有人要你回答的是：${ask}` : '',
        '',
        '房间里的对话你都看得见。**接着往下打，别另起一摊。**',
        '1) 第一句先明确你接谁的话：他说的是哪一句，你同意还是反对（点名）；',
        '2) 说理由，或者指出他哪一步没解释清楚；',
        '3) 你和前面某人其实没分歧，就明说"这条我站他"，然后去打另一个点；',
        '4) 不要复述议题，不要客套，不要"综上所述"，不要总结别人。有不同意见就直接说不同意。',
        '5) **说短**：一次只打一个点，两三句、80 字以内。不要标题、不要 1/2/3 列举。',
        '6) 不要写"话筒已交…""等待…发言""当前进度""我记录一下"这类流程旁白 —— 你是在场上说话，不是在播报流程。',
        `7) 说完**必须**调用 cabinet_pass({ to: "<下一个人的 id，或 chair>", ask: "一个他必须回答的问题" })。可交给：${d.seats.map((s) => s.id).join(' / ')} / chair`,
      ].filter(Boolean).join('\n')
    },
  })

  // 旧名字，保持兼容（v1 的提示词里出现过 cabinet_yield）
  tool({
    name: 'cabinet_yield',
    description: 'cabinet_pass 的旧名字，等价（交话筒给下一位）。新代码请用 cabinet_pass。',
    properties: {
      next: { type: 'string', description: '下一位的席位 id；交回首辅写 "chair"' },
      note: { type: 'string', description: '同 cabinet_pass 的 ask' },
    },
    async run(args) {
      const next = T(args.next) || 'chair'
      const q = T(args.note).replace(/"/g, "'")
      return `请改用 cabinet_pass({ "to": "${next}", "ask": "${q}" })。`
    },
  })

  tool({
    name: 'cabinet_propose',
    description: '把争论收敛成 2–3 个**可选方案**摆给用户挑。只在用户说"出方案 / 收 / 可以定了"，'
      + '或争论确实已经碰完核心分歧时调用。调用后议政进入"待定"，等用户选。',
    properties: {
      options: {
        type: 'array',
        description: '2–3 个方案，每个对应一派立场',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '方案名（8 字内）' },
            stance: { type: 'string', description: '这个方案是谁那一路的（哪位阁员的立场，或"折中"）' },
            summary: { type: 'string', description: '做什么、怎么做（3–5 句）' },
            pros: { type: 'string', description: '好在哪' },
            cons: { type: 'string', description: '代价 / 风险；以及反对它的人会说什么' },
            support: { type: 'string', description: '谁支持、为什么' },
          },
          required: ['title', 'summary'],
          additionalProperties: false,
        },
      },
    },
    async run(args, exec) {
      const d = debateOf(exec.agent)
      if (!d || d.status !== 'debate') return '当前没有进行中的议政，不用出方案。'
      const opts = Array.isArray(args.options) ? args.options.slice(0, 3) : []
      if (opts.length < 2) return '至少要 2 个方案（不要只给一个"标准答案"）。请补齐后重新调用。'
      d.proposals = opts.map((o, i) => ({
        n: i + 1,
        title: T(o.title) || `方案 ${i + 1}`,
        stance: T(o.stance),
        summary: T(o.summary),
        pros: T(o.pros),
        cons: T(o.cons),
        support: T(o.support),
      }))
      d.status = 'proposed'
      d.speaker = 'chair'
      d.pendingAsk = null
      d.touchedAt = Date.now()
      const lines = d.proposals.map((p) => [
        `【${p.n}】${p.title}${p.stance ? `　（${p.stance}）` : ''}`,
        `  ${p.summary}`,
        p.pros ? `  ✅ ${p.pros}` : '',
        p.cons ? `  ⚠️ ${p.cons}` : '',
        p.support ? `  🗣 ${p.support}` : '',
      ].filter(Boolean).join('\n'))
      return [
        `方案已呈上（议题：${d.topic}，共 ${d.speeches.length} 次发言）：`,
        '',
        ...lines,
        '',
        d.speeches.length < MIN_SPEECHES_BEFORE_PROPOSE
          ? `⚠️ 这场只说了 ${d.speeches.length} 次就收了（${speechCounts(d)}）—— 方案很可能是首辅一个人的想法套了几个壳子。要么跟用户说明"还没真吵起来"，要么再吵两轮。`
          : '',
        '**停在这里等用户挑。** 用户选定后（比如"选 2"），你只确认一句、说清下一步要做什么，不要自己开工。',
      ].filter(Boolean).join('\n')
    },
  })

  tool({
    name: 'cabinet_status',
    description: '看当前会场：议题、状态、现在轮到谁、谁说了几次、有几个方案。',
    properties: {},
    async run(_args, exec) {
      const d = debateOf(exec.agent)
      if (!d) return '当前没有议政。'
      return [
        `议题：${d.topic}`,
        `状态：${d.status}　当前发言人：${whoLabel(d)}　累计发言：${d.speeches.length}`,
        `发言分布：${speechCounts(d)}`,
        `阁员：${d.seats.map((s) => `${s.label}(${s.id})`).join(' / ')}`,
        d.proposals ? `方案：${d.proposals.map((p) => `${p.n}.${p.title}`).join(' / ')}` : '',
      ].filter(Boolean).join('\n')
    },
  })

  tool({
    name: 'cabinet_close',
    description: '散会：结束这场议政（方案已定、或用户说"散了吧/不用了"时调用）。',
    properties: {},
    async run(_args, exec) {
      const d = debateOf(exec.agent)
      if (!d) return '当前没有议政。'
      const n = d.speeches.length
      d.status = 'closed'
      d.speaker = 'chair'
      d.pendingAsk = null
      d.paused = null
      d.touchedAt = Date.now()
      // 散了的会不必再占着重启恢复的名额
      debates.delete(agentKey(exec.agent))
      persistSoon()
      return `议政已散（${n} 次发言，议题：${d.topic}）。`
    },
  })

  /* ══════════════════════ 二期工具：定案 → 定框架 → 派活 → 审计 → 整合 ══════════════════════ */

  tool({
    name: 'cabinet_decide',
    description: '锁定用户挑中的那个方案（进度：proposed → decided）。之后才可以出框架。',
    properties: {
      n: { type: 'number', description: '方案编号（1/2/3）' },
      note: { type: 'string', description: '用户的附加条件/修改意见（原话照抄）' },
    },
    async run(args, exec) {
      const d = debateOf(exec.agent)
      if (!d) return '当前没有议政。'
      if (!d.proposals) return '还没有方案可挑：先用 cabinet_propose 收敛成方案。'
      const n = Number(args.n)
      const p = d.proposals.find((x) => x.n === n)
      if (!p) return `没有第 ${n} 号方案。可选：${d.proposals.map((x) => x.n).join(' / ')}`
      d.decision = { n: p.n, title: p.title, summary: p.summary, stance: p.stance, note: T(args.note) }
      d.status = 'decided'
      d.speaker = 'chair'
      d.touchedAt = Date.now()
      return [
        `已定案：【${p.n}】${p.title}${args.note ? `（补充：${T(args.note)}）` : ''}`,
        '',
        '下一步是你出**框架**（不是散文，是数据）：把交付物拆成几个模块，每个模块写清',
        '· 派给谁（seat）、独占的写域（writes）、要交出来的东西（exports）、依赖别人的什么（imports）、怎么算合格（acceptance）；',
        '· 外加 integration.entry：最后把东西接到哪个入口文件。',
        '',
        '**分工是这一步的全部重点**：按每位阁员的擅长（见下表）分，不要轮流分。',
        ...d.seats.map((s) => `· ${s.id} ${s.label}（${s.model}）${s.skill ? `：擅长 ${s.skill}` : '：（没写擅长什么）'}`),
        '· 拿不准擅长时，就按刚才谁的主张最接近这块活来分 —— 方案是哪一派赢的，那部分就让主张它的人做。',
        '· 拆得动就拆细一点：一份活一个人、写域互不相交，这样才真能同时开工。',
        '',
        '用 cabinet_frame({ contract }) 提交。提交后我会做静态检查（写域是否重叠、依赖能不能满足、有没有环、入口是否唯一），',
        '**不过就退回来给你改**，通过了才允许派活。',
      ].join('\n')
    },
  })

  tool({
    name: 'cabinet_frame',
    description: '提交机器可读的框架（接口契约）。提交后立刻跑静态检查；不通过会逐条告诉你哪里拼不上。'
      + '这是"能不能并行"的判据：写域不相交 + 依赖可满足 + 无环 + 入口唯一。',
    properties: {
      contract: {
        type: 'object',
        description: '框架本身。modules[] 每人一条；integration.entry 是最终入口',
        additionalProperties: true,
      },
    },
    async run(args, exec) {
      const d = debateOf(exec.agent)
      if (!d) return '当前没有议政。'
      if (d.status !== 'decided' && d.status !== 'framed' && d.status !== 'blocked') {
        return `现在状态是 ${d.status}，不能定框架。先 cabinet_decide 锁定方案。`
      }
      const contract = args.contract
      if (!contract || typeof contract !== 'object') return 'contract 必须是对象。'
      const issues = [...checkContract(contract), ...seatIssuesOf(d, contract)]
      const errors = issues.filter((i) => i.level === 'error')
      d.contract = contract
      d.frameIssues = issues
      d.touchedAt = Date.now()
      if (errors.length) {
        d.status = 'decided'
        return [
          `框架没过静态检查（${errors.length} 处），先改契约再派活：`,
          ...issues.map((i) => `${i.level === 'error' ? '✗' : '!'} [${i.where}] ${i.msg}`),
          '',
          '改好再调一次 cabinet_frame。别急着派活 —— 现在派出去，活一定拼不上。',
        ].join('\n')
      }
      d.status = 'framed'
      const mods = contract.modules || []
      const seatName = (id) => {
        const s = d.seats.find((x) => String(x.id) === String(id))
        if (!s) return String(id || '（未指派）')
        const tag = s.label === s.model ? s.label : `${s.label}（${s.model}）`
        return `${tag}${s.skill ? ` · 擅长 ${s.skill}` : ''}`
      }
      const allIds = mods.map((m) => String(m.id))
      return [
        `框架通过（${mods.length} 个模块）。交付目标：${contract.goal || '（未写 goal）'}`,
        '',
        '**分工（这才是重点，先让用户看这个）**',
        ...mods.map((m) => {
          const dep = (m.imports || []).map((i) => String(i.from)).filter((id) => allIds.includes(id) && id !== String(m.id))
          return `· ${m.id}${m.title ? ` ${m.title}` : ''} → ${seatName(m.seat)}`
            + `　写 ${(m.writes || []).join(' / ') || '（未指定）'}`
            + `　交 ${exportKeys(m).map((k) => k.replace(/^(file|symbol):/, '')).join(' / ') || '（无）'}`
            + (dep.length ? `　等 ${dep.join('、')} 先交` : '')
        }),
        `· 入口：${contract.integration?.entry}${contract.integration?.how ? `（${contract.integration.how}）` : ''}`,
        issues.length ? `\n另有 ${issues.length} 条提醒：\n${issues.map((i) => `! [${i.where}] ${i.msg}`).join('\n')}` : '',
        '',
        '**停在这里等用户确认框架**：把上面这份分工贴给他看（谁做哪块、各自写哪些文件、谁等谁），说"确认就开工"。用户点头后调 cabinet_dispatch。',
      ].filter(Boolean).join('\n')
    },
  })

  tool({
    name: 'cabinet_dispatch',
    description: '按框架并行派活：每个模块起一个独立子会话（用**被指派那位阁老**的模型），最多同时 5 个。'
      + '收齐后自动跑机械检查（文件在不在、有没有越界写、承诺的 export 有没有真出现），不合格的模块标 blocked。',
    properties: {
      cwd: { type: 'string', description: '代码根目录（绝对路径）；不填就用当前工作区' },
      only: { type: 'array', items: { type: 'string' }, description: '只派这些模块 id（返工时用）' },
    },
    async run(args, exec) {
      const d = debateOf(exec.agent)
      if (!d) return '当前没有议政。'
      if (!d.contract) return '还没有框架：先 cabinet_frame。'
      if (d.status !== 'framed' && d.status !== 'blocked' && d.status !== 'integrating') {
        return `现在状态是 ${d.status}，不能派活。`
      }
      const issues = checkContract(d.contract).filter((i) => i.level === 'error')
      if (issues.length) {
        d.status = 'blocked'
        return `契约有 ${issues.length} 处硬伤，不能派活：\n${issues.map((i) => `✗ [${i.where}] ${i.msg}`).join('\n')}`
      }
      const backend = pickBackend(ctx)
      if (!backend) return '这个宿主没有可用的 subagent 后端，派不了活（需要 subagents 服务 + 至少一个 provider）。'

      // 工作区解析（0.8.1 修的坑）：agent 上**没有** cwd 字段，从工具里直接
      // `process.cwd()` 拿到的是宿主进程的目录（桌面版就是 profile 目录），
      // 结果四个子会话把文件规规矩矩写进了 C:\Users\…\.dsh\profiles\desktop\，
      // 机械检查还在同一个错目录里核对，于是"全部通过"——活干了，但不在用户的项目里。
      // 所以：显式 cwd > 会话记下的 cwd > 宿主 cwd；**落到 .dsh 里就拒绝执行**。
      let cwd = String(args.cwd || d.cwd || '').trim()
      if (!cwd) {
        const sess = exec?.agent ? ctx.get?.('sessions')?.get?.(exec.agent.id) : null
        cwd = String(sess?.meta?.cwd || sess?.cwd || exec?.cwd || process.cwd())
      }
      const underHome = (p) => {
        const a = normPath(p).toLowerCase()
        const h = normPath(HOME).toLowerCase()
        return a === h || a.startsWith(h + '/')
      }
      if (underHome(cwd)) {
        return [
          `工作区解析成了 ${cwd} —— 这是 DSH 自己的配置目录，不是用户的项目目录，我不往那儿写。`,
          '请这样重派：cabinet_dispatch({ cwd: "<项目根目录的绝对路径>" })。',
          '（这个坑的成因：exec 上没有 cwd 字段，只能退到宿主进程目录；显式传一次就记住了。）',
        ].join('\n')
      }
      if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
        return [
          `工作区不存在：${cwd}`,
          '子会话在启动阶段就会失败（回执里是 "working-directory: directory does not exist"，files 为空，模块直接 blocked）。',
          '先把目录建好再派活：要么在项目根目录跑，要么显式传一个已存在的 cwd。',
        ].join('\n')
      }
      d.cwd = cwd
      const only = Array.isArray(args.only) && args.only.length ? new Set(args.only.map(String)) : null
      const mods = (d.contract.modules || []).filter((m) => !only || only.has(String(m.id)))
      if (!mods.length) return '没有要派的模块。'

      // 返工上限：同一个模块改两轮还不过，说明不是"再跑一次就好"的事 ——
      // 要么契约本身错了，要么这个模块该换人写，要么该砍掉。这时候把人叫回来，别自己猛冲。
      const capped = []
      const runnable = mods.filter((m) => {
        const prev = d.dispatch?.modules?.[m.id]
        if (!prev) return true
        // 已经 done 的模块再派一次，等于"再改一遍"，一样计入返工轮数 ——
        // 否则这里就成了绕过上限的后门：done 的模块可以被无限重派。
        const attempt = (prev.rework || 0) + 1
        if (attempt > MAX_REWORK) { capped.push(m); return false }
        return true
      })
      if (!runnable.length) {
        return `${capped.map((m) => m.id).join('、')} 已经返工 ${MAX_REWORK} 轮还不过 —— 不能再自动重派了。\n`
          + '现在该做的是停下来问用户：是契约要改、这个模块换个人写、还是直接砍掉。'
          + '把每一轮的具体差异摆给他看，让他决定；不要自己换策略硬跑。'
      }

      d.status = 'dispatched'
      d.cwd = cwd
      // 第一次派活建表；返工时**沿用**旧表，只把这次要跑的模块重置成 running
      d.dispatch = d.dispatch && d.dispatch.modules
        ? { ...d.dispatch, cwd, lastDispatchAt: Date.now(), modules: d.dispatch.modules }
        : { startedAt: Date.now(), cwd, modules: {} }
      d.dispatch.startedAt = d.dispatch.startedAt || Date.now()
      const out = []
      const results = []
      const CONCURRENCY = 5
      const seatOf = (id) => d.seats.find((s) => String(s.id) === String(id))
      const who = (id) => {
        const s = seatOf(id)
        if (!s) return String(id)
        const tag = s.label === s.model ? s.label : `${s.label}（${s.model}）`
        return `${tag}${s.skill ? ` · 擅长 ${s.skill}` : ''}`
      }

      // 先把每个席位的 agentOptions 算出来（含正确的 reasoningEffort），
      // 否则 glm 这类模型一开口就 400。
      const seatOpts = new Map()
      for (const m of runnable) {
        const seat = seatOf(m.seat)
        if (seat && !seatOpts.has(seat.id)) seatOpts.set(seat.id, await seatAgentOptions(ctx, seat))
      }

      // 依赖靠 imports 推导：B import A 就意味着 B 得等 A 交出真实文件再动手。
      // 不分层全并行的话，B 是在对着一个还不存在的接口盲写 —— 这正是"拼不上"最常见的来源。
      const all = (d.contract.modules || []).map((x) => String(x.id))
      const depsOf = (m) => (m.imports || []).map((i) => String(i.from)).filter((id) => all.includes(id) && id !== String(m.id))
      const doneIds = new Set(Object.entries(d.dispatch.modules || {}).filter(([, r]) => r && r.status === 'done').map(([id]) => id))
      const pending = [...runnable]
      let roundNo = 0

      // 先让用户一眼看清"谁负责哪块" —— 这是他最该看的东西，比任何辩论都重要。
      out.push(`分工（${runnable.length} 个模块）`)
      for (const m of runnable) {
        const dep = depsOf(m)
        out.push(`· ${m.id}　${who(m.seat)}${m.title ? `　${m.title}` : ''}`
          + `${m.writes?.length ? `　写 ${m.writes.join(', ')}` : ''}`
          + `${dep.length ? `　等 ${dep.join('、')} 先交` : ''}`)
      }
      out.push('')

      while (pending.length) {
        let ready = pending.filter((m) => depsOf(m).every((id) => doneIds.has(id) || !pending.some((p) => String(p.id) === id)))
        if (!ready.length) {
          ready = pending.slice()
          out.push('⚠️ 剩下的模块互相等（依赖成环或都指着一个没交的），这一轮不等了全都派 —— 契约里的依赖图该回去看一遍。')
        }
        const batch = ready.slice(0, CONCURRENCY)
        for (const m of batch) pending.splice(pending.indexOf(m), 1)
        roundNo++
        out.push(`第 ${roundNo} 批：${batch.map((m) => `${m.id} → ${who(m.seat)}`).join('　')}`)

        const running = batch.map((m) => {
          const seat = seatOf(m.seat)
          // 返工重派时沿用旧记录（保住上一轮的回执/审计痕迹），别把整张表清掉
          const prev = d.dispatch.modules[m.id]
          const again = Boolean(prev) && prev.status !== 'running'
          const rec = {
            id: m.id,
            seat: m.seat,
            status: 'running',
            childId: '',
            files: [],
            issues: [],
            rework: again ? (prev.rework || 0) + 1 : (prev?.rework || 0),
            history: again
              ? [...(prev.history || []), { status: prev.status, files: prev.files, issues: prev.issues, at: Date.now() }]
              : [...(prev?.history || [])],
          }
          d.dispatch.modules[m.id] = rec
          if (!seat) {
            rec.status = 'blocked'
            rec.issues.push({ level: 'error', where: m.id, msg: `席位 ${m.seat} 不存在` })
            return null
          }
          const ac = new AbortController()
          d.dispatch.ac = d.dispatch.ac || ac
          return backend.sub.startActivation({
            provider: backend.name,
            label: `${m.id} ${m.title || ''}`.trim(),
            request: {
              cwd,
              prompt: [{ type: 'text', text: modulePrompt(d, m, cwd) }],
              parent: exec.agent,
              agentOptions: seatOpts.get(seat.id),
              outputSchema: RECEIPT_SCHEMA,
            },
            signal: ac.signal,
            delivery: 'caller',
          }).then((act) => {
            rec.childId = String(act.childId || '')
            return act.result.then((res) => ({ m, rec, res })).catch((e) => ({ m, rec, res: { diagnostic: String(e?.message || e) } }))
          }).catch((e) => ({ m, rec, res: { diagnostic: String(e?.message || e) } }))
        }).filter(Boolean)

        const settled = await Promise.all(running)
        for (const { m, rec, res } of settled) {
          const receipt = res?.structured || null
          rec.files = Array.isArray(receipt?.files) ? receipt.files : []
          rec.notes = String(receipt?.notes || '')
          rec.stopReason = String(res?.stopReason || '')
          rec.diagnostic = String(res?.diagnostic || '')
          const found = [
            ...checkDelivery(cwd, m, receipt),
            ...(receipt ? [] : [{ level: 'error', where: m.id, msg: `没有拿到结构化回执（stopReason=${res?.stopReason}${res?.diagnostic ? `, ${res.diagnostic}` : ''}）` }]),
          ]
          rec.issues = found
          rec.status = found.length ? 'blocked' : 'done'
          // 交了的模块要立刻进 doneIds：下一轮里"依赖它"的模块才有资格开工。
          if (rec.status === 'done') doneIds.add(String(m.id))
          results.push(rec)
          d.dispatch.modules[m.id] = rec
        }
        d.touchedAt = Date.now()
      }

      // 跨模块的一致性检查：有人写 ESM、有人写 CommonJS —— 单独看每份都可疑地正常，
      // 拼起来 100% import 失败。这种错最该由机器抓，不该等质检员。
      const sysOf = new Map()
      for (const r of results) {
        const kinds = new Set()
        for (const f of r.files || []) {
          try {
            const k = detectModuleSystem(readFileSync(join(cwd, f), 'utf8'))
            if (k !== 'unknown') kinds.add(k)
          } catch { /* 文件不在的问题上面已经报过了 */ }
        }
        const label = [...kinds].sort().join('+')
        if (label) { sysOf.set(r.id, label); r.moduleSystem = label }
      }
      const kindsSeen = new Set([...sysOf.values()].map((s) => (s.includes('cjs') ? 'cjs' : 'esm')))
      if (kindsSeen.size > 1) {
        for (const [id, label] of sysOf) {
          const r = d.dispatch.modules[id]
          if (!r) continue
          const minority = label.includes('cjs') ? 'cjs' : 'esm'
          const msg = `模块系统不一致：这个模块是 ${minority.toUpperCase()}（${label}），另一些模块是 ${minority === 'cjs' ? 'ESM' : 'CommonJS'} —— 单独看没问题，拼在一起运行时一定失败。统一改成同一种。`
          r.issues = [...(r.issues || []), { level: 'error', where: id, msg }]
          if (r.status === 'done') r.status = 'blocked'
        }
      }

      const stillBad = results.filter((r) => r.status !== 'done')
      // 项目级声明检查：三个文件彼此一致不等于"这个项目认它们是 ESM"。
      // 目录里没有 package.json 时，Node 靠语法探测（≥22.7 才行）；带 "type":"commonjs"
      // 的包里，export/import 立刻全炸。这种跨文件的锅，没有任何模块的写域认领。
      let pkgNote = ''
      {
        let dir = cwd
        let pkg = null
        for (let i = 0; i < 6 && dir; i++) {
          const p = join(dir, 'package.json')
          if (existsSync(p)) { try { pkg = { path: p, json: JSON.parse(readFileSync(p, 'utf8')) } } catch { pkg = { path: p, json: null } } break }
          const up = dirname(dir)
          if (up === dir) break
          dir = up
        }
        const usesEsm = [...sysOf.values()].some((s) => s.includes('esm'))
        const pkgType = pkg?.json?.type
        if (usesEsm && pkgType === 'commonjs') {
          pkgNote = `! 项目声明冲突：${pkg.path} 写着 "type": "commonjs"，而模块是 ESM —— 落到这个包里 import 会直接失败。要么改 package.json，要么把模块改成 CommonJS。`
        } else if (usesEsm && !pkg) {
          pkgNote = '! 上面（6 层内）没有 package.json：Node ≥22.7 能靠语法探测把 .js 当 ESM，但只要这个目录被挪进任何 "type":"commonjs" 的包就会全炸。建议顺手加一个 package.json。'
        } else if (usesEsm && pkg && !pkgType) {
          pkgNote = `! ${pkg.path} 没有 "type" 字段（默认按 CommonJS 解释）：Node ≥22.7 会语法探测兜住，但显式写 "type": "module" 更稳。`
        }
      }
      if (pkgNote) d.dispatch.packageNote = pkgNote

      d.status = stillBad.length ? 'blocked' : 'integrating'
      d.touchedAt = Date.now()

      out.push(`派活完成（${results.length} 个模块，模型：${[...new Set(results.map((r) => d.seats.find((s) => s.id === r.seat)?.model).filter(Boolean))].join(' / ')}）`)
      out.push('')
      for (const r of results) {
        out.push(`${r.status === 'done' ? '✓' : '✗'} ${r.id}（${r.seat}）${r.files.length ? `　${r.files.join(', ')}` : ''}`)
        for (const i of r.issues) out.push(`   - [${i.where}] ${i.msg}`)
      }
      out.push('')
      out.push(stillBad.length
        ? `${stillBad.length} 个模块不合格。**这些差异就是"拼不上"的具体位置**：按上面每一条去改契约（写域/出口/模块系统/依赖）或返工重派（cabinet_dispatch 带 only 参数只重跑这几个），不要重跑全部。`
        : '全部通过机械检查。下一步：按 integration 把模块接到入口，跑一次构建/测试，然后 cabinet_integrate 交付。\n（需要语义复核就调 cabinet_audit，会用另一个席位的模型看接缝处）')
      if (capped.length) {
        out.push('')
        out.push(`⛔ ${capped.map((m) => m.id).join('、')} 已经返工 ${MAX_REWORK} 轮还不过，这次没有再派 —— 停下来问用户：契约改不改、换人写、还是砍掉。`)
      }
      return out.join('\n')
    },
  })

  tool({
    name: 'cabinet_audit',
    description: '交付前验收：**由首辅自己**（不派给阁员）读各模块交出来的东西，只看接缝处的语义是否真的一致（命名、单位、错误处理约定），'
      + '返回结构化结论。机械检查过不了的别浪费这一步。',
    properties: {
      moduleId: { type: 'string', description: '审哪个模块；不填就审全部已交付的' },
    },
    async run(args, exec) {
      const d = debateOf(exec.agent)
      if (!d) return '当前没有议政。'
      if (!d.dispatch) return '还没有派过活：先 cabinet_dispatch。'
      const backend = pickBackend(ctx)
      if (!backend) return '没有可用的 subagent 后端，审不了。'
      const mods = (d.contract?.modules || []).filter((m) => {
        const rec = d.dispatch.modules[m.id]
        if (!rec || rec.status !== 'done') return false
        return !args.moduleId || String(m.id) === String(args.moduleId)
      })
      if (!mods.length) return '没有可审的模块（还没交付成功的）。'

      const out = []
      // 质检员就是首辅自己：验收是组织者的活，不该再派给某个阁员
      // （谁写的谁不审，首辅一块都没写，所以它审每一块都不吃亏）。
      const qc = { id: 'chair', label: d.chairLabel || '内阁首辅', provider: d.chairCfg?.provider || '', model: d.chairCfg?.model || '' }
      const qcOpts = qc.provider && qc.model ? await seatAgentOptions(ctx, qc) : {}
      if (!qc.provider || !qc.model) out.push('! 还不知道首辅这一场用的是哪个模型（这一轮还没发过请求），验收先用会话默认模型跑')
      for (const m of mods) {
        const rec = d.dispatch.modules[m.id]
        const by = d.seats.find((s) => String(s.id) === String(m.seat))
        const ac = new AbortController()
        try {
          const schema = {
            type: 'object',
            properties: {
              verdict: { type: 'string', enum: ['ok', 'suspect'] },
              seamIssues: { type: 'array', items: { type: 'string' } },
              evidence: { type: 'string' },
            },
            required: ['verdict', 'seamIssues'],
            additionalProperties: false,
          }
          const basePrompt = auditPrompt(d, m, rec, qc)
          const askOnce = async (text) => {
            const act = await backend.sub.startActivation({
              provider: backend.name,
              label: `audit ${m.id}`,
              request: {
                cwd: d.cwd || process.cwd(),
                prompt: [{ type: 'text', text }],
                parent: exec.agent,
                agentOptions: qcOpts,
                outputSchema: schema,
              },
              signal: ac.signal,
              delivery: 'caller',
            })
            rec.childId = rec.childId || String(act.childId || '')
            const res = await act.result
            // 结构化回执拿不到时（子会话出错、或模型没调 structured_output），
            // 退一步从它的文字输出里找结论，别把"没回执"当成"接不上"。
            const s = res?.structured || parseVerdict(res?.output) || {}
            return { said: String(s.verdict || '').toLowerCase(), s, res, diag: String(res?.diagnostic || res?.stopReason || '') }
          }

          let { said, s, res, diag } = await askOnce(basePrompt)
          // 模型交白了（structured_output 里 verdict 是空串）时重问一次 —— 空结论等于白跑一趟。
          if (!said) {
            const retry = await askOnce(`${basePrompt}\n\n【上一轮你没有给出 verdict，被退回了】不要再读一遍文件，直接下结论：verdict 只能是 "ok" 或 "suspect"；有接不上的地方就写进 seamIssues。`)
            if (retry.said) ({ said, s, res, diag } = retry)
            else diag = retry.diag || diag
          }
          const ok = said === 'ok'
          rec.audit = {
            by: qc.label,
            verdict: said || 'no-verdict',
            seamIssues: Array.isArray(s.seamIssues) ? s.seamIssues.filter(Boolean) : [],
            evidence: String(s.evidence || ''),
            stopReason: String(res?.stopReason || ''),
            diagnostic: clip(diag, 300),
          }
          if (!said) {
            out.push(`? ${m.id} 首辅连着两次没给结论（${clip(diag || '无报错信息', 200)}），这条没被真正审过`)
          } else {
            if (!ok) rec.status = 'blocked'
            out.push(`${ok ? '✓' : '✗'} ${m.id} 首辅验收 ${by ? by.label : m.seat} 的活：${said}`)
            for (const x of rec.audit.seamIssues) out.push(`   - ${x}`)
            if (rec.audit.evidence) out.push(`   依据：${clip(rec.audit.evidence, 1200)}`)
          }
        } catch (e) {
          out.push(`! ${m.id} 质检跑挂了：${e?.message || e}（当"待人工确认"，不拦交付）`)
        }
      }
      const recs = Object.values(d.dispatch.modules)
      const bad = recs.filter((r) => r.status !== 'done')
      const audited = recs.filter((r) => r.audit && r.audit.verdict && r.audit.verdict !== 'no-verdict')
      d.status = bad.length ? 'blocked' : 'integrating'
      d.touchedAt = Date.now()
      out.push('')
      if (bad.length) {
        out.push(`还有 ${bad.length} 个模块没交付成功/被判拼不上：${bad.map((b) => b.id).join('、')}。按上面每条具体差异改。`)
      } else if (audited.length < recs.length) {
        // 别把"没审"说成"没问题"：这两件事对用户不是一回事。
        out.push(`${audited.length}/${recs.length} 个模块审过、都判 ok；还有 ${recs.length - audited.length} 个没被真正审过（见上面的 ? 行）。交付前建议你自己看一眼这几个，或者再调一次 cabinet_audit。`)
      } else {
        out.push(`全部 ${recs.length} 个模块都审过且判 ok：可以 cabinet_integrate 交付。`)
      }
      return out.join('\n')
    },
  })

  tool({
    name: 'cabinet_integrate',
    description: '交付：确认各模块已接到入口、整体能跑，落 delivered 并出一份交付说明。',
    properties: {
      summary: { type: 'string', description: '交付说明：改了什么、怎么验、哪些是妥协' },
      verified: { type: 'string', description: '你实际跑过的验证命令与结果（原样贴）' },
      files: { type: 'array', items: { type: 'string' }, description: '最终交付的文件清单' },
    },
    async run(args, exec) {
      const d = debateOf(exec.agent)
      if (!d) return '当前没有议政。'
      if (!d.dispatch) return '还没有派过活，没什么可整合的。'
      const bad = Object.values(d.dispatch.modules).filter((r) => r.status !== 'done')
      if (bad.length) return `还有 ${bad.length} 个模块没交付成功（${bad.map((b) => b.id).join('、')}），先修完再整合。`
      d.status = 'delivered'
      d.delivered = {
        at: Date.now(),
        summary: T(args.summary),
        verified: T(args.verified),
        files: Array.isArray(args.files) ? args.files.map(String) : Object.values(d.dispatch.modules).flatMap((r) => r.files || []),
      }
      d.speaker = 'chair'
      d.touchedAt = Date.now()
      return [
        `已交付（${d.delivered.files.length} 个文件）。`,
        d.decision ? `落地的是【${d.decision.n}】${d.decision.title}` : '',
        '',
        '文件清单：',
        ...d.delivered.files.map((f) => `· ${f}`),
        '',
        d.delivered.summary ? `说明：${d.delivered.summary}` : '',
        d.delivered.verified ? `验证：${d.delivered.verified}` : '',
      ].filter(Boolean).join('\n')
    },
  })

  /* ── 派活/审计用的提示词 ── */
  function modulePrompt(d, m, cwd) {
    const contract = d.contract
    const peers = (contract.modules || []).filter((x) => String(x.id) !== String(m.id))
    return [
      `你在一个多人并行项目里负责一个模块。项目根目录：${cwd}`,
      '',
      `【交付目标】${contract.goal || '（未写）'}`,
      d.decision ? `【已定方案】${d.decision.title}：${d.decision.summary}` : '',
      '',
      `【你负责】${m.id}　${m.title || ''}`,
      (() => {
        const me = (d.seats || []).find((s) => String(s.id) === String(m.seat))
        if (!me) return `· 派给你的席位：${m.seat || '（未指派）'}`
        return `· 派给你的人：${me.label}（${me.model}）${me.skill ? `　首辅按你的擅长指派：${me.skill}` : ''}`
      })(),
      `· 只能写这些路径（写域，越界就是事故）：${(m.writes || []).join('、') || '（未指定）'}`,
      `· 要交出来的东西（别人按这个来拼）：${(m.exports || []).map((e) => e.kind === 'file' ? e.path : `symbol ${e.name} from ${e.from}`).join('；') || '（无）'}`,
      `· 你依赖别人提供的：${(m.imports || []).map((i) => `${i.from}.${i.symbol}`).join('；') || '（不依赖别人）'}`,
      `· 验收标准：${(m.acceptance || []).join('；') || '（未写）'}`,
      m.brief ? `\n【背景材料 · 首辅递给你的原始事实】\n${m.brief}` : '',
      '',
      `【别人的地盘 · 一个字都别动】`,
      ...peers.map((p) => `· ${p.id} ${p.title || ''}：${(p.writes || []).join('、')}`),
      '',
      '【别人承诺给你什么形状】—— 你按这个调用，不要自己猜，也不要替他们改：',
      ...(m.imports || []).map((i) => {
        const pm = peers.find((p) => String(p.id) === String(i.from))
        const ex = (pm?.exports || []).map((e) => e.kind === 'file' ? `文件 ${e.path}` : `${e.name}（from ${e.from}）`).join('、')
        return `· ${i.from}.${i.symbol}${ex ? `　它承诺的出口：${ex}` : ''}`
      }),
      (m.imports || []).length ? '' : '',
      '【硬性约束】',
      '0. **模块系统必须统一**：项目其它模块用的是 ' + (String(contract.moduleSystem || 'esm').toLowerCase() === 'cjs' ? 'CommonJS（require / module.exports）' : 'ESM（import / export）') + '。别混用 —— 混用的人单独看代码没问题，拼起来运行时一定失败。',
      '1. 只在你的写域里创建/修改文件。需要别人地盘里的东西，就按 imports 里承诺的接口去调用，**不要替他们写**。',
      '2. 进出口形状必须和 exports/imports 写的完全一致（名字、路径、参数顺序、返回形状）。你觉得契约有问题，就在 notes 里写清楚，不要自己改接口——改了别人就接不上。',
      '3. 能跑就跑一下（语法检查 / 单测），别交没验证过的东西。',
      '4. 结束时调用结构化输出工具（或直接按 schema 输出）回报：moduleId、done、files（你实际写/改的文件相对路径）、notes（做了什么、哪里有妥协、契约哪里可能有问题）。',
    ].filter(Boolean).join('\n')
  }

  function auditPrompt(d, m, rec, qc) {
    const by = d.seats.find((s) => String(s.id) === String(m.seat))
    return [
      `你是这场内阁的**首辅**（${qc.label}），现在做交付前的验收。这个模块不是你写的，是「${by ? by.label : m.seat}」写的 —— 你的活就是挑它接不上的地方。`,
      `项目根目录：${d.cwd || process.cwd()}`,
      '',
      `【交付目标】${d.contract?.goal || ''}`,
      `【被审模块】${m.id} ${m.title || ''}（由 ${m.seat} 完成）`,
      `· 写域：${(m.writes || []).join('、')}`,
      `· 承诺出口：${(m.exports || []).map((e) => e.kind === 'file' ? e.path : `${e.name} from ${e.from}`).join('；')}`,
      `· 依赖：${(m.imports || []).map((i) => `${i.from}.${i.symbol}`).join('；') || '无'}`,
      `· 验收标准：${(m.acceptance || []).join('；')}`,
      `· 它交付的文件：${(rec.files || []).join('、')}`,
      '',
      '去读这些文件，只回答一个问题：**它交出来的东西，别人按契约接上去会不会断？**',
      '重点看接缝：函数签名与返回值形状、命名约定、单位（px/em/ms）、错误处理方式（抛异常还是返回 null）、数据结构字段名。',
      '不要评论代码风格、不要建议重构、不要看没在契约里的东西。',
      'verdict=ok 只在"接得上"时给；有一处接不上就 suspect，并把具体差异写进 seamIssues（引文件名与行号）。',
      '最后**必须**调用 structured_output 提交 {verdict, seamIssues, evidence}；verdict 只能是 "ok" 或 "suspect"，**不许留空、不许写"无法判断"**——读完了就得下结论；seamIssues 在 ok 时可以给空数组。',
    ].join('\n')
  }

  /* ── ⑤ 设置页用的 HTTP 接口 ── */
  const json = (res, code, body) => {
    try {
      res.statusCode = code
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(body))
    } catch { /* 忽略 */ }
  }

  const readBody = (req) => new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy() })
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}) } catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/api/cabinet',
    handler: async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const p = url.pathname.replace(/^\/api\/cabinet/, '') || '/'

      if (p === '/state' && req.method === 'GET') {
        const all = [...debates.entries()].map(([sessionId, d]) => ({
          sessionId,
          topic: d.topic,
          status: d.status,
          speaker: whoLabel(d),
          speakerId: d.speaker,
          pendingAsk: d.pendingAsk,
          speeches: d.speeches.length,
          lastSpeeches: d.speeches.slice(-4).map((s) => ({ label: s.label, text: clip(s.text, 400) })),
          recent: d.speeches.slice(-30).map((s) => ({
            seat: s.seat,
            label: s.label,
            model: s.model,
            at: s.at,
            text: clip(s.text, 700),
          })),
          seats: d.seats.map((s) => ({ id: s.id, label: s.label, skill: s.skill || '', model: `${s.provider}/${s.model}` })),
          chairLabel: d.chairLabel,
          chairCfg: d.chairCfg || null,
          proposals: d.proposals,
          decision: d.decision || null,
          contract: d.contract || null,
          frameIssues: d.frameIssues || [],
          dispatch: d.dispatch
            ? { cwd: d.dispatch.cwd, startedAt: d.dispatch.startedAt, modules: Object.values(d.dispatch.modules || {}) }
            : null,
          delivered: d.delivered || null,
          seatActivity: seatActivityOf(d),
          nudges: d.nudges || 0,
          paused: d.paused || null,
          notes: (d.notes || []).slice(-8),
        }))
        return json(res, 200, { ok: true, build: BUILD, debatesFile: DEBATES_FILE, maxRework: MAX_REWORK, reqLog, debates: all })
      }

      if (p === '/seats' && req.method === 'GET') {
        return json(res, 200, { ok: true, ...loadSeats(), maxSeats: MAX_SEATS })
      }

      if (p === '/seats' && req.method === 'POST') {
        const body = await readBody(req)
        const saved = saveSeats(body)
        return json(res, 200, { ok: true, ...saved })
      }

      if (p === '/models' && req.method === 'GET') {
        const llm = ctx.get?.('llm')
        const out = []
        try {
          const provs = (await Promise.resolve(llm?.listProviders?.() ?? [])) || []
          for (const pv of provs) {
            const pid = String(pv?.provider ?? pv?.id ?? pv?.name ?? '')
            if (!pid) continue
            let models = []
            try { models = (await Promise.resolve(llm?.listModels?.(pid) ?? [])) || [] } catch { models = [] }
            out.push({
              provider: pid,
              label: String(pv?.label ?? pv?.title ?? pv?.name ?? pid) || pid,
              models: (models || [])
                .map((m) => {
                  const id = String(m?.id ?? m?.model ?? m?.value ?? m ?? '')
                  const name = String(m?.name ?? m?.displayName ?? m?.title ?? id)
                  return id ? { id, name: name || id } : null
                })
                .filter(Boolean),
            })
          }
        } catch { /* 忽略 */ }
        return json(res, 200, { ok: true, providers: out })
      }

      if (p === '/resolve' && req.method === 'GET') {
        const provider = url.searchParams.get('provider') || ''
        const model = url.searchParams.get('model') || ''
        const info = await modelInfoOf(ctx, provider, model)
        return json(res, 200, {
          ok: !!info,
          provider,
          model,
          efforts: effortIds(info),
          defaultEffort: info?.reasoning?.defaultEffort ?? null,
          contextWindow: info?.contextWindow ?? null,
        })
      }

      if (p === '/decide' && req.method === 'POST') {
        const body = await readBody(req)
        const sid = String(body.sessionId || '')
        const d = debates.get(sid)
        if (!d) return json(res, 200, { ok: false, error: '这个会话没有在进行中的议政' })
        if (!d.proposals || !d.proposals.length) return json(res, 200, { ok: false, error: '还没有方案可挑' })
        const n = Number(body.n)
        const p0 = d.proposals.find((x, i) => (Number.isFinite(n) ? i + 1 === n : false)) || d.proposals[n - 1]
        if (!p0) return json(res, 200, { ok: false, error: `没有第 ${body.n} 个方案` })
        const idx = d.proposals.indexOf(p0) + 1
        const via = String(body.via || 'panel')
        d.decision = { n: idx, title: p0.title, stance: p0.stance, summary: p0.summary, note: String(body.note || ''), at: Date.now(), via }
        d.status = 'decided'
        d.speaker = 'chair'
        d.touchedAt = Date.now()
        note(d, `${via === 'chat' ? '用户在对话里的方案卡上' : '用户在面板上'}选了方案 ${idx}「${p0.title}」`)
        persistSoon()
        return json(res, 200, { ok: true, decision: d.decision })
      }

      if (p === '/close' && req.method === 'POST') {
        const body = await readBody(req)
        const sid = String(body.sessionId || '')
        const d = sid ? debates.get(sid) : null
        if (d) {
          d.status = 'closed'
          d.speaker = 'chair'
          d.pendingAsk = null
          d.paused = null
          d.touchedAt = Date.now()
          debates.delete(sid)
          persistSoon()
        }
        return json(res, 200, { ok: true, closed: !!d })
      }

      return json(res, 404, { ok: false, error: `no route ${req.method} ${p}` })
    },
  }), 'cabinet: /api/cabinet')
}