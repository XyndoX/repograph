// The Changes tab: what git says changed since HEAD, and one file's diff.
import type { Seg } from './layout'

export type Change = { path: string; status: string; add: number; del: number }

// `git status --porcelain=v1 -z` → one entry per path. Renames carry their old path next.
export function parseStatus(z: string): Change[] {
  const parts = z.split('\0')
  const out: Change[] = []
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!
    if (p.length < 4) continue
    const xy = p.slice(0, 2)
    out.push({ path: p.slice(3), status: xy === '??' ? '?' : (xy.trim()[0] ?? 'M'), add: 0, del: 0 })
    if (xy[0] === 'R' || xy[0] === 'C') i++
  }
  // Tracked changes first (what the agent edited), then untracked files and folders.
  return out.sort((a, b) => Number(a.status === '?') - Number(b.status === '?') || a.path.localeCompare(b.path))
}

// `git diff HEAD --numstat` → line counts per path ("-" for binary files).
export function applyNumstat(changes: Change[], numstat: string): Change[] {
  const counts = new Map<string, [number, number]>()
  for (const line of numstat.split('\n')) {
    const [a, d, path] = line.split('\t')
    if (path) counts.set(path, [Number(a) || 0, Number(d) || 0])
  }
  return changes.map(c => ({ ...c, add: counts.get(c.path)?.[0] ?? c.add, del: counts.get(c.path)?.[1] ?? c.del }))
}

// A stamp for "has this file changed again since I reviewed it".
export const stamp = (c: Change) => `${c.status}|${c.add}|${c.del}`

export const STATUS_COLOR: Record<string, string> = { M: '#e5c07b', A: '#98c379', '?': '#98c379', D: '#e06c75', R: '#61afef', C: '#61afef', U: '#e06c75' }

// The diff as colour runs: hunks in cyan, adds green, removes red, file headers dropped.
export function diffRows(diff: string, cols: number): Seg[][] {
  const rows: Seg[][] = []
  for (const line of diff.split('\n')) {
    if (/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity|rename (from|to))/.test(line)) continue
    const t = line.replace(/\t/g, '  ')
    const shown = t.length > cols ? t.slice(0, cols - 1) + '…' : t
    const c = t.startsWith('@@') ? '#56b6c2' : t.startsWith('+') ? '#98c379' : t.startsWith('-') ? '#e06c75' : t.startsWith('\\') ? '#6b6b6b' : '#bdbdbd'
    rows.push([{ t: shown || ' ', c }])
  }
  while (rows.length && rows[rows.length - 1]![0]!.t === ' ') rows.pop()
  return rows
}

type Run = (argv: string[], opts: { timeoutMs: number }) => Promise<{ exitCode: number; stdout: string }>

// Reads status and line counts. `--no-optional-locks` so we never fight the agent's git.
export async function readChanges(run: Run, root: string): Promise<Change[] | null> {
  const git = (...args: string[]) => run(['git', '--no-optional-locks', '-C', root, ...args], { timeoutMs: 10_000 })
  const status = await git('status', '--porcelain=v1', '-z', '--untracked-files=normal')
  if (status.exitCode !== 0) return null
  const numstat = await git('diff', 'HEAD', '--numstat', '--no-renames')
  return applyNumstat(parseStatus(status.stdout), numstat.exitCode === 0 ? numstat.stdout : '')
}

export async function readDiff(run: Run, root: string, c: Change): Promise<string> {
  const git = (...args: string[]) => run(['git', '--no-optional-locks', '-C', root, ...args], { timeoutMs: 10_000 })
  // An untracked folder is one row: list what's in it.
  if (c.status === '?' && c.path.endsWith('/')) {
    const r = await git('ls-files', '--others', '--exclude-standard', '--', c.path)
    const files = r.stdout.split('\n').filter(Boolean)
    return [`@@ untracked folder: ${files.length} files @@`, ...files.slice(0, 2000).map(f => `+${f}`)].join('\n')
  }
  // An untracked file has no diff against HEAD: compare it with nothing (exit 1 means "differs").
  const r = c.status === '?' ? await git('diff', '--no-color', '--no-index', '--', '/dev/null', c.path) : await git('diff', 'HEAD', '--no-color', '--', c.path)
  return r.stdout.split('\n').slice(0, 3000).join('\n')
}
