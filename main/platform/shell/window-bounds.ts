/** Electron reports work area in DIP, so these bounds fit regardless of Windows DPI. */
export function initialWindowBounds(area: { width: number; height: number }) {
  const width = Math.min(1280, Math.max(1, area.width - 48))
  const height = Math.min(820, Math.max(1, area.height - 48))
  return { width, height, minWidth: Math.min(800, width), minHeight: Math.min(560, height) }
}
