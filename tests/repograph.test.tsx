import { expect, mock, test } from 'claude-code/testing'
import { build } from '../hooks/scan'
import { layout, nearest, raster } from '../hooks/layout'

const REPO: Record<string, string> = {
  'package.json': '{"name":"root"}',
  'packages/engine/package.json': '{"name":"@acme/engine"}',
  'packages/engine/src/index.ts': "export { place } from './place.js'\n",
  'packages/engine/src/place.ts': 'export function place(x) {\n  return snap(x)\n}\nfunction snap(x) {\n  return x\n}\n',
  'apps/web/lib/util.ts': 'export const fmt = (n: number) => String(n)\n',
  'apps/web/app/page.tsx': "import { place } from '@acme/engine'\nimport { fmt } from '@/lib/util'\nexport default function Page() {\n  return fmt(place(1))\n}\n",
  'api/models.py': 'def load():\n    return 1\n',
  'api/main.py': 'from api.models import load\nfrom .models import load as again\n\ndef handler():\n    return load()\n',
  'scripts/once.ts': 'console.log(1)\n',
  'README.md': '# not code',
}

test('files link through relative, .js-for-.ts, alias, workspace and python imports', () => {
  const g = build(REPO)
  const has = (a: string, b: string) => g.fileEdges.some(([x, y]) => x === a && y === b)
  expect(has('packages/engine/src/index.ts', 'packages/engine/src/place.ts')).toBe(true)
  expect(has('apps/web/app/page.tsx', 'packages/engine/src/index.ts')).toBe(true)
  expect(has('apps/web/app/page.tsx', 'apps/web/lib/util.ts')).toBe(true)
  expect(has('api/main.py', 'api/models.py')).toBe(true)
  expect(g.files.some(f => f.id === 'README.md')).toBe(false)
})

test('functions link through calls in the same file and in imported files', () => {
  const g = build(REPO)
  const has = (a: string, b: string) => g.fnEdges.some(([x, y]) => x === a && y === b)
  expect(has('packages/engine/src/place.ts#place', 'packages/engine/src/place.ts#snap')).toBe(true)
  expect(has('apps/web/app/page.tsx#Page', 'apps/web/lib/util.ts#fmt')).toBe(true)
  expect(has('api/main.py#handler', 'api/models.py#load')).toBe(true)
  expect(g.fns.map(f => f.label)).not.toContain('if')
})

test('layout keeps nodes on the canvas and pulls linked ones together', () => {
  const ids = ['a', 'b', 'c', 'x', 'y', 'z']
  const pos = layout(ids, [['a', 'b'], ['b', 'c'], ['a', 'c'], ['x', 'y'], ['y', 'z'], ['x', 'z']])
  for (const [px, py] of pos.values()) {
    expect(px >= 0 && px <= 1 && py >= 0 && py <= 1).toBe(true)
  }
  const d = (p: string, q: string) => Math.hypot(pos.get(p)![0] - pos.get(q)![0], pos.get(p)![1] - pos.get(q)![1])
  expect(d('a', 'b') < d('a', 'x')).toBe(true)
  expect(JSON.stringify([...layout(ids, [['a', 'b']])])).toBe(JSON.stringify([...layout(ids, [['a', 'b']])]))
})

test('raster draws dots, braille edges and labels, and clicks find the node', () => {
  const pos = new Map<string, [number, number]>([['a', [0.2, 0.5]], ['b', [0.8, 0.5]]])
  const style = { color: () => '#fff', edge: '#444', hot: '#a0f', dim: '#222', label: '#ddd' }
  const out = raster({ pos, edges: [['a', 'b']], focus: 'a', near: new Set(['a', 'b']), labels: ['a', 'b'], names: new Map([['a', 'alpha'], ['b', 'beta']]), big: new Set() }, 40, 10, { cx: 0.5, cy: 0.5, z: 1 }, style)
  const text = out.rows.map(r => r.map(s => s.t).join('')).join('\n')
  expect(text).toContain('●')
  expect(text).toContain('alpha')
  expect(/[⠁-⣿]/.test(text)).toBe(true)
  expect(out.rows.every(r => r.map(s => s.t).join('').length === 40)).toBe(true)
  const a = out.hits.find(h => h.id === 'a')!
  expect(nearest(out.hits, a.x + 1, a.y)).toBe('a')
  expect(nearest(out.hits, 0, 0)).toBe('')
})

const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

test('the pane scans the repo, shows the graph, and the tabs swap views', { timeoutMs: 20_000 }, async ($, on) => {
  const root = '/work/repo'
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  mock.store(on)
  on('session.cwd', () => ({ value: root }))
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.run', (_$: any, e: any) => (e.argv.includes('ls-files') ? ok(Object.keys(REPO).join('\0')) : ok('')))
  on('fs.read', (_$: any, e: any) => {
    const rel = String(e.path).slice(root.length + 1)
    if (rel in REPO) return { value: REPO[rel] }
    throw new Error(`ENOENT ${e.path}`)
  })
  await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true } as any)
  const res = await $.command.run({ command: 'repograph', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as any)
  expect(JSON.stringify(res)).toContain('Repo graph')
  await clock.settle()
  const props = { title: 'Repo graph', isFocused: true, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as any
  const ui = await $.ui.mount({ plugin: 'repograph', surface: 'terminal', component: 'Pane', requestId: 'repograph', props })
  await clock.settle()
  const drawn = async () => JSON.stringify(await ui.drawn()) + JSON.stringify(await ui.drawn({ in: 'canvas' }))
  let shown = await drawn()
  for (const word of ['Files', 'Graph', '6 files', 'links', '1 unlinked hidden']) expect(shown).toContain(word)

  await ui.post({ key: '1' }, { in: 'canvas' })
  await clock.settle()
  shown = await drawn()
  for (const word of ['packages', 'apps', 'api', 'scripts', '7 files']) expect(shown).toContain(word)

  // Open api/ and pick main.py: the graph tab comes back focused on it.
  await ui.post({ key: 'down' }, { in: 'canvas' }) // dirs first: api, apps, packages
  await ui.post({ key: 'up' }, { in: 'canvas' })
  await ui.post({ key: 'right' }, { in: 'canvas' })
  await ui.post({ key: 'down' }, { in: 'canvas' })
  await ui.post({ key: 'return' }, { in: 'canvas' })
  await clock.settle()
  shown = await drawn()
  expect(shown).toContain('api/main.py')
  expect(shown).toContain('imports (1): api/models.py')

  await ui.post({ key: 'm' }, { in: 'canvas' })
  await clock.settle()
  expect(await drawn()).toContain('calls (1)')
  await ui.unmount()
})
