// 官方模块：AABB 碰撞（轴对齐矩形，无依赖）
// 适用：矩形碰撞判定（子弹命中、角色撞墙、拾取判定）。
// 纪律：检测与响应分离——检测只判「是否相交」，响应（反弹/扣血/得分）由业务回调决定。
// 使用：复制本文件到业务 src/，import { rectIntersect, collectPairs, resolveOverlap } 后调用。

/**
 * 轴对齐矩形。约定：{ x, y, w, h }，x/y 为左上角（或统一为「中心」亦可，只要全套一致）。
 * 本模块默认左上角语义；若用中心点请在调用前统一换算。
 */

/** 两个矩形是否相交（含边贴边不算相交）。 */
export function rectIntersect(a, b) {
  return (
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y
  )
}

/**
 * 从两个分组里枚举所有相交对（用于「子弹 × 敌人」「玩家 × 拾取」等一对多判定）。
 * @param {Array} groupA 第一组矩形
 * @param {Array} groupB 第二组矩形
 * @returns {Array<{a, b, indexA, indexB}>} 相交对
 */
export function collectPairs(groupA, groupB) {
  const pairs = []
  for (let i = 0; i < groupA.length; i += 1) {
    for (let j = 0; j < groupB.length; j += 1) {
      if (rectIntersect(groupA[i], groupB[j])) {
        pairs.push({ a: groupA[i], b: groupB[j], indexA: i, indexB: j })
      }
    }
  }
  return pairs
}

/**
 * 把 a 沿最小穿透轴推出 b（响应：让 a 不再与 b 重叠）。
 * @param {object} a 被推动的矩形（原地修改）
 * @param {object} b 参照矩形（静态墙/平台）
 * @returns {string|null} 推出方向：'left' | 'right' | 'up' | 'down'（未重叠返回 null）
 */
export function resolveOverlap(a, b) {
  if (!rectIntersect(a, b)) return null
  // 四向穿透深度（正值表示 a 需往该方向移动该距离才分开）
  const left = a.x + a.w - b.x // a 的右边越过 b 左边
  const right = b.x + b.w - a.x // a 的左边在 b 右边内侧
  const up = a.y + a.h - b.y
  const down = b.y + b.h - a.y

  const min = Math.min(left, right, up, down)
  if (min === left) {
    a.x = b.x - a.w
    return 'left'
  }
  if (min === right) {
    a.x = b.x + b.w
    return 'right'
  }
  if (min === up) {
    a.y = b.y - a.h
    return 'up'
  }
  a.y = b.y + b.h
  return 'down'
}
