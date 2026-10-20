import React from 'react'
import { useAtom, useAtomValue, useStore } from 'jotai'
import type { AttachmentInfo, AttachmentPreview, ComposerDraft, SendReceipt } from '../../shared/attachment-types'
import { ATTACHMENT_LIMITS } from '../../shared/attachment-types'
import { isTextAttachmentName } from '../../shared/attachment-formats'
import { composerDraftFamily, composerLoadedFamily, composerScopeAtom, draftKey } from '../composer-state'
import { extractPastedImages } from '../lib/paste-extract'
import type { PastedImageRef } from '../../shared/types'

export interface ComposerSubmission { draft: ComposerDraft; client_message_id: string }
export type ComposerSend = (text: string, images?: PastedImageRef[], submission?: ComposerSubmission) => void | Promise<SendReceipt>
export function useComposer(onSend?: ComposerSend, onSent?: () => void) {
  const store = useStore()
  const scope = useAtomValue(composerScopeAtom)
  const key = draftKey(scope)
  const draftAtom = composerDraftFamily(key)
  const [draft, setDraft] = useAtom(draftAtom)
  const [loaded, setLoaded] = useAtom(composerLoadedFamily(key))
  const [error, setError] = React.useState<string | null>(null)
  const [sending, setSending] = React.useState(false)
  const [importing, setImporting] = React.useState(0)
  const [importFailure, setImportFailure] = React.useState(false)
  const [previews, setPreviews] = React.useState<Record<string, AttachmentPreview>>({})
  const [legacyImages, setLegacyImages] = React.useState<Array<PastedImageRef & { dataUrl: string }>>([])
  const sendLock = React.useRef(false)
  const api = window.electronAPI?.composer
  const aliveKey = React.useRef(key)
  aliveKey.current = key
  React.useEffect(() => { setError(null); setImportFailure(false) }, [key])
  React.useEffect(() => {
    if (loaded) return
    if (!api) { setLoaded(true); return }
    const before = store.get(draftAtom)
    void api.load({ request_id: crypto.randomUUID(), ...scope }).then(result => {
      if (!result.ok) { if (aliveKey.current === key) setError(result.error.message); return }
      const current = store.get(draftAtom)
      if (current.revision === before.revision && result.data.revision >= current.revision) store.set(draftAtom, result.data)
      else store.set(draftAtom, { ...current, revision: Math.max(current.revision, result.data.revision + 1) })
      store.set(composerLoadedFamily(key), true)
    }).catch(reason => { if (aliveKey.current === key) setError(String(reason)) })
  }, [key, loaded, api, store])
  React.useEffect(() => {
    if (!loaded || !api) return
    void api.save({ request_id: crypto.randomUUID(), draft }).then(result => {
      if (!result.ok && aliveKey.current === key) setError(`草稿保存失败：${result.error.message}`)
    }).catch(reason => { if (aliveKey.current === key) setError(`草稿保存失败：${String(reason)}`) })
  }, [draft, loaded, api])
  React.useEffect(() => {
    const pending = draft.pending_send
    if (!loaded || !pending || !api?.receipt) return
    let disposed = false
    const reconcile = async () => {
      try {
        const result = await api.receipt({ request_id: crypto.randomUUID(), session_id: scope.session_id, client_message_id: pending.client_message_id })
        if (disposed || !result.ok || !result.data || result.data.status === 'needs_recovery') return
        const current = store.get(draftAtom)
        if (current.pending_send?.client_message_id !== pending.client_message_id) return
        const unchanged = current.revision === pending.composer_revision && !pending.preserve_current
        const sent = new Set(pending.attachment_refs.map(ref => ref.attachment_id))
        const next = { ...current, text: unchanged ? '' : current.text, attachment_refs: current.attachment_refs.filter(ref => !sent.has(ref.attachment_id)), pending_send: undefined, revision: current.revision + 1 }
        store.set(draftAtom, next)
        const saved = await api.save({ request_id: crypto.randomUUID(), draft: next })
        if (!saved.ok && aliveKey.current === key) setError(`接收已确认，草稿清理保存失败：${saved.error.message}`)
      } catch (reason) { if (!disposed && aliveKey.current === key) setError(String(reason)) }
    }
    void reconcile()
    const timer = setInterval(() => void reconcile(), 2000)
    return () => { disposed = true; clearInterval(timer) }
  }, [key, loaded, draft.pending_send?.client_message_id, api])
  React.useEffect(() => {
    if (!api) return
    for (const ref of draft.attachment_refs) {
      if (previews[ref.attachment_id]) continue
      void api.preview({ request_id: crypto.randomUUID(), ...scope, ...ref }).then(result => {
        if (result.ok) setPreviews(previous => ({ ...previous, [ref.attachment_id]: result.data }))
        else if (aliveKey.current === key) setError(`材料失效，请移除或重新导入：${result.error.message}`)
      }).catch(reason => { if (aliveKey.current === key) setError(String(reason)) })
    }
  }, [key, draft.attachment_refs, api])
  const changeText = (text: string) => setDraft(previous => ({ ...previous, text, revision: previous.revision + 1 }))
  async function importFiles(files: File[]) {
    if (!api) { setError('当前接口尚不支持文件导入，请重启新版平台'); return }
    const targetAtom = draftAtom, targetScope = scope, targetKey = key
    setImporting(previous => previous + 1)
    try {
      for (const file of files) {
        const isImage = file.type.startsWith('image/')
        if (!isImage && !isTextAttachmentName(file.name)) throw new Error('暂不支持该文件：' + file.name + '（PDF/Word/压缩包后置）')
        const maxBytes = isImage ? ATTACHMENT_LIMITS.imageBytes : ATTACHMENT_LIMITS.textBytes
        if (file.size > maxBytes) throw new Error(file.name + ' 超过 ' + (isImage ? '5 MiB 图片' : '1 MiB 文本') + '上限')
        if (store.get(targetAtom).attachment_refs.length >= ATTACHMENT_LIMITS.files) throw new Error('每条消息最多 8 个附件')
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader(); reader.onerror = () => reject(new Error('文件读取失败：' + file.name))
          reader.onload = () => resolve(String(reader.result).split(',')[1] ?? ''); reader.readAsDataURL(file)
        })
        const response = await api.importImage({ request_id: crypto.randomUUID(), ...targetScope, name: file.name || '粘贴图片', base64, media_type: file.type || 'text/plain' })
        if (!response.ok) throw new Error(file.name + '：' + response.error.message)
        const info = response.data, latest = store.get(targetAtom)
        if (latest.attachment_refs.length >= ATTACHMENT_LIMITS.files) throw new Error('每条消息最多 8 个附件')
        const next = { ...latest, attachment_refs: [...latest.attachment_refs, { attachment_id: info.attachment_id }], revision: latest.revision + 1 }
        store.set(targetAtom, next)
        const saved = await api.save({ request_id: crypto.randomUUID(), draft: next })
        if (!saved.ok) throw new Error(saved.error.message)
        if (isImage) setPreviews(previous => ({ ...previous, [info.attachment_id]: { info, dataUrl: 'data:' + file.type + ';base64,' + base64 } }))
        else {
          const preview = await api.preview({ request_id: crypto.randomUUID(), ...targetScope, attachment_id: info.attachment_id })
          if (preview.ok) setPreviews(previous => ({ ...previous, [info.attachment_id]: preview.data }))
          else { setPreviews(previous => ({ ...previous, [info.attachment_id]: { info } })); if (aliveKey.current === targetKey) setError('已保存；预览未能加载：' + preview.error.message) }
        }
      }
    } catch (reason) { if (aliveKey.current === targetKey) { setError(reason instanceof Error ? reason.message : String(reason)); setImportFailure(true) } }
    finally { setImporting(previous => previous - 1) }
  }
  async function importItems(items: DataTransferItemList | null | undefined) {
    if (api) { await importFiles(Array.from(items ?? []).flatMap(item => item.kind === 'file' && item.getAsFile() ? [item.getAsFile()!] : [])); return }
    const targetKey = key
    const targetScope = scope
    const targetAtom = draftAtom
    setImporting(previous => previous + 1)
    try {
      const result = await extractPastedImages(items)
      if (result.rejected.length && aliveKey.current === targetKey) { setError(result.rejected[0].reason); setImportFailure(true) }
      for (const image of result.images) {
        if (legacyImages.length >= 4) throw new Error('每条消息最多 4 张图片')
          const response = await window.electronAPI?.pastedImage?.save({ request_id: crypto.randomUUID(), session_id: targetScope.session_id, base64: image.base64, ext: image.media_type.split('/')[1] })
          if (!response?.ok) throw new Error('图片保存失败，请重试；草稿已保留')
          if (aliveKey.current === targetKey) setLegacyImages(previous => [...previous, { ...response.data, dataUrl: `data:${image.media_type};base64,${image.base64}` }])
      }
    } catch (reason) { if (aliveKey.current === targetKey) { setError(reason instanceof Error ? reason.message : String(reason)); setImportFailure(true) } }
    finally { setImporting(previous => previous - 1) }
  }
  async function send() {
    if (!onSend || sendLock.current || importing || importFailure || (api && !loaded)) return
    const current = store.get(draftAtom)
    const pending = current.pending_send ?? { client_message_id: crypto.randomUUID(), text: current.text.trim(), attachment_refs: current.attachment_refs, revision: current.revision }
    if (!pending.text && !pending.attachment_refs.length && !legacyImages.length) return
    sendLock.current = true
    setSending(true)
    setError(null)
    const snapshot: ComposerDraft = { ...current, text: pending.text, attachment_refs: pending.attachment_refs, revision: pending.revision }
    let acceptedRevision = current.revision
    const preserveCurrent = pending.preserve_current || Boolean(current.pending_send && current.revision !== pending.composer_revision)
    try {
      if (api) {
        acceptedRevision = current.revision + 1
        const next = { ...current, pending_send: { ...pending, composer_revision: acceptedRevision, preserve_current: preserveCurrent }, revision: acceptedRevision }
        store.set(draftAtom, next)
        const saved = await api.save({ request_id: crypto.randomUUID(), draft: next })
        if (!saved.ok) throw new Error(saved.error.message)
      }
      const images = legacyImages.length ? legacyImages.map(({ imageId, media_type }) => ({ imageId, media_type })) : undefined
      let receipt: SendReceipt | void
      if (api) receipt = await onSend(snapshot.text, undefined, { draft: snapshot, client_message_id: pending.client_message_id })
      else {
        const result = images ? onSend(snapshot.text, images) : onSend(snapshot.text)
        receipt = result instanceof Promise ? await result : result
      }
      if (api && !receipt) throw new Error('未收到接收确认，草稿与待确认消息已保留')
      if (receipt?.status === 'needs_recovery') throw new Error('消息已接收，材料和发送记录已保留。请在消息记录中选择继续执行或不再执行。')
      const latest = store.get(draftAtom)
      const unchanged = latest.revision === acceptedRevision && !preserveCurrent
      const sentRefs = new Set(snapshot.attachment_refs.map(ref => ref.attachment_id))
      const next = { ...latest, text: unchanged ? '' : latest.text, attachment_refs: latest.attachment_refs.filter(ref => !sentRefs.has(ref.attachment_id)), pending_send: undefined, revision: latest.revision + 1 }
      store.set(draftAtom, next)
      if (api) {
        const saved = await api.save({ request_id: crypto.randomUUID(), draft: next })
        if (!saved.ok) throw new Error(`已接收；草稿清理未保存：${saved.error.message}`)
      }
      if (aliveKey.current === key) setLegacyImages([])
      if (aliveKey.current === key) onSent?.()
    } catch (reason) { if (aliveKey.current === key) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { sendLock.current = false; setSending(false) }
  }
  const images = api ? draft.attachment_refs.map(ref => ({ id: ref.attachment_id, dataUrl: previews[ref.attachment_id]?.dataUrl, info: previews[ref.attachment_id]?.info, name: previews[ref.attachment_id]?.info.name ?? '材料' }))
    : legacyImages.map(image => ({ id: image.imageId, dataUrl: image.dataUrl, info: undefined as AttachmentInfo | undefined, name: '图片' }))
  function remove(id: string) {
    if (api) setDraft(previous => ({ ...previous, attachment_refs: previous.attachment_refs.filter(ref => ref.attachment_id !== id), revision: previous.revision + 1 }))
    else setLegacyImages(previous => previous.filter(image => image.imageId !== id))
    setError(null)
  }
  return { draft, images, error, setError, changeText, importItems, importFiles, send, remove, sending, importing, importFailure, dismissImportFailure: () => { setImportFailure(false); setError(null) }, ready: !api || loaded }
}
