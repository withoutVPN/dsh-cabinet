/**
 * lib/contract.js 的回归测试：这些判定就是"拼不上"的闸门，
 * 它们自己必须先在 0.9 之前被真的跑过一遍。
 *
 * 跑法：node --test test/contract.test.mjs（已接进 npm run check；传目录在 Node 24 会报 Cannot find module）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkContract,
  checkDelivery,
  normSig,
  parseSignature,
  runVerify,
  scaffold,
  signatureDiff,
} from '../lib/contract.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'cab-test-'))
const errs = (issues) => issues.filter((i) => i.level === 'error')
const flat = (issues) => issues.map((i) => i.msg).join('\n')

function goodContract() {
  return {
    goal: '加法器',
    moduleSystem: 'esm',
    modules: [
      {
        id: 'adder',
        seat: 's1',
        writes: ['adder.js'],
        exports: [{ kind: 'symbol', name: 'add', from: 'adder.js', signature: 'add(a: number, b: number): number' }],
        imports: [],
      },
      {
        id: 'ui',
        seat: 's2',
        writes: ['ui.js'],
        exports: [{ kind: 'symbol', name: 'render', from: 'ui.js', signature: 'render(el: string, sum: number): void' }],
        imports: [{ from: 'adder', symbol: 'add', signature: 'add(a: number, b: number): number', specifier: './adder.js' }],
      },
    ],
    integration: { entry: 'main.js', owner: 'chair' },
    verify: { all: 'node {entry}' },
  }
}

test('签名解析：空白/=>/: 的写法差异不算差异，参数与返回算', () => {
  assert.equal(normSig('add(a:number,b:number):number'), normSig('add(a: number, b: number) => number'))
  const sig = parseSignature('render(el: Map<string, number>, opts?: { a: 1 }): void')
  assert.equal(sig.name, 'render')
  assert.equal(sig.params.length, 2)
  assert.equal(sig.returns, 'void')
})

test('签名对比要说清差在哪（不是只说"不一致"）', () => {
  assert.match(signatureDiff('add(a: number): number', 'add(a: number, b: number): number'), /参数个数不同/)
  assert.match(signatureDiff('add(a: number): number', 'add(a: string): number'), /第 1 个参数不同/)
  assert.match(signatureDiff('add(a: number): number', 'add(a: number): string'), /返回类型不同/)
})

test('完整契约零错误', () => {
  assert.deepEqual(errs(checkContract(goodContract())), [])
})

test('出口没写签名 → 拦住（0.8.6 的核心漏洞）', () => {
  const c = goodContract()
  delete c.modules[0].exports[0].signature
  assert.match(flat(checkContract(c)), /没写签名/)
})

test('依赖形状对不上 → 拦住，并指出差在哪个参数', () => {
  const c = goodContract()
  c.modules[1].imports[0].signature = 'add(a: number, b: string): number'
  assert.match(flat(checkContract(c)), /形状对不上[\s\S]*第 2 个参数不同/)
})

test('import 没写 specifier → 拦住', () => {
  const c = goodContract()
  delete c.modules[1].imports[0].specifier
  assert.match(flat(checkContract(c)), /specifier 不合法/)
})

test('入口没人接 → 拦住；owner=chair 才放行', () => {
  const c = goodContract()
  c.integration = { entry: 'main.js' }
  assert.match(flat(checkContract(c)), /不在任何模块的写域里，也没人认领/)
  c.integration.owner = 'chair'
  assert.deepEqual(errs(checkContract(c)), [])
})

test('没写 verify.all → 拦住（不许"交付时再说"）', () => {
  const c = goodContract()
  delete c.verify
  assert.match(flat(checkContract(c)), /缺 verify\.all/)
})

test('模块 id 重复 → 拦住', () => {
  const c = goodContract()
  c.modules[1].id = 'adder'
  assert.match(flat(checkContract(c)), /id 重复/)
})

test('骨架：stub + 入口 + package.json 一次落好，且不覆盖已有实现', () => {
  const dir = tmp()
  const c = goodContract()
  const first = scaffold(dir, c)
  assert.ok(existsSync(join(dir, 'contract.json')))
  assert.ok(existsSync(join(dir, 'adder.js')))
  assert.ok(existsSync(join(dir, 'main.js')))
  assert.ok(existsSync(join(dir, 'package.json')))
  assert.match(readFileSync(join(dir, 'adder.js'), 'utf8'), /export function add\(a, b\)/)
  assert.match(readFileSync(join(dir, 'adder.js'), 'utf8'), /cabinet stub/)
  assert.match(readFileSync(join(dir, 'main.js'), 'utf8'), /export \* from '\.\/adder\.js'/)
  assert.ok(first.created.includes('adder.js'))

  // 写实现后再 scaffold：一个字节都不许动
  writeFileSync(join(dir, 'adder.js'), 'export function add(a, b) { return a + b }\n', 'utf8')
  const second = scaffold(dir, c)
  assert.equal(readFileSync(join(dir, 'adder.js'), 'utf8'), 'export function add(a, b) { return a + b }\n')
  assert.ok(second.kept.includes('adder.js'))
})

test('CJS 契约生成 CJS 骨架', () => {
  const dir = tmp()
  const c = goodContract()
  c.moduleSystem = 'cjs'
  c.modules[1].imports[0].signature = c.modules[0].exports[0].signature
  scaffold(dir, c)
  assert.match(readFileSync(join(dir, 'adder.js'), 'utf8'), /module\.exports = \{ add \}/)
  assert.doesNotMatch(readFileSync(join(dir, 'adder.js'), 'utf8'), /^export /m)
})

test('收活：承诺的出口文件没交上来 → 算错（0.8.6 在这里静默跳过）', () => {
  const dir = tmp()
  writeFileSync(join(dir, 'ui.js'), 'export function render() {}\n', 'utf8')
  const c = goodContract()
  const issues = checkDelivery(dir, c.modules[0], { done: true, files: ['ui.js'] }, c)
  assert.match(flat(issues), /承诺的出口 add 在 adder\.js，但回执里没有这个文件/)
})

test('收活：import 路径指不到对方交的文件 → 算错，并给出正确写法', () => {
  const dir = tmp()
  writeFileSync(join(dir, 'adder.js'), 'export function add(a, b) { return a + b }\n', 'utf8')
  writeFileSync(join(dir, 'ui.js'), "import { add } from './lib/wrong.js'\nexport function render() {}\n", 'utf8')
  const c = goodContract()
  const issues = checkDelivery(dir, c.modules[1], { done: true, files: ['ui.js'] }, c)
  const msg = flat(issues)
  assert.match(msg, /import 路径指到了契约之外/)
  assert.match(msg, /wrong\.js（这个文件不存在）/)
  assert.match(msg, /应该是 '\.\/adder\.js'/)
})

test('收活：路径写对了就不拦', () => {
  const dir = tmp()
  writeFileSync(join(dir, 'adder.js'), 'export function add(a, b) { return a + b }\n', 'utf8')
  writeFileSync(join(dir, 'ui.js'), "import { add } from './adder.js'\nexport function render() {}\n", 'utf8')
  const c = goodContract()
  assert.deepEqual(errs(checkDelivery(dir, c.modules[1], { done: true, files: ['ui.js'] }, c)), [])
})

test('签名解析：回调类型里的 => 不能把参数切乱', () => {
  const sig = parseSignature('run(cb: (x: number) => void, n: number): void')
  assert.equal(sig.params.length, 2)
  assert.equal(sig.returns, 'void')
})

test('签名解析：方法写法 render: (a) => b 也认得', () => {
  const sig = parseSignature('render: (el: string, sum: number) => void')
  assert.equal(sig.name, 'render')
  assert.equal(sig.params.length, 2)
  assert.equal(sig.returns, 'void')
})

test('跨模块重名出口 → 算错（入口 export * 会变成歧义）', () => {
  const c = goodContract()
  c.modules[1].exports[0].name = 'add'
  c.modules[1].exports[0].signature = 'add(el: string, sum: number): void'
  c.modules[1].imports[0].symbol = 'add'
  const msg = flat(errs(checkContract(c)))
  assert.match(msg, /两个模块都导出 add/)
})

test('symbol 出口写在别人的写域里 → 算错', () => {
  const c = goodContract()
  c.modules[0].exports[0].from = 'ui.js'
  const msg = flat(errs(checkContract(c)))
  assert.match(msg, /不在自己的 writes 里/)
})

test('收活：一个模块交了多个文件，缺出口文件只报一次', () => {
  const dir = tmp()
  writeFileSync(join(dir, 'ui.js'), 'export function render() {}\n', 'utf8')
  writeFileSync(join(dir, 'extra.js'), 'export const x = 1\n', 'utf8')
  const c = goodContract()
  const issues = checkDelivery(dir, c.modules[0], { done: true, files: ['ui.js', 'extra.js'] }, c)
  assert.equal(flat(issues).match(/承诺的出口 add 在 adder\.js/g).length, 1)
})

test('真跑：退出码 0 才算过，失败要留着输出尾巴', async () => {
  const dir = tmp()
  const ok = await runVerify(dir, 'node -e "process.exit(0)"')
  assert.equal(ok.ok, true)
  const bad = await runVerify(dir, 'node -e "console.error(\'拼不上\'); process.exit(3)"')
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 3)
  assert.match(bad.out, /拼不上/)
})

test('真跑：多个文件逐个验证，一个不过就算不过（0.9.2：只探第一个文件等于没探）', async () => {
  const dir = tmp()
  writeFileSync(join(dir, 'good.js'), 'export const a = 1\n', 'utf8')
  writeFileSync(join(dir, 'bad.js'), "throw new Error('拼不上')\n", 'utf8')
  const { runModuleVerify } = await import('../lib/contract.js')
  const r = await runModuleVerify(dir, 'node {file}', ['good.js', 'bad.js'])
  assert.equal(r.ok, false)
  assert.match(r.out, /bad\.js/)
})

test('type 出口：.ts 文件里可以约定，形状要能解析且名字对得上', () => {
  const c = goodContract()
  c.modules[1].writes.push('types.ts')
  c.modules[1].exports.push({ kind: 'type', name: 'TreeNode', from: 'types.ts', signature: 'type TreeNode = { id: string }' })
  assert.deepEqual(errs(checkContract(c)), [])
})

test('type 出口：放进 .js 文件 → 拦住（JS 里没有类型，运行时接不上）', () => {
  const c = goodContract()
  c.modules[1].exports.push({ kind: 'type', name: 'TreeNode', from: 'ui.js', signature: 'type TreeNode = { id: string }' })
  assert.match(flat(errs(checkContract(c))), /type 出口 TreeNode 只能放在/)
})

test('依赖类型形状不一致 → 拦住', () => {
  const c = goodContract()
  c.modules[1].writes.push('types.ts')
  c.modules[1].exports.push({ kind: 'type', name: 'TreeNode', from: 'types.ts', signature: 'type TreeNode = { id: string }' })
  c.modules[1].imports = []
  c.modules[0].imports = [{ from: 'ui', symbol: 'TreeNode', signature: 'type TreeNode = { id: number }', specifier: './types.ts' }]
  assert.match(flat(errs(checkContract(c))), /依赖类型 ui\.TreeNode 和对方承诺的不一致/)
})

test('骨架：type 出口也落一个 type stub（不生成运行时函数）', () => {
  const dir = tmp()
  const c = goodContract()
  c.modules[1].writes.push('types.ts')
  c.modules[1].exports.push({ kind: 'type', name: 'TreeNode', from: 'types.ts', signature: 'type TreeNode = { id: string }' })
  scaffold(dir, c)
  const text = readFileSync(join(dir, 'types.ts'), 'utf8')
  assert.match(text, /export type TreeNode = never/)
  assert.doesNotMatch(text, /function TreeNode/)
})

test('收活：声明了依赖却没在代码里出现 → 拦住（契约上接得漂亮，运行时没接上）', () => {
  const dir = tmp()
  writeFileSync(join(dir, 'ui.js'), 'export function render() {}\n', 'utf8')
  const c = goodContract()
  const msg = flat(errs(checkDelivery(dir, c.modules[1], { done: true, files: ['ui.js'] }, c)))
  assert.match(msg, /声明依赖了 adder\.add，但交付的代码里一次都没出现 add/)
})