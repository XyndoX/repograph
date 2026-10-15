import type { ClientModule } from 'claude-code'

// An empty box laid over the graph picture: it draws nothing and reports the
// pointer (with sub-cell precision where the terminal gives it) and the keys.
export type OverlayProps = { cols: number; rows: number }
type Local = { last: [number, number] | null; hover: string }

const Overlay: ClientModule<OverlayProps, Local> = (props, surface) => {
  const { Box } = surface.elements
  if (surface.state === undefined) surface.setState({ last: null, hover: '' })
  // Presses, drags and releases go to the mod as they happen; it decides what a
  // click is, so nothing here depends on state surviving between events.
  surface.onPointer(e => {
    const cur = surface.state ?? { last: null, hover: '' }
    const at: [number, number] = [e.fine?.x ?? e.x + 0.5, e.fine?.y ?? e.y + 0.5]
    if (e.type === 'down' && (e.button ?? 'left') === 'left') {
      surface.post({ press: at })
      surface.setState({ ...cur, last: at })
    } else if (e.type === 'move' && e.button) {
      const [lx, ly] = cur.last ?? at
      if (Math.abs(at[0] - lx) + Math.abs(at[1] - ly) >= 0.5) {
        surface.post({ drag: [at[0] - lx, at[1] - ly] })
        surface.setState({ ...cur, last: at })
      }
    } else if (e.type === 'move') {
      const cell = `${e.x},${e.y}`
      if (cell !== cur.hover) {
        surface.post({ hover: at })
        surface.setState({ ...cur, hover: cell })
      }
    } else if (e.type === 'up') {
      surface.post({ release: true })
      surface.setState({ ...cur, last: null })
    } else if (e.type === 'leave') surface.post({ hover: null })
  })
  surface.onKey(e => surface.post({ key: e.key }))
  return <Box width={props.cols} height={props.rows} />
}

export default Overlay
