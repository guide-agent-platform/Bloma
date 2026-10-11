export async function copyText(text: string): Promise<void> {
  const api = window.electronAPI?.clipboard
  if (api) {
    const result = await api.writeText({ request_id: crypto.randomUUID(), text })
    if (!result.ok) throw new Error(`复制失败：${result.error.user_visible_message ?? '请重试或选中文字后按 Ctrl+C'}`)
    return
  }
  if (!navigator.clipboard?.writeText) throw new Error('复制通道不可用，请选中文字后按 Ctrl+C')
  try { await navigator.clipboard.writeText(text) }
  catch { throw new Error('复制失败，请重试或选中文字后按 Ctrl+C') }
}
