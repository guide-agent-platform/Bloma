import React from 'react'
import body from '../../resources/studio/guide-pointing-body-v1.png'
import arm from '../../resources/studio/guide-pointing-arm-v1.png'
import reference from '../../resources/studio/guide-pointing-reference-v1.png'

export type GuideMaterialState = 'loading' | 'ready' | 'fallback'

/** Complete painted layers; the torso covers the hidden shoulder attachment. */
export const PointingGuide: React.FC<{ armRef: React.Ref<SVGGElement>; onMaterialState: (state: GuideMaterialState) => void }> = ({ armRef, onMaterialState }) => {
  const [loaded, setLoaded] = React.useState({ body: false, arm: false }), [failed, setFailed] = React.useState(false)
  const ready = loaded.body && loaded.arm && !failed
  React.useEffect(() => onMaterialState(failed ? 'fallback' : ready ? 'ready' : 'loading'), [failed, ready, onMaterialState])
  return <svg className="pointing-guide" viewBox="0 0 1145 1374" preserveAspectRatio="xMaxYMax meet" aria-hidden="true" focusable="false">
    <image data-guide-reference="true" href={reference} width="1145" height="1374" opacity={ready ? 0 : 1} />
    <g data-guide-composite="true" opacity={ready ? 1 : 0}>
      <g ref={armRef} data-guide-arm="true" transform="rotate(0 630 680)">
        <image data-guide-arm-layer="true" href={arm} width="1145" height="1374" onLoad={() => setLoaded(value => ({ ...value, arm: true }))} onError={() => setFailed(true)} />
      </g>
      <image data-guide-body="true" href={body} width="1145" height="1374" onLoad={() => setLoaded(value => ({ ...value, body: true }))} onError={() => setFailed(true)} />
    </g>
  </svg>
}
