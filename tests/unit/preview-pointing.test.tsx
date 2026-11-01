// @vitest-environment jsdom
import React from 'react'
import {render,fireEvent,cleanup,act} from '@testing-library/react'
import {afterEach,it,expect,vi} from 'vitest'
import {SketchViewport} from '../../renderer/components/SketchViewport'
import {PREVIEW_POINTER_EVENT} from '../../shared/sketch-viewport'
afterEach(()=>{cleanup();vi.restoreAllMocks()})
it('relays only the current iframe/token and bounded coordinates, including scaled previews', () => {
  render(<SketchViewport html="<p>预览</p>" />)
  const frame = document.querySelector('iframe')!, post = vi.spyOn(frame.contentWindow!, 'postMessage'), listener = vi.fn()
  frame.getBoundingClientRect = () => new DOMRect(600, 100, 640, 400)
  fireEvent.load(frame); const token = (post.mock.calls.at(-1)![0] as { token: string }).token
  window.addEventListener(PREVIEW_POINTER_EVENT, listener)
  const relay = (source: MessageEventSource | null, input: Record<string, unknown>) => act(() => window.dispatchEvent(new MessageEvent('message', { source, data: { type: PREVIEW_POINTER_EVENT, token, x: .25, y: .75, inside: true, ...input } })))
  relay(window, {}); relay(frame.contentWindow, { token: 'foreign' }); relay(frame.contentWindow, { x: Infinity }); relay(frame.contentWindow, { x: 2 })
  expect(listener).not.toHaveBeenCalled(); relay(frame.contentWindow, {})
  expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ clientX: 760, clientY: 400, inside: true })
  window.removeEventListener(PREVIEW_POINTER_EVENT, listener)
})
