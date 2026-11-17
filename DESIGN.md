# 二期设计稿：从「会开完」到「活干完」

一期（已跑通）只解决**议政**：召集 → 轮流发言 → 出方案 → 你挑。
这份稿子写给二期：**框架 → 分工 → 并行 → 拼装 → 交付**，以及首辅的实时监管。

---

## 1. 状态机

```
debate ──(你挑方案)──▶ decided ──(首辅出框架)──▶ framed
                                                │ 静态校验通过
                                                ▼
                                            dispatched ──▶ running ──▶ auditing
                                                                        │
                                            ┌──── 有模块不合格 ────────┤
                                            ▼                          ▼ 全绿
                                         blocked                     integrating ──▶ delivered
                                            │ 首辅改契约 / 返工
                                            └──────────▶ dispatched
```

- `decided`：你选定方案后由 `cabinet_decide({ n })` 写入，锁定方案原文。
- `framed`：首辅产出**机器可读的框架**（下节），此时会把契约贴给你看，你说「开工」才继续。
- 闸门只有两道：选方案、确认框架。其余阶段自动推进，但出问题就停在 `blocked` 等你发话。

## 2. 框架 = 接口契约（机器可读，不是散文）

首辅调用 `cabinet_frame({ contract })`，`contract` 结构：

```jsonc
{
  "goal": "一句话说清交付物",
  "moduleSystem": "esm",             // esm | cjs；决定骨架写法
  "modules": [
    {
      "id": "m1",
      "title": "渲染层",
      "seat": "s1",                  // 派给谁（席位 id）
      "writes": ["src/render/**"],   // 独占写域（glob）—— 并行安全的前提
      "reads":  ["src/core/types.ts"],
      "exports": [                   // 要交出来的东西：别人按这个来拼
        { "kind": "file", "path": "src/render/index.ts" },
        { "kind": "symbol", "from": "src/render/index.ts", "name": "renderTree",
          "signature": "renderTree(node: TreeNode | null): string" }
      ],
      "imports": [                   // 它依赖别人交什么（签名 + 现成 import 路径）
        { "from": "core", "symbol": "parseNode",
          "signature": "parseNode(raw: string): Node | null",
          "specifier": "../core/parse.js" }
      ],
      "acceptance": ["renderTree 对空树返回空字符串", "有单测"]
    }
  ],
  "integration": { "entry": "src/index.ts", "how": "首辅把各模块接到 entry 上",
                   "owner": "chair" },   // entry 没人写进 writes 时必须显式写这个
  "verify": { "module": "npx tsc --noEmit {file}",
              "all": "npx tsc --noEmit && node --test" }   // 必填：怎么算拼上了
}
```

**为什么非要这个结构**：并行干活最容易死在"各干各的、拼不上"。把「写哪里、交什么、依赖谁、**长什么样**、**import 怎么写**、**怎么算拼上了**」在开工前写成数据，才能*机械地*查得出来，而不是靠读代码猜。

0.9 的三条硬约束：出口必须有 `signature`（形状，不只是名字）；import 必须有 `specifier`（真实路径，由插件事先算好）且签名逐字相等；`integration.entry` 必须有主（某个模块的 `writes`，或 `owner: "chair"` 明写首辅接）。

## 3. 开工前的静态检查（不花模型钱）

`cabinet_frame()` 提交时、`cabinet_dispatch()` 派活前各跑一遍，任何一条不过就不往下走：

1. **模块 id 唯一且非空**。
2. **写域不相交**：`writes` glob 两两求交为空。（真冲突 → 让首辅改分工，而不是加锁）
3. **出口有形状**：每个 `symbol` 出口必须 `from` + `signature`，签名能解析、函数名与出口名一致；`type` 出口（0.9.2）必须落在 TS 文件里，`signature` 写成 `type X = …` 或 `interface X { … }`，名字与出口名一致。
4. **依赖可满足且形状一致**：`imports[i].from` 指向某模块 `id`，该模块真承诺了那个 symbol，且 `imports[i].signature` 与对方出口的 `signature` 归一化后**逐字相等**（差在参数个数 / 第几个参数 / 返回类型，逐条报出）。
5. **import 路径对得上**：`imports[i].specifier` 以 `.` 开头，且从消费方文件出发真能解析到目标出口文件。
5.5. **依赖类型也要对得上**（0.9.2）：`symbol` 与 `type` 出口都要求 `imports[i].signature` 存在，且归一化后与对方出口逐字相等。
6. **导出路径合法**：`file` 出口落在自己的 `writes` 里；`symbol` 出口的 `from` 也必须在自己的 `writes` 里（0.9.1 前只查前者，symbol 指到别人地盘要等收活才炸）。
6.5. **出口名跨模块不重名**：入口用 `export *` 汇总，重名会让这个名字在入口里变成歧义（两边单测都绿、`import` 它直接 SyntaxError）。
7. **无环**：模块依赖图拓扑可排（有环就把环上的边改掉，或者合并模块）。
8. **入口有主**：`integration.entry` 落在某模块的 `writes` 里，或 `integration.owner === "chair"`。
9. **验收命令必填**：`verify.all` 是字符串命令（模板变量 `{entry}` / `{file}` / `{files}` / `{cwd}`）或 `{ "manual": "说明" }`。

## 3.5 先落骨架再派活（0.9）

`cabinet_dispatch` 在起子会话之前，由插件自己把地整平：写 `contract.json`；按每个 `symbol` 出口生成 stub（带正确签名 + `throw new Error('cabinet stub: X 还没实现')`），按每个 `type` 出口生成 `export type X = never`（0.9.2）；生成入口聚合文件（ESM `export * from './x.js'`，CJS `module.exports = { ...require('./x.js') }`，CJS 入口跳过纯类型文件）；必要时补 `package.json`（`{"type":"module"}`）。**已存在的文件一律不覆盖**。于是：入口一定存在、目标文件一定存在、`import` 在写下的那一刻就解析得到；阁老要做的是把 stub 换成实现，而不是从零猜路径。

## 4. 并行执行

每个模块起一个**子会话**（`subagents` / `agentLoop.createAgent`），带：

- `agentOptions: { provider, model }` = 该席位配的模型（子会话独立上下文，真并行）；
- 任务提示 = 方案摘要 + 契约里属于它的那段 + 写域约束（"只许写 `writes` 里的路径"）+ 每条出口的签名原文 + 每条依赖的现成 `specifier`；
- 交付物 = 结构化回执 `{ moduleId, files[], notes, done, checks: [{cmd, ok, out}] }`（`outputSchema` 约束，避免散文）。

首辅**不参与写文件**，只维护状态和契约。

## 5. 收活后的检查 + 监管

每收一个模块就跑三层：

| 层 | 查什么 | 谁查 |
| --- | --- | --- |
| 机械 | 文件存在？声明的 export 真有？出口文件真交上来了？代码里真写下的每个相对 import 是否落在写域或 declared 依赖的出口上？**声明的依赖符号在代码里出现过没有**？写域没越界？ | 插件代码 |
| 契约 | 实际导出签名和 `exports` 一致？`acceptance` 每条能对上证据？ | 插件代码 + 质检员 |
| 真跑 | `verify.module` 在该文件上退出码为 0？（模板用 `{file}` 时逐文件跑；0.9.2 起异步 spawn，不阻塞宿主） | 插件代码 |
| 语义 | 两模块接缝处的语义是否真的一致（命名、单位、错误处理约定） | 质检员（另一席位模型）复核 |

全部模块交齐后，再按 `verify.all` **整体跑一次**（`{entry}` 换成入口），结果存进 `dispatch.verify`；退出码非 0 就 blocked 并贴输出尾巴。

任一层不过 → 该模块标 `blocked`，把**具体差异**（不是"有问题"）回给首辅，首辅决定：改契约 / 返工 / 换人。这就是"实时监管别人拼不上"的落点。

## 6. 整合

全部绿了以后，首辅在**主会话**里：

1. 按 `integration` 把各模块接到入口（入口已在骨架阶段建好，通常只需确认导出对得上）；
2. `cabinet_integrate()`：**没有 `dispatch.verify` 直接拒绝**；`ok === false` 拒绝并贴输出；`manual` 模式要求附上手验说明；
3. 出一份交付说明（改了什么、怎么验、哪些是妥协），`verified` 里自动拼上插件真跑的命令与退出码。

---

## 待你定的几件事

1. **工作区**：所有模块直接写同一个工作区（靠 `writes` 隔离），还是每个模块一个 git worktree（更干净，但整合要合并）？一期我倾向同工作区 + 写域隔离。
2. **并行度**：同时最多几个子会话？（模型并发别把额度打爆）
3. **质检员**：固定一个席位当质检，还是每次从没参与该模块的席位里挑？
4. **失败处理**：模块返工最多几轮？超过就停下来问你，还是首辅自己换策略？
5. **成本闸门**：要不要在派活前报一个"预计要跑几个子会话、几轮"让你点头？