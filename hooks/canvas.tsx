import type { ClientModule } from 'claude-code'
import type { Seg } from './layout'

// Draws rows of colour runs and reports keys, clicks and drags to the mod.
export type CanvasProps = { rows: Seg[][] }
type Local = { down: [number, number] | null; last: [number, number] | null; moved: boolean }

const Canvas: ClientModule<CanvasProps, Local> = (props, surface) => {
  const { Box, Text } = surface.elements
  if (surface.state === undefined) surface.setState({ down: null, last: null, moved: false })
  surface.onPointer(e => {
    const cur = surface.state ?? { down: null, last: null, moved: false }
    if (e.type === 'down' && (e.button ?? 'left') === 'left') {
      surface.setState({ down: [e.x, e.y], last: [e.x, e.y], moved: false })
    } else if (e.type === 'move' && e.button && cur.last) {
      const [lx, ly] = cur.last
      if (e.x !== lx || e.y !== ly) {
        surface.post({ drag: [e.x - lx, e.y - ly] })
        surface.setState({ ...cur, last: [e.x, e.y], moved: true })
      }
    } else if (e.type === 'up' || e.type === 'leave') {
      if (e.type === 'up' && cur.down && !cur.moved) surface.post({ click: cur.down })
      surface.setState({ down: null, last: null, moved: false })
    }
  })
  surface.onKey(e => surface.post({ key: e.key, shift: Boolean(e.shift) }))
  return (
    <Box flexDirection="column">
      {props.rows.map(row => (
        <Box flexDirection="row" height={1} overflow="hidden">
          {row.map(s => (
            <Text color={s.c} backgroundColor={s.bg} bold={s.b}>
              {s.t}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  )
}

export default Canvas
