import React from 'react'
import {
  Sparkles as SparklesIcon, ArrowUp as ArrowUpIcon, RotateCw as RotateIcon,
  Maximize2 as MaximizeIcon, Minimize2 as MinimizeIcon, Camera as CameraIcon,
  PanelsTopLeft, TriangleAlert, MessageSquare as MessageIcon, ChevronUp as ChevronUpIcon,
  ChevronDown as ChevronDownIcon, ArrowRight as ArrowRightIcon, ArrowLeft as ArrowLeftIcon,
  Zap as ZapIcon, Gem as GemIcon, Send as SendIcon, SlidersHorizontal, Square, Mic,
  Paperclip as PaperclipIcon, History as HistoryIcon, FileText as FileIcon,
  Layers as LayersIcon, UsersRound, Play as PlayIcon, Image as ImageIcon, X as XIcon,
  Copy as CopyIcon, MessagesSquare, Sprout as SproutIcon, Check as CheckIcon,
  GitBranch as BranchIcon, Activity as ActivityIcon, Hammer as HammerIcon, Scan as ScanIcon,
  type LucideIcon, type LucideProps,
} from 'lucide-react'

/** Shared outline geometry and 1.7px strokes for the approved studio. */
function uiIcon(Icon: LucideIcon, defaultSize = 24): React.FC<LucideProps> {
  return function UIIcon({ size = defaultSize, strokeWidth = 1.7, ...props }) {
    return <Icon size={size} strokeWidth={strokeWidth} aria-hidden="true" focusable="false" {...props} />
  }
}
export const Sparkles = uiIcon(SparklesIcon)
export const ArrowUp = uiIcon(ArrowUpIcon)
export const RotateCw = uiIcon(RotateIcon)
export const Maximize2 = uiIcon(MaximizeIcon)
export const Minimize2 = uiIcon(MinimizeIcon)
export const Camera = uiIcon(CameraIcon)
export const LayoutTemplate = uiIcon(PanelsTopLeft)
export const AlertTriangle = uiIcon(TriangleAlert)
export const MessageSquare = uiIcon(MessageIcon)
export const ChevronUp = uiIcon(ChevronUpIcon)
export const ChevronDown = uiIcon(ChevronDownIcon, 14)
export const ArrowRight = uiIcon(ArrowRightIcon)
export const ArrowLeft = uiIcon(ArrowLeftIcon)
export const Zap = uiIcon(ZapIcon)
export const Gem = uiIcon(GemIcon)
export const Send = uiIcon(SendIcon)
export const IconSettings = uiIcon(SlidersHorizontal)
export const IconStop = uiIcon(Square)
export const IconAlertTriangle = uiIcon(TriangleAlert)
export const IconMic = uiIcon(Mic)
export const Paperclip = uiIcon(PaperclipIcon, 16)
export const History = uiIcon(HistoryIcon, 16)
export const FileText = uiIcon(FileIcon, 16)
export const Layers = uiIcon(LayersIcon, 16)
export const Users = uiIcon(UsersRound, 16)
export const Play = uiIcon(PlayIcon, 14)
export const Image = uiIcon(ImageIcon, 16)
export const X = uiIcon(XIcon, 16)
export const Copy = uiIcon(CopyIcon, 14)
export const Conversation = uiIcon(MessagesSquare, 16)
export const Sprout = uiIcon(SproutIcon, 20)
export const Check = uiIcon(CheckIcon, 16)
export const GitBranch = uiIcon(BranchIcon, 16)
export const Activity = uiIcon(ActivityIcon, 16)
export const Hammer = uiIcon(HammerIcon, 16)
export const Scan = uiIcon(ScanIcon, 16)
