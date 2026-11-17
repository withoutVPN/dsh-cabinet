/**
 * dsh-cabinet 的机械检查层：契约"形状"、接线路径、骨架生成、真跑验证。
 *
 * 为什么单独拆出来：这些判定必须能在**没有宿主**的情况下被真的跑一遍
 * （`node test/contract.test.mjs`）。以前它们埋在插件里，只能等一场会议
 * 撞上"拼不上"才发现错 —— 这就是 0.8.6 那一版最贵的一课。
 *
 * 这里只放纯逻辑 + 少量 fs/child_process；不 import 任何 DSH 宿主模块。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { spawn } from 'node:child_process'

export const BUILD = '0.9.2'

/* ══════════════════════════ 路径与写域 ══════════════════════════ */

export const normPath = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')

/** 把 `src/render/**` 这种写域收敛成目录前缀 `src/render` */
export const globRoot = (g) => normPath(g).replace(/\/\*\*?$/, '').replace(/\*.*$/, '').replace(/\/$/, '')

export function overlap(a, b) {
  const A = globRoot(a)
  const B = globRoot(b)
  if (!A || !B) return false
  return A === B || A.startsWith(`${B}/`) || B.startsWith(`${A}/`)
}

export function inside(file, glob) {
  const f = normPath(file)
  const g = globRoot(glob)
  return !!g && (f === g || f.startsWith(`${g}/`))
}

/** 出口/依赖能不能被机械地验收：只认 file 与 symbol 两种 kind */
export function exportKeys(mod) {
  const out = []
  for (const e of Array.isArray(mod?.exports) ? mod.exports : []) {
    if (!e) continue
    if (e.kind === 'file' && e.path) out.push(`file:${normPath(e.path)}`)
    if (e.kind === 'symbol' && e.name) out.push(`symbol:${String(e.name)}`)
    if (e.kind === 'type' && e.name) out.push(`type:${String(e.name)}`)
  }
  return out
}

export function findModule(contract, id) {
  return (contract?.modules || []).find((m) => String(m?.id) === String(id)) || null
}

/** 找到某个模块承诺的出口；symbol 精确匹配名字，file 按路径匹配 */
export function findExport(mod, symbol) {
  const s = String(symbol ?? '')
  const list = Array.isArray(mod?.exports) ? mod.exports : []
  return (
    list.find((e) => e && e.kind === 'symbol' && String(e.name) === s) ||
    list.find((e) => e && e.kind === 'type' && String(e.name) === s) ||
    list.find((e) => e && e.kind === 'file' && normPath(e.path) === normPath(s)) ||
    null
  )
}

/* ══════════════════════════ 签名：一行字，说清形状 ══════════════════════════ */

/**
 * 把 `add(a: number, b: number): number` 拆成 { name, params, returns }。
 * 解析不了就返回 null —— 那本身就是一个错，不该被当成"看起来一样"。
 */
export function parseSignature(raw) {
  const s = String(raw || '').trim().replace(/[;,\s]+$/, '')
  // 认这几种写法（契约里都可能出现，不该因为排版不同就报"看不懂"）：
  //   add(a: number, b: number): number
  //   async fetchUser(id: string): Promise<User>
  //   map<T>(xs: T[]): T[]
  //   render: (el: El, data: Data) => string
  const m = s.match(/^(?:async\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^<>]*>)?\s*(?::\s*)?\(([\s\S]*)\)\s*(?::|=>)?\s*([\s\S]*)$/)
  if (!m) return null
  return { name: m[1], params: splitParams(m[2]), returns: m[3].replace(/[;,\s]+$/, '').trim() }
}

/** 顶层逗号切参数：不切 () [] {} <> 和引号里的 */
function splitParams(text) {
  const src = String(text || '')
  const out = []
  let cur = ''
  let depth = 0
  let quote = ''
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quote) {
      cur += ch
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; cur += ch; continue }
    // 回调类型 `cb: (x) => void` 里的 `=>` 是箭头不是泛型右括号：
    // 整段吃掉，否则这个 '>' 会把 depth 减成负数，后面的逗号就再也切不开了。
    if (ch === '=' && src[i + 1] === '>') { cur += '=>'; i++; continue }
    if ('([{<'.includes(ch)) depth++
    if (')]}>'.includes(ch)) depth = Math.max(0, depth - 1)
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue }
    cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out.filter(Boolean)
}

/**
 * 归一化后逐字比对：空白、分号、`=>` 与 `:` 的写法差异不算差异，
 * 参数名/顺序/类型/返回类型/参数个数**算**。
 */
export function normSig(raw) {
  return String(raw || '')
    .replace(/\s+/g, ' ')
    .replace(/=>/g, ':')
    .replace(/\s*([(),{}\[\]<>])\s*/g, '$1')
    .replace(/\s*:\s*/g, ':')
    .replace(/\s*;+\s*$/, '')
    .trim()
}

/** 说清楚差在哪 —— 只说"不一致"等于没说 */
export function signatureDiff(a, b) {
  const A = parseSignature(a)
  const B = parseSignature(b)
  if (!A || !B) return `签名看不懂：\n      A: ${a}\n      B: ${b}`
  if (A.name !== B.name) return `函数名不同：${A.name} vs ${B.name}`
  if (A.params.length !== B.params.length) {
    return `参数个数不同：${A.params.length} vs ${B.params.length}\n      A: ${a}\n      B: ${b}`
  }
  for (let i = 0; i < A.params.length; i++) {
    if (normSig(A.params[i]) !== normSig(B.params[i])) {
      return `第 ${i + 1} 个参数不同：「${A.params[i]}」vs「${B.params[i]}」\n      A: ${a}\n      B: ${b}`
    }
  }
  if (normSig(A.returns) !== normSig(B.returns)) return `返回类型不同：「${A.returns || '(空)'}」vs「${B.returns || '(空)'}」`
  return `写法不同：\n      A: ${a}\n      B: ${b}`
}

/* ══════════════════════════ 开工前的静态检查 ══════════════════════════ */

/**
 * 返回 [{ level:'error'|'warn', msg, where }]。
 * 0.9 的三条硬规矩：出口要有形状、import 要有路径、入口要有主。
 */
export function checkContract(contract) {
  const issues = []
  const bad = (where, msg) => issues.push({ level: 'error', where, msg })
  const warn = (where, msg) => issues.push({ level: 'warn', where, msg })
  const mods = Array.isArray(contract?.modules) ? contract.modules : []
  if (!mods.length) bad('contract', '没有任何模块：至少要有 1 个')
  if (!contract?.integration?.entry) bad('contract', '缺少 integration.entry（最终接在哪个文件）')

  // 0) 模块 id 必须唯一 —— 重名会让 dispatch / import 指向错误的那一份
  const ids = new Set()
  for (const m of mods) {
    const id = String(m?.id ?? '').trim()
    if (!id) { bad('contract', '有模块没写 id'); continue }
    if (ids.has(id)) bad(id, `模块 id 重复：「${id}」出现不止一次`)
    ids.add(id)
  }

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

  // 2) 出口必须有形状：在哪、什么签名
  for (const m of mods) {
    for (const e of m.exports || []) {
      if (e?.kind !== 'symbol' && e?.kind !== 'type') continue
      if (!e.name) continue
      const file = normPath(e.from || e.path || '')
      if (!file) bad(m.id, `出口 ${e.name} 没写 from —— 它在哪个文件里？别人要 import 它`)
      if (e.kind === 'type') {
        if (file && !isTs(file)) bad(m.id, `type 出口 ${e.name} 只能放在 .ts/.tsx/.mts/.cts 文件里（JS 里没有类型，这种出口运行时不接不上）：${file}`)
        if (!e.signature) {
          bad(m.id, `type 出口 ${e.name} 没写签名 —— 写成 type ${e.name} = { … } 或 interface ${e.name} { … }`)
        } else {
          const t = parseTypeSignature(e.signature)
          if (!t) bad(m.id, `type 出口 ${e.name} 的签名看不懂：「${e.signature}」，要写成 type ${e.name} = … 或 interface ${e.name} { … }`)
          else if (t.name !== String(e.name)) bad(m.id, `出口名和签名对不上：出口叫 ${e.name}，签名写的却是 ${t.name}`)
        }
        continue
      }
      if (!e.signature) {
        bad(m.id, `出口 ${e.name} 没写签名（signature）—— 光有名字等于没约定形状。写成一行：${e.name}(a: number, b: number): number`)
      } else {
        const sig = parseSignature(e.signature)
        if (!sig) bad(m.id, `出口 ${e.name} 的签名看不懂：「${e.signature}」，要写成 ${e.name}(参数): 返回`)
        else if (sig.name !== String(e.name)) bad(m.id, `出口名和签名对不上：出口叫 ${e.name}，签名写的却是 ${sig.name}`)
      }
    }
  }

  // 3) 依赖可满足 + 形状一致 + 路径写死
  for (const m of mods) {
    for (const imp of m.imports || []) {
      const target = findModule(contract, imp?.from)
      if (!target) { bad(m.id, `依赖的模块 "${imp?.from}" 不存在`); continue }
      const exp = findExport(target, imp?.symbol)
      if (!exp) {
        bad(m.id, `依赖 ${imp.from} 的 "${imp?.symbol}"，但它没有在 exports 里承诺这个出口`)
        continue
      }
      if (!imp.specifier || !String(imp.specifier).startsWith('.')) {
        bad(m.id, `依赖 ${imp.from}.${imp.symbol} 的 specifier 不合法：「${imp.specifier ?? '(空)'}」—— 要写成从当前文件出发的相对路径，如 './${String(imp.symbol)}.js'`)
      }
      if (exp.kind === 'symbol') {
        if (!imp.signature) {
          bad(m.id, `依赖 ${imp.from}.${imp.symbol} 没写签名 —— 你按什么形状调它？照抄它的签名：${exp.signature || '(对方也没写)'}`)
        } else if (exp.signature && normSig(imp.signature) !== normSig(exp.signature)) {
          bad(m.id, `依赖 ${imp.from}.${imp.symbol} 的形状对不上：\n      ${signatureDiff(imp.signature, exp.signature)}`)
        }
      } else if (exp.kind === 'type') {
        if (!imp.signature) {
          bad(m.id, `依赖类型 ${imp.from}.${imp.symbol} 没写签名 —— 照抄它：${exp.signature || '(对方也没写)'}`)
        } else if (exp.signature && normSig(imp.signature) !== normSig(exp.signature)) {
          bad(m.id, `依赖类型 ${imp.from}.${imp.symbol} 和对方承诺的不一致：\n      A: ${imp.signature}\n      B: ${exp.signature}\n      （类型必须逐字一致，归一化后也不等）`)
        }
      }
    }
  }

  // 4) 导出的落点落在自己的写域里（file 和 symbol 都查 —— 只查 file 的话，
  //    symbol 的 from 可以写到别人的文件里，收活时才以"越界/缺文件"暴露）
  for (const m of mods) {
    const writes = Array.isArray(m?.writes) ? m.writes : []
    for (const e of m.exports || []) {
      if (e?.kind === 'file' && e.path) {
        if (!writes.some((w) => inside(e.path, w))) bad(m.id, `导出的文件 ${e.path} 不在自己的 writes 里 —— 交出来的东西必须是它写过的`)
        continue
      }
      if ((e?.kind === 'symbol' || e?.kind === 'type') && e.name) {
        const from = normPath(e.from || e.path || '')
        if (from && writes.length && !writes.some((w) => inside(from, w))) {
          bad(m.id, `出口 ${e.name} 落在 ${from}，但不在自己的 writes 里 —— 那是别人（或没人）的地盘，挪到自己的文件里`)
        }
      }
    }
  }

  // 4.5) 出口名跨模块不能重名：入口用 export * 汇总，重名会让这个出口在入口里
  //      变成歧义（import 它直接 SyntaxError），而且两边各自单测都是绿的
  const owner = new Map()
  for (const m of mods) {
    for (const e of m.exports || []) {
      if ((e?.kind !== 'symbol' && e?.kind !== 'type') || !e.name) continue
      const name = String(e.name)
      const prev = owner.get(name)
      if (prev && prev !== String(m.id)) {
        bad(`${prev}/${m.id}`, `两个模块都导出 ${name}：入口用 export * 汇总时这个名字会变成歧义（import 它直接 SyntaxError）—— 换个名字，或合并到一处只导出一次`)
      } else owner.set(name, String(m.id))
    }
  }

  // 5) 依赖图无环
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

  // 6) 入口必须有主：要么落在某模块写域，要么首辅认领（插件会先落骨架）
  const entry = normPath(contract?.integration?.entry || '')
  if (contract?.integration?.entry) {
    const owners = mods.filter((m) => (m.writes || []).some((w) => inside(entry, w)))
    const chairOwns = String(contract?.integration?.owner || '') === 'chair'
    if (owners.length > 1) bad('integration', `入口 ${entry} 同时属于 ${owners.map((m) => m.id).join('、')} 的写域`)
    else if (owners.length === 0 && !chairOwns) {
      bad('integration', `入口 ${entry} 不在任何模块的写域里，也没人认领 —— 要么写进某模块的 writes，要么写 integration.owner:"chair"（首辅自己接，插件会先落骨架）`)
    }
  }

  // 7) 怎么算"拼上了"必须先说清楚，否则交付时只能靠嘴
  const v = contract?.verify
  const all = v?.all
  if (!all) {
    bad('verify', '缺 verify.all —— 拼装怎么算"能跑"必须先写清楚：{"all":"node {entry}"} 或 {"all":{"manual":"打开 index.html 点一遍"}}')
  } else if (typeof all === 'string') {
    if (!/\{(entry|file|files|cwd)\}/.test(all)) warn('verify', `verify.all 里没有 {entry}/{file}/{cwd} 变量 —— 确认它验的是这次拼出来的东西：${all}`)
  } else if (!all.manual) {
    bad('verify', 'verify.all 既不是命令，也没有 manual 说明 —— 二者必居其一')
  }
  return issues
}

/** 分工检查：每个模块必须落到一位**真实存在**的阁老头上，而且别把活堆给同一个人 */
export function seatIssuesOf(d, contract) {
  const issues = []
  const mods = contract?.modules || []
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
export function detectModuleSystem(text) {
  const esm = /^\s*(export|import)\b/m.test(text)
  const cjs = /\bmodule\.exports\b|\bexports\.[A-Za-z_$]|\brequire\s*\(/.test(text)
  if (esm && !cjs) return 'esm'
  if (cjs && !esm) return 'cjs'
  if (esm && cjs) return 'mixed'
  return 'unknown'
}

/* ══════════════════════════ 骨架：先把"拼得上"写成文件 ══════════════════════════ */

const isCode = (f) => /\.(m?js|cjs|ts|jsx|tsx|mts|cts)$/i.test(String(f || ''))
const isTs = (f) => /\.(ts|tsx|mts|cts)$/i.test(String(f || ''))

/**
 * type 出口的签名：`type TreeNode = { id: string }` / `interface Node { … }`。
 * 类型只活在编译期，所以它们单独走一条路：不生成运行时 stub、不进模块探针，
 * 但入口的 `export *` 和 import 的 specifier 一样要接得上。
 */
export function parseTypeSignature(raw) {
  const m = String(raw || '').trim().match(/^(?:export\s+)?(type|interface)\s+([A-Za-z_$][\w$]*)\b/)
  return m ? { kind: m[1], name: m[2] } : null
}

/** 从签名里取一个能当形参用的名字；取不出来就 _argN（不同参数不会撞名） */
function paramName(raw, i) {
  let s = String(raw || '').trim()
  s = s.replace(/\s*=[\s\S]*$/, '').replace(/\?/g, '')
  s = s.replace(/\s*:[\s\S]*$/, '').trim()
  if (/^\.{3}[A-Za-z_$][\w$]*$/.test(s) || /^[A-Za-z_$][\w$]*$/.test(s)) return s
  return `_arg${i + 1}`
}

function symbolStub(name, signature, sys) {
  const sig = parseSignature(signature)
  const params = sig && sig.params.length ? sig.params.map(paramName) : ['...args']
  const body = `  throw new Error('cabinet stub: ${name}() 还没实现')`
  const fn = `function ${name}(${params.join(', ')}) {\n${body}\n}`
  return sys === 'cjs' ? fn : `export ${fn}`
}

function typeStub(name) {
  return `export type ${name} = never // cabinet 骨架：换成真类型（interface 也先落成 type，实现时按契约写）`
}

function stubFile(exps, sys) {
  const names = []
  const lines = [
    '// cabinet 骨架：出口名字和参数顺序已按契约固定，实现留给对应阁老。',
    '// 实现随便改，但别改这些出口的名字/参数顺序 —— 别的模块已经按它接了。',
    '',
  ]
  for (const e of exps) {
    const name = String(e.name)
    if (e?.kind === 'type') { lines.push(typeStub(name), ''); continue }
    names.push(name)
    lines.push(symbolStub(name, e.signature, sys), '')
  }
  if (sys === 'cjs' && names.length) lines.push(`module.exports = { ${names.join(', ')} }`, '')
  return lines.join('\n')
}

function entryStub(cwd, contract, sys) {
  const entry = normPath(contract.integration.entry)
  const dir = dirname(join(cwd, entry))
  const targets = []
  const typeOnly = new Set()
  for (const m of contract.modules || []) {
    for (const e of m.exports || []) {
      const f = e?.kind === 'symbol' || e?.kind === 'type' ? normPath(e.from || e.path || '') : e?.kind === 'file' ? normPath(e.path) : ''
      if (f && isCode(f) && !targets.includes(f)) targets.push(f)
      if (f && e?.kind === 'type') typeOnly.add(f)
    }
  }
  const rel = (t) => {
    let r = relative(dir, join(cwd, t)).replace(/\\/g, '/')
    if (!r.startsWith('.')) r = `./${r}`
    return r
  }
  if (sys === 'cjs') {
    return [
      '// cabinet 入口骨架：插件生成，把各模块的出口汇到一处，谁也不用猜路径。',
      'module.exports = {',
      ...targets.filter((t) => !typeOnly.has(t)).map((t) => `  ...require('${rel(t)}'),`),
      '}',
      '',
    ].join('\n')
  }
  return [
    '// cabinet 入口骨架：插件生成，把各模块的出口汇到一处，谁也不用猜路径。',
    ...targets.map((t) => `export * from '${rel(t)}'`),
    '',
  ].join('\n')
}

/** 向上找 6 层有没有 package.json —— 有的话模块类型由它决定，不能乱写 */
function nearestPackageJson(cwd) {
  let dir = cwd
  for (let i = 0; i < 6; i++) {
    const p = join(dir, 'package.json')
    if (existsSync(p)) return p
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return null
}

/**
 * 派活前把"拼得上"先落成文件：contract.json、每个出口的 stub、入口聚合文件、必要时 package.json。
 * **已存在的文件绝不覆盖** —— 返工重派时幂等，也不会抹掉已经写好的实现。
 */
export function scaffold(cwd, contract) {
  const sys = contract?.moduleSystem === 'cjs' ? 'cjs' : 'esm'
  const created = []
  const kept = []
  const put = (rel, text) => {
    const abs = join(cwd, rel)
    if (existsSync(abs)) { kept.push(rel); return false }
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, text, 'utf8')
    created.push(rel)
    return true
  }

  // 契约本身存一份，子会话和首辅看的都是它
  const contractFile = join(cwd, 'contract.json')
  writeFileSync(contractFile, JSON.stringify({ ...contract, scaffoldedAt: new Date().toISOString(), build: BUILD }, null, 2), 'utf8')

  // 每个 symbol 出口一个 stub（同一文件里的多个出口合到一个文件）
  for (const m of contract.modules || []) {
    const byFile = new Map()
    for (const e of m.exports || []) {
      if ((e?.kind !== 'symbol' && e?.kind !== 'type') || !e.name) continue
      const f = normPath(e.from || e.path || '')
      if (!f || !isCode(f)) continue
      if (!byFile.has(f)) byFile.set(f, [])
      byFile.get(f).push(e)
    }
    for (const [f, exps] of byFile) put(f, stubFile(exps, sys))
  }

  // 入口聚合文件：只在不存在时生成，且只对代码文件
  const entry = normPath(contract?.integration?.entry || '')
  let entryCreated = false
  if (entry && isCode(entry)) entryCreated = put(entry, entryStub(cwd, contract, sys))

  // ESM 项目在裸目录里跑不起来：没有 package.json 时补一个
  let pkg = null
  if (sys === 'esm' && !nearestPackageJson(cwd)) {
    pkg = 'package.json'
    if (put(pkg, JSON.stringify({ name: 'cabinet-project', private: true, type: 'module' }, null, 2) + '\n')) {
      // put 已经记进 created
    } else pkg = null
  }

  return { moduleSystem: sys, created, kept, entry, entryCreated, pkg }
}

/* ══════════════════════════ 真跑：命令怎么跑、怎么算过 ══════════════════════════ */

export function fill(cmd, vars) {
  return String(cmd || '').replace(/\{(entry|file|files|cwd)\}/g, (_, k) => String(vars?.[k] ?? ''))
}

/**
 * 跑一条命令。Windows 走 shell，超时就杀，输出只留尾巴（报错通常在最后）。
 * 返回 Promise<{ cmd, code, out, ok }> —— code 没拿到（被信号杀/启动失败）时按失败算。
 *
 * 为什么是异步：这是宿主进程，`spawnSync` 跑一条 `npm test` 会把整个
 * DSH 的其它会话一起卡住（最长 240 秒）。真跑验证不该以"别的工作全停"为代价。
 */
export function runCmd(cwd, cmd, timeoutMs = 240000) {
  const text = String(cmd || '').trim()
  if (!text) return Promise.resolve({ cmd: '', code: -1, out: '（空命令）', ok: false })
  return new Promise((done) => {
    let raw = ''
    let timedOut = false
    let settled = false
    const finish = (res) => { if (!settled) { settled = true; done(res) } }
    const keep = (chunk) => {
      raw += chunk
      if (raw.length > 64000) raw = raw.slice(-64000) // 防止一个爱刷屏的构建把内存吃光
    }
    let child
    try {
      child = spawn(text, { cwd, shell: true, windowsHide: true })
    } catch (e) {
      finish({ cmd: text, code: -1, out: String(e?.message || e), ok: false })
      return
    }
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill() } catch { /* 已经退了 */ }
      // Windows 上杀 shell 不等于杀它的子进程（npm.cmd 会留下一棵树）—— 补一刀
      if (process.platform === 'win32' && child.pid) {
        try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }) } catch { /* 尽力而为 */ }
      }
    }, timeoutMs)
    child.on('error', (e) => {
      clearTimeout(timer)
      finish({ cmd: text, code: -1, out: String(e?.message || e), ok: false })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const out = raw.trim()
      const tail = out.length > 4000 ? `…（前略）\n${out.slice(-4000)}` : out
      const finalCode = timedOut ? -1 : (typeof code === 'number' ? code : -1)
      const head = timedOut ? `（超时 ${Math.round(timeoutMs / 1000)}s，已终止）\n` : ''
      finish({
        cmd: text,
        code: finalCode,
        out: `${head}${tail}`.trim() || '(无输出)',
        ok: finalCode === 0,
      })
    })
  })
}

/** 跑 verify 模板；{entry} 之类没给值就原样留着，报错时一眼看得出是模板没填 */
export function runVerify(cwd, template, vars, timeoutMs) {
  return runCmd(cwd, fill(template, vars), timeoutMs)
}

/**
 * 模块自检：模板用 {file} 时逐文件跑（一个模块交多个文件时，每个都得能被单独 import），
 * 用 {files} 时跑一次全量。返回汇总结果（任一文件不过就算不过）。
 */
export async function runModuleVerify(cwd, template, files, timeoutMs) {
  const t = String(template || '')
  const list = (files || []).filter(isCode)
  if (!t.trim() || !list.length) return null
  const perFile = /\{file\}/.test(t) && !/\{files\}/.test(t)
  const targets = perFile ? list : [list[0]]
  const res = []
  for (const f of targets) {
    res.push(await runVerify(cwd, t, { file: f, files: list.join(' '), cwd }, timeoutMs))
  }
  const bad = res.filter((r) => !r.ok)
  return {
    cmd: res.map((r) => r.cmd).join(' && '),
    code: bad.length ? bad[0].code : 0,
    out: bad.length ? bad.map((r) => `${r.cmd}\n${r.out}`).join('\n') : (res[0]?.out || '(无输出)'),
    ok: !bad.length,
  }
}

/* ══════════════════════════ 收活：静态检查 + 真跑 ══════════════════════════ */

/**
 * 收活的机械检查：文件在不在、写域越没越界、承诺的出口有没有真的出现、
 * import 写出来的路径**是否真的指到对方交付的那个文件**。
 * 返回 [{ level, where, msg }]；真跑的部分在 dispatch 里做（要记录命令输出）。
 */
export function checkDelivery(cwd, mod, receipt, contract) {
  const issues = []
  const bad = (msg) => issues.push({ level: 'error', where: mod.id, msg })
  const files = Array.isArray(receipt?.files) ? receipt.files.map(normPath) : []
  if (!files.length) bad('回执里没有任何文件（files 为空）')

  // 承诺的出口文件必须交上来 —— 先整体比一次，免得每扫一个交付文件就重复报同一条
  const missingFrom = new Set()
  for (const e of mod.exports || []) {
    if ((e?.kind !== 'symbol' && e?.kind !== 'type') || !e.name) continue
    const from = normPath(e.from || e.path || '')
    if (!from || files.includes(from) || missingFrom.has(from)) continue
    missingFrom.add(from)
    bad(`承诺的出口 ${e.name} 在 ${from}，但回执里没有这个文件 —— 它大概是忘了交`)
  }

  const texts = new Map()
  for (const f of files) {
    if (!(mod.writes || []).some((w) => inside(f, w))) {
      bad(`越界写入：${f} 不在写域 ${(mod.writes || []).join(' / ')} 内`)
    }
    let text = ''
    try {
      text = readFileSync(join(cwd, f), 'utf8')
    } catch {
      bad(`文件不存在：${f}`)
      continue
    }
    texts.set(f, text)
    if (!text.trim()) bad(`文件是空的：${f}`)
    const sys = detectModuleSystem(text)
    for (const e of mod.exports || []) {
      if ((e?.kind !== 'symbol' && e?.kind !== 'type') || !e.name) continue
      const from = normPath(e.from || e.path || '')
      if (!from) continue
      if (f !== from) continue
      if (e.kind === 'type' && !isTs(f)) {
        bad(`type 出口 ${e.name} 落在了 ${f} —— 类型只能放在 .ts/.tsx 文件里`)
        continue
      }
      const head = e.kind === 'type' ? `export\\s+(type|interface)` : `export\\s+(default\\s+)?(async\\s+)?(function|class|const|let|var)`
      const esmRe = new RegExp(`(${head}\\s+${e.name}\\b)|(export\\s*\\{[^}]*\\b${e.name}\\b)`)
      const cjsRe = new RegExp(`(module\\.exports\\s*=\\s*\\{[^}]*\\b${e.name}\\b[^}]*\\})|(exports\\.${e.name}\\s*=)|(module\\.exports\\s*=\\s*${e.name}\\b)`)
      if (!esmRe.test(text) && !cjsRe.test(text)) {
        bad(
          sys === 'mixed'
            ? `${f} 里 ESM 和 CommonJS 混着用，而且找不到承诺的出口 ${e.name} —— 这种文件谁 import 都会出问题。`
            : `承诺的出口没出现：${e.name}（在 ${f}，既没有 ESM 的 export，也没有 module.exports 出来）`,
        )
      }
    }
  }

  // 声明了依赖，代码里却一次都没出现这个符号 —— 契约上接得再漂亮，运行时也没接上。
  // （拦不住"import 了却没用"，那是语义，归 cabinet_audit；拦得住"压根没写"。）
  const codeTexts = [...texts].filter(([f]) => isCode(f))
  for (const imp of mod.imports || []) {
    const sym = String(imp?.symbol || '')
    if (!sym) continue
    const target = findModule(contract, imp?.from)
    const exp = target ? findExport(target, sym) : null
    if (!exp || (exp.kind !== 'symbol' && exp.kind !== 'type')) continue
    if (!codeTexts.length) continue
    const seen = codeTexts.some(([, t]) => new RegExp(`\\b${sym}\\b`).test(t))
    if (!seen) {
      bad(`声明依赖了 ${imp.from}.${sym}，但交付的代码里一次都没出现 ${sym} —— 忘了 import / 忘了调用。要么真接上，要么把这条依赖从契约里删掉`)
    }
  }

  // import 路径必须真的指到对方交的那个文件（0.8.6 里这条靠消费方自觉）。
  // 两头都查：契约里写的 specifier 要指对；代码里**真写下的**每个相对路径也要指得着。
  const codeFiles = files.filter(isCode)
  const allowed = new Set(files.map((f) => resolve(cwd, f)))
  const hints = new Set()
  for (const imp of mod.imports || []) {
    const target = findModule(contract, imp?.from)
    const exp = target ? findExport(target, imp?.symbol) : null
    if (!target || !exp || exp.kind !== 'symbol') continue
    const want = normPath(exp.from || exp.path || '')
    if (!want) continue
    const targetAbs = resolve(cwd, want)
    allowed.add(targetAbs)
    const spec = String(imp.specifier || '')
    if (codeFiles.length) {
      const right = relSpecifier(codeFiles[0], want)
      if (spec && !codeFiles.some((f) => sameFile(resolve(dirname(join(cwd, f)), spec), targetAbs))) {
        hints.add(`import '${spec}'（${imp.from}.${imp.symbol}）应该写成 '${right}'`)
      } else {
        hints.add(`从 ${codeFiles[0]} 应该是 '${right}'（${imp.from}.${imp.symbol}）`)
      }
    }
  }
  if (codeFiles.length) {
    const badSpecs = []
    for (const f of codeFiles) {
      let text = ''
      try { text = readFileSync(join(cwd, f), 'utf8') } catch { continue }
      for (const spec of importSpecifiers(text)) {
        const abs = resolve(dirname(join(cwd, f)), spec)
        if (allowed.has(abs)) continue
        if (!existsSync(abs)) {
          badSpecs.push(`${f} 里的 '${spec}' → ${relFrom(cwd, abs)}（这个文件不存在）`)
          continue
        }
        if (!isCode(abs)) continue // 图片/样式等资源，存在就算接得上
        // 自己写域里的辅助文件也允许（不在回执里但确实存在）
        if ((mod.writes || []).some((w) => inside(relFrom(cwd, abs), w))) continue
        badSpecs.push(`${f} 里的 '${spec}' → ${relFrom(cwd, abs)}（既不是自己的文件，也不是 declared 依赖的出口）`)
      }
    }
    if (badSpecs.length) {
      bad(`import 路径指到了契约之外：${badSpecs.join('；')}。交付的文件里，每个相对 import 都必须落在自己的写域或某个 declared 依赖的出口上。正确写法见：${[...hints].join('，') || '（契约没写依赖）'}`)
    }
  }

  if (receipt?.done === false) bad('它自己报告没干完（done=false）')
  return issues
}

function sameFile(a, b) {
  // 只在 Windows 上折大小写：Linux 的 a.js 和 A.js 是两个文件，折了会误判"路径对了"
  const norm = (p) => {
    const s = resolve(p).replace(/\\/g, '/')
    return process.platform === 'win32' ? s.toLowerCase() : s
  }
  return norm(a) === norm(b)
}

function relSpecifier(fromFile, toFile) {
  let r = relative(dirname(fromFile), toFile).replace(/\\/g, '/')
  if (!r.startsWith('.')) r = `./${r}`
  return r
}

const relFrom = (cwd, abs) => normPath(relative(cwd, abs))

/** 文件里真写下的相对 import/require 路径（静态一眼，不需要执行） */
function importSpecifiers(text) {
  const out = []
  const re = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"\n]+)['"]/g
  let m
  while ((m = re.exec(String(text)))) if (m[1].startsWith('.')) out.push(m[1])
  return [...new Set(out)]
}