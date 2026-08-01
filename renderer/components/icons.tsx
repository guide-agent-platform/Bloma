import React from 'react'

/**
 * Bloma 图标集 — Lucide 风格（stroke=2, currentColor, 24x24 viewBox）
 *
 * 设计系统 DS-MASTER §4：demo.html 内联 SVG 路径必须与此处完全一致。
 * 禁止使用 emoji 作为结构图标（ui-ux-pro-max §4 no-emoji-icons）。
 */

interface IconProps {
  size?: number
  className?: string
  strokeWidth?: number
<<<<<<< HEAD
  style?: React.CSSProperties
  'aria-hidden'?: boolean
}

const base = (size: number, strokeWidth: number, style?: React.CSSProperties): React.SVGProps<SVGSVGElement> => ({
=======
  'aria-hidden'?: boolean
}

const base = (size: number, strokeWidth: number): React.SVGProps<SVGSVGElement> => ({
>>>>>>> 5a004360480c0c81d2999731a003e93e53bcaa84
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: false,
<<<<<<< HEAD
  style,
=======
>>>>>>> 5a004360480c0c81d2999731a003e93e53bcaa84
})

export const Sparkles: React.FC<IconProps> = ({ size = 24, strokeWidth = 2 }) => (
  <svg {...base(size, strokeWidth)}>
    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
    <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z" />
    <path d="M5 14l.6 1.6L7 16l-1.4.4L5 18l-.6-1.6L3 16l1.4-.4L5 14z" />
  </svg>
)

export const ArrowUp: React.FC<IconProps> = ({ size = 24, strokeWidth = 2 }) => (
  <svg {...base(size, strokeWidth)}>
    <path d="M12 19V5" />
    <path d="M5 12l7-7 7 7" />
  </svg>
)

<<<<<<< HEAD
=======
export const ArrowRight: React.FC<IconProps> = ({ size = 24, strokeWidth = 2 }) => (
  <svg {...base(size, strokeWidth)}>
    <path d="M5 12h14" />
    <path d="M12 5l7 7-7 7" />
  </svg>
)

>>>>>>> 5a004360480c0c81d2999731a003e93e53bcaa84
export const RotateCw: React.FC<IconProps> = ({ size = 24, strokeWidth = 2 }) => (
  <svg {...base(size, strokeWidth)}>
    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    <path d="M21 3v6h-6" />
  </svg>
)

export const Maximize2: React.FC<IconProps> = ({ size = 24, strokeWidth = 2 }) => (
  <svg {...base(size, strokeWidth)}>
    <path d="M15 3h6v6" />
    <path d="M9 21H3v-6" />
    <path d="M21 3l-7 7" />
    <path d="M3 21l7-7" />
  </svg>
)

export const Minimize2: React.FC<IconProps> = ({ size = 24, strokeWidth = 2 }) => (
  <svg {...base(size, strokeWidth)}>
    <path d="M8 3v3a2 2 0 0 1-2 2H3" />
    <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
    <path d="M3 16h3a2 2 0 0 1 2 2v3" />
    <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
  </svg>
)

export const Camera: React.FC<IconProps> = ({ size = 24, strokeWidth = 2 }) => (
  <svg {...base(size, strokeWidth)}>
    <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
    <circle cx="12" cy="13" r="3" />
  </svg>
)

export const LayoutTemplate: React.FC<IconProps> = ({ size = 24, strokeWidth = 2 }) => (
  <svg {...base(size, strokeWidth)}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 9h18" />
    <path d="M9 21V9" />
  </svg>
)

export const AlertTriangle: React.FC<IconProps> = ({ size = 24, strokeWidth = 2 }) => (
  <svg {...base(size, strokeWidth)}>
    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </svg>
)

export const MessageSquare: React.FC<IconProps> = ({ size = 24, strokeWidth = 2 }) => (
  <svg {...base(size, strokeWidth)}>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
)

export const ChevronUp: React.FC<IconProps> = ({ size = 24, strokeWidth = 2 }) => (
  <svg {...base(size, strokeWidth)}>
    <path d="M18 15l-6-6-6 6" />
  </svg>
)

<<<<<<< HEAD
export const ArrowRight: React.FC<IconProps> = ({ size = 24, strokeWidth = 2, ...rest }) => (
  <svg {...base(size, strokeWidth)} {...rest}>
    <path d="M5 12h14" />
    <path d="M12 5l7 7-7 7" />
  </svg>
)

export const ArrowLeft: React.FC<IconProps> = ({ size = 24, strokeWidth = 2 }) => (
  <svg {...base(size, strokeWidth)}>
    <path d="M19 12H5" />
    <path d="M12 19l-7-7 7-7" />
  </svg>
)

=======
>>>>>>> 5a004360480c0c81d2999731a003e93e53bcaa84
export const Zap: React.FC<IconProps> = ({ size = 24, strokeWidth = 2 }) => (
  <svg {...base(size, strokeWidth)}>
    <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
  </svg>
)

export const Gem: React.FC<IconProps> = ({ size = 24, strokeWidth = 2 }) => (
  <svg {...base(size, strokeWidth)}>
    <path d="M6 3h12l4 6-10 13L2 9z" />
    <path d="M11 3 8 9l4 13 4-13-3-6" />
    <path d="M2 9h20" />
  </svg>
)

export const Send: React.FC<IconProps> = ({ size = 24, strokeWidth = 2 }) => (
  <svg {...base(size, strokeWidth)}>
    <path d="M22 2 11 13" />
    <path d="M22 2 15 22l-4-9-9-4 20-7z" />
  </svg>
)
