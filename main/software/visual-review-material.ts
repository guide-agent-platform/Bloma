import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { findProject } from '../project/project-service'
import { requireLaunchDeclaration } from '../desktop/launch-smoke'
import { softwareVerificationFingerprint } from '../desktop/verification-fingerprint'
import { activeDebugSessionId, readDebugSession, openDebugSession, actDebugSession } from './debug-sessions'
import { MAX_PASTED_IMAGE_BYTES, savePastedImage, resolvePastedImagePath } from '../platform/shell/pasted-images'
import type { PastedImageRef } from '../../shared/types'

export const visualHash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
export interface VisualMaterial { project: string; parent: string; review: string; candidate: string; manifest_hash: string; image_hash: string; expires: number }
interface Manifest { version: 1; project: string; parent: string; review: string; candidate: string; image_hash: string; at: string; expires: number
  debug: { id: string; version: number; source: string; log_cursor?: number }; ui: unknown; steps: unknown; observations: unknown }
function directory(project: string, review: string) {
  if (![project, review].every(id => /^[A-Za-z0-9_-]+$/.test(id))) throw Error('VISUAL_MATERIAL_ID_INVALID')
  return join(getPromaHome(), 'software-quality-materials', project, review)
}
export async function captureVisualMaterial(projectId: string, parent: string, review: string, candidate: string, signal: AbortSignal, debugId?: string): Promise<VisualMaterial> {
  const root = findProject(projectId).root_path, source = softwareVerificationFingerprint(root)
  if (!source) throw Error('VISUAL_SOURCE_UNREADABLE')
  let id = debugId ?? activeDebugSessionId(projectId, parent)
  if (id) {
    const existing = readDebugSession(projectId, parent, id)
    if (existing.state !== 'ready' || existing.stale || existing.source !== source) throw Error('VISUAL_DEBUG_STALE_OR_NOT_READY')
  } else {
    const opened = await openDebugSession({ projectId, sessionId: parent, root, launch: requireLaunchDeclaration(root, 'VISUAL_LAUNCH_REQUIRED'), signal })
    id = opened.id
  }
  // Recapture pixels and DOM in one owned observation; arbitrary image paths and
  // parent assertions are never accepted as visual material.
  const snapshot = await actDebugSession({ projectId, sessionId: parent, id, signal, steps: [{ id: 'visual-capture', kind: 'expect', selector: 'body', nonempty: true }] })
  if (snapshot.stale || snapshot.state !== 'ready' || snapshot.source !== source || source !== softwareVerificationFingerprint(root)
    || !snapshot.screenshot || snapshot.screenshot_error || !snapshot.ui) throw Error('VISUAL_CAPTURE_INCOMPLETE')
  const bytes = readFileSync(snapshot.screenshot)
  if (!bytes.length || bytes.length > MAX_PASTED_IMAGE_BYTES || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw Error('VISUAL_IMAGE_INVALID')
  const expires = Date.now() + 30 * 60_000, image_hash = visualHash(bytes)
  const manifest: Manifest = { version: 1, project: projectId, parent, review, candidate, image_hash, at: new Date().toISOString(), expires,
    debug: { id, source, version: snapshot.version, log_cursor: snapshot.log_cursor }, ui: snapshot.ui,
    steps: snapshot.steps.slice(-64), observations: snapshot.observations }
  const base = directory(projectId, review), text = JSON.stringify(manifest)
  mkdirSync(base, { recursive: true }); writeFileSync(join(base, 'screen.png'), bytes); writeFileSync(join(base, 'manifest.json'), text)
  return { project: projectId, parent, review, candidate, image_hash, expires, manifest_hash: visualHash(text) }
}
export function readVisualMaterial(material: VisualMaterial, candidate: string) {
  if (material.candidate !== candidate || Date.now() > material.expires) throw Error('VISUAL_MATERIAL_EXPIRED_OR_STALE')
  const base = directory(material.project, material.review), text = readFileSync(join(base, 'manifest.json')), bytes = readFileSync(join(base, 'screen.png'))
  if (visualHash(text) !== material.manifest_hash || visualHash(bytes) !== material.image_hash) throw Error('VISUAL_MATERIAL_BYTES_CHANGED')
  const manifest = JSON.parse(text.toString()) as Manifest
  if (manifest.version !== 1 || manifest.project !== material.project || manifest.parent !== material.parent || manifest.review !== material.review
    || manifest.candidate !== candidate || manifest.image_hash !== material.image_hash || manifest.expires !== material.expires) throw Error('VISUAL_MATERIAL_IDENTITY_INVALID')
  return { manifest, bytes }
}
export function grantVisualImage(material: VisualMaterial, child: string): PastedImageRef {
  if (!/^[A-Za-z0-9_-]+$/.test(child) || child === material.parent) throw Error('VISUAL_CHILD_OWNER_INVALID')
  return savePastedImage(child, readVisualMaterial(material, material.candidate).bytes.toString('base64'), 'png')
}
export function validateVisualGrant(material: VisualMaterial, child: string, image: PastedImageRef) {
  readVisualMaterial(material, material.candidate)
  if (!image.imageId.startsWith(`${child}/`) || visualHash(readFileSync(resolvePastedImagePath(image.imageId))) !== material.image_hash) throw Error('VISUAL_GRANT_CHANGED_OR_NOT_OWNED')
}
/** Inspect the actual serialized request at the existing physical-request guard.
 * Both native wire protocols must carry PNG bytes, never names/OCR/data claims. */
export function assertVisualRequest(body: string, imageHash: string) {
  const request = JSON.parse(body), images: string[] = []
  for (const turn of request.messages ?? []) {
    if (!Array.isArray(turn.content)) continue
    for (const block of turn.content) {
      if (block.type === 'image' && block.source?.type === 'base64' && block.source.media_type === 'image/png') images.push(block.source.data)
      else if (block.type === 'image_url') {
        const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(block.image_url?.url ?? '')
        if (!match) throw Error('VISUAL_WIRE_IMAGE_INVALID')
        images.push(match[1])
      } else if (block.type === 'image') throw Error('VISUAL_WIRE_IMAGE_INVALID')
    }
  }
  if (!images.length || images.some(data => typeof data !== 'string' || visualHash(Buffer.from(data, 'base64')) !== imageHash)) throw Error('VISUAL_WIRE_IMAGE_MISSING_OR_CHANGED')
  return visualHash(body)
}
