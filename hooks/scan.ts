// Builds the dependency graph from file texts: file imports, and function calls.
// Regex based on purpose: no parser per language, so it's fast and dependency
// free, and it misses what regexes miss (dynamic dispatch, re-exports by name).

export type Node = { id: string; label: string; file: string; group: string }
export type Graph = { files: Node[]; fileEdges: [string, string][]; fns: Node[]; fnEdges: [string, string][] }

export const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|py|swift|go|rs|kt|java|rb|php|vue|svelte)$/
const JS = /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte)$/
const EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '/index.ts', '/index.tsx', '/index.js', '/index.jsx', '/index.mjs']

const group = (f: string) => (f.includes('/') ? f.split('/')[0]! : '.')
const dirname = (f: string) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '')

function normalize(p: string): string {
  const out: string[] = []
  for (const part of p.split('/')) {
    if (part === '..') out.pop()
    else if (part && part !== '.') out.push(part)
  }
  return out.join('/')
}

function tryFile(base: string, files: Set<string>): string | null {
  const bases = [base, base.replace(/\.(m|c)?js$/, '')] // TS ESM writes './x.js' for x.ts
  for (const b of bases) for (const ext of EXTS) if (files.has(b + ext)) return b + ext
  return null
}

function jsImports(text: string): string[] {
  const out: string[] = []
  const re = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(?\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const m of text.matchAll(re)) out.push((m[1] ?? m[2] ?? m[3])!)
  return out
}

function resolveJs(from: string, spec: string, files: Set<string>, pkgs: [string, string][]): string | null {
  if (spec.startsWith('.')) return tryFile(normalize(`${dirname(from)}/${spec}`), files)
  if (spec.startsWith('@/') || spec.startsWith('~/')) {
    // Path alias: try every ancestor folder of the importer, nearest first.
    const rest = spec.slice(2)
    const parts = dirname(from).split('/').filter(Boolean)
    for (let i = parts.length; i >= 0; i--) {
      const dir = parts.slice(0, i).join('/')
      const hit = tryFile(normalize(`${dir}/src/${rest}`), files) ?? tryFile(normalize(`${dir}/${rest}`), files)
      if (hit) return hit
    }
    return null
  }
  // Workspace package: `@acme/engine` or `@acme/engine/sub`.
  const pkg = pkgs.find(([name]) => spec === name || spec.startsWith(name + '/'))
  if (!pkg) return null
  const sub = spec.slice(pkg[0].length)
  return sub
    ? (tryFile(normalize(`${pkg[1]}/src${sub}`), files) ?? tryFile(normalize(pkg[1] + sub), files))
    : (tryFile(normalize(`${pkg[1]}/src/index`), files) ?? tryFile(normalize(`${pkg[1]}/index`), files))
}

function pyIndex(files: string[]): Map<string, string> {
  // Every dotted suffix of a module path, e.g. src/pkg/mod.py → mod, pkg.mod, src.pkg.mod.
  const index = new Map<string, string | null>()
  for (const f of files) {
    if (!f.endsWith('.py')) continue
    const parts = f.replace(/(\/__init__)?\.py$/, '').split('/')
    for (let i = 0; i < parts.length; i++) {
      const key = parts.slice(i).join('.')
      index.set(key, index.has(key) && index.get(key) !== f ? null : f) // ambiguous → null
    }
  }
  return new Map([...index].filter((e): e is [string, string] => e[1] !== null))
}

function pyImports(from: string, text: string, index: Map<string, string>): string[] {
  const out: string[] = []
  const add = (mod: string) => {
    const hit = index.get(mod)
    if (hit && hit !== from) out.push(hit)
  }
  for (const m of text.matchAll(/^\s*from\s+(\.*)([\w.]*)\s+import\s+([\w, ()*]+)/gm)) {
    const [, dots = '', mod = '', names = ''] = m
    let base = mod
    if (dots) {
      const dir = dirname(from).split('/').filter(Boolean)
      base = [...dir.slice(0, dir.length - (dots.length - 1)), ...(mod ? [mod] : [])].join('.')
    }
    for (const n of names.replace(/[()]/g, '').split(',').map(s => s.trim()).filter(Boolean)) add(base ? `${base}.${n}` : n)
    if (base) add(base)
  }
  for (const m of text.matchAll(/^\s*import\s+([\w., ]+)/gm)) for (const mod of m[1]!.split(',')) add(mod.trim().split(/\s/)[0]!)
  return out
}

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'constructor', 'super', 'else', 'do', 'try', 'with', 'elif', 'print', 'match'])
const DEF = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/,
  /^\s+(?:(?:public|private|protected|static|async|override|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{=]+)?\{\s*$/,
  /^\s*(?:async\s+)?def\s+(\w+)/,
  /^\s*(?:@\w+\s+)*(?:(?:public|private|fileprivate|internal|open|static|override|mutating|class)\s+)*func\s+(\w+)/,
  /^func\s+(?:\([^)]*\)\s*)?(\w+)/,
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/,
]

type Fn = { id: string; name: string; file: string; body: string }

function functions(file: string, text: string): Fn[] {
  const lines = text.split('\n')
  const starts: [number, string][] = []
  lines.forEach((line, i) => {
    for (const re of DEF) {
      const name = re.exec(line)?.[1]
      if (name && !KEYWORDS.has(name)) {
        starts.push([i, name])
        break
      }
    }
  })
  const seen = new Set<string>()
  return starts.flatMap(([at, name], k) => {
    if (seen.has(name)) return [] // overloads and same-named methods: first one stands for all
    seen.add(name)
    const body = lines.slice(at + 1, starts[k + 1]?.[0] ?? lines.length).join('\n')
    return [{ id: `${file}#${name}`, name, file, body }]
  })
}

export function build(texts: Record<string, string>): Graph {
  const all = Object.keys(texts).sort()
  const files = all.filter(f => CODE.test(f))
  const set = new Set(files)
  const pkgs: [string, string][] = []
  for (const f of all) {
    if (!f.endsWith('package.json') || f.includes('node_modules/')) continue
    try {
      const name = JSON.parse(texts[f]!).name
      if (typeof name === 'string' && dirname(f)) pkgs.push([name, dirname(f)])
    } catch { /* not json: skip */ }
  }
  pkgs.sort((a, b) => b[0].length - a[0].length)
  const py = pyIndex(files)

  const imports = new Map<string, Set<string>>()
  for (const f of files) {
    const text = texts[f]!
    const targets = JS.test(f)
      ? jsImports(text).map(s => resolveJs(f, s, set, pkgs))
      : f.endsWith('.py') ? pyImports(f, text, py) : []
    imports.set(f, new Set(targets.filter((t): t is string => Boolean(t) && t !== f)))
  }
  const fileEdges = files.flatMap(f => [...imports.get(f)!].map(t => [f, t] as [string, string]))

  // Calls: a defined name followed by `(` inside another function's body.
  // A name resolves to the same file first, then to files it imports, then to
  // a name defined exactly once in the repo. Anything else is too ambiguous.
  const fns = files.flatMap(f => functions(f, texts[f]!))
  const byName = new Map<string, Fn[]>()
  for (const fn of fns) byName.set(fn.name, [...(byName.get(fn.name) ?? []), fn])
  const fnEdges: [string, string][] = []
  for (const fn of fns) {
    const called = new Set<string>()
    for (const m of fn.body.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(|\.([A-Za-z_$][\w$]*)\s*\(/g)) called.add((m[1] ?? m[2])!)
    for (const name of called) {
      const cands = byName.get(name)
      if (!cands) continue
      const target =
        cands.find(c => c.file === fn.file) ??
        cands.find(c => imports.get(fn.file)?.has(c.file)) ??
        (cands.length === 1 && name.length > 3 ? cands[0] : undefined)
      if (target && target.id !== fn.id) fnEdges.push([fn.id, target.id])
    }
  }

  return {
    files: files.map(f => ({ id: f, label: f.split('/').pop()!, file: f, group: group(f) })),
    fileEdges,
    fns: fns.map(fn => ({ id: fn.id, label: fn.name, file: fn.file, group: group(fn.file) })),
    fnEdges,
  }
}
