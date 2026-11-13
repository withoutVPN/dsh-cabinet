// 把 frag-diagram.html 里的内联 SVG 抽成独立文件 docs/guide/timeline.svg，
// 好让 GitHub 的 README 能直接显示（GitHub 不渲染 HTML 里的内联 SVG）。
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, 'frag-diagram.html'), 'utf8')
const m = src.match(/<svg[\s\S]*?<\/svg>/)
if (!m) {
  console.error('✗ 没找到 <svg>')
  process.exit(1)
}
let svg = m[0]
// 独立文件的默认尺寸要显式给出，别依赖页面 CSS
svg = svg.replace(/\s+style="[^"]*"/, '')
svg = svg.replace(/<svg([^>]*?)width="[^"]*"/, '<svg$1width="1440"')
svg = svg.replace(/<svg([^>]*?)height="[^"]*"/, '<svg$1height="530"')
// GitHub 把 SVG 当 <img> 塞进页面，currentColor 没有父级可继承 → 会把文字画成黑，
// 深色主题下就成了黑底黑字。所以定死白底 + 深色字，两种主题下都可读。
svg = svg.replace('fill="currentColor"', 'fill="#1f2023"')
svg = svg.replace(/<svg([^>]*)>/, '<svg$1><rect x="0" y="0" width="100%" height="100%" fill="#ffffff"/>')
const out = '<?xml version="1.0" encoding="UTF-8"?>\n' + svg + '\n'
fs.writeFileSync(path.join(__dirname, 'timeline.svg'), out, 'utf8')
console.log('✓ timeline.svg ' + out.length + ' 字符，text 节点 ' + (svg.match(/<text/g) || []).length)