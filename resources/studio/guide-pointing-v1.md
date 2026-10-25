# 聊天栏人物引导：完整分层素材

内置imagegen生成，透明RGBA，1145×1374。未使用CLI/API key。原有guide-sketch-v2.webp未改写。眼睛保留原画；不使用白眼底图或代码补瞳孔。当前素材：

- guide-pointing-reference-v1.png：完整参考与加载/错误时的保底。
- guide-pointing-body-v1.png：补全右侧身体和肩部遮挡的前景层。
- guide-pointing-arm-v1.png：带隐藏肩部重叠的完整手臂，绘于身体后方。

旋转中心(630,680)，范围±12度。不要从完整图硬裁手臂；不要给身体图加挖空mask。两层都加载成功后才切换为合成；错误时保持完整参考。正常眼睛固定在身体原画上。

## 最终提示词

### 完整参考

Use case: stylized-concept. Asset type: transparent upper-body character illustration for an interactive desktop software guide. Image 1 is a STYLE AND CHARACTER reference only; redesign the pose and framing for animation. Create one polished adult female anime guide, silver-lilac wavy hair, cream blouse with soft intact puff sleeves, muted lavender dress, small sage green bow and floral hair details. Gentle, intelligent, slightly playful expression. WAIST-UP, FRONT-FACING FACE, large clear open lavender eyes with visible white sclera and crisp separate iris boundaries, symmetrical natural face so small gaze changes can be animated later. Keep the face unobstructed by hair or hands. One complete anatomically correct right-pointing arm with its sleeve firmly connected to the shoulder; other hand rests naturally near her waist. The figure will emerge from a chat panel and point toward a workspace on her right (viewer right). Soft hand-painted anime/digital illustration matching the reference's refined finish, clean silhouette, no cut or detached limb pieces, no collage, no sprite sheet, no text, no UI, no speech bubble, no backdrop, no floor or frame. Portrait composition, character fully contained from head to waist, enough transparent margin around the pointing fingertip. Genuine transparent background and high-quality alpha edges. Do not include legs or skirt below the waist. The reference is not an edit target: make an original coherent waist-up design with continuous sleeves and a face suited for pupil animation.

### 身体层

Use case: precise-object-edit. This is the BODY layer of a two-layer 2D character rig, not a finished illustration. Edit target is Image 1. Preserve the exact normal face, purple irises and pupils, silver-lilac hair, beret, green bows, torso, lavender dress, resting hand and other arm. Remove ONLY the complete extended POINTING ARM on viewer-right, including its huge puff sleeve and hand, starting at the shoulder attachment. Reconstruct a smooth, closed cream blouse silhouette and a small rounded cream shoulder cap at that attachment so there are no holes, torn fabric, gaps or transparent cracks. This shoulder cap will be the FOREGROUND layer covering a rotating arm's attachment underneath; give it enough clean painted cloth overlap, approximately 40-60 source pixels. Rebuild hidden right side of the torso naturally where the removed arm overlapped it. Keep the body/face geometry and placement the same, and keep the exact full transparent 1145 x 1374 canvas with all original empty margins: no crop, no recenter, no rescale, no new pose. Real alpha background. No text, no extra detached parts, no diagrams. This intermediate body layer will be composited with a separately generated complete matching pointing arm behind the shoulder cap.

### 手臂层

Use case: background-extraction / animation sprite. Edit target: Image 1. Extract ONLY the complete viewer-right pointing arm: the entire cream puff sleeve continuously joined from its shoulder at approximately x=630,y=670 through the bent arm, frilled cuff, wrist, hand and right-pointing fingertip. Remove the character's head, torso, hair, other arm, dress, accessories and all other content to full transparency. Keep the pointing arm's exact size, pose, cloth color, folds, shading and canvas position from the reference. Reconstruct a generous rounded hidden attachment stub at its shoulder end, extending 70 pixels inward toward x=560,y=670, with continuous painted cream sleeve material; this hidden overlap will sit BEHIND a separate intact torso shoulder cap during a small +/-10 degree rotation. No hard severed visible shoulder edge, no holes or missing sleeve sections. Do not add any face, body or extra detached fragments. Keep the exact original 1145 x 1374 transparent canvas, including empty transparent margins; do not crop, recenter or rescale the arm. A clean standalone RGBA arm layer for compositing, no text or diagram.
