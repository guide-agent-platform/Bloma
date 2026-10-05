/**
 * Windows 桌面组件卡片库（2026-10-05 迁移批，结构搬自 Proma-Easy desktop-app.md §2）。
 *
 * 迁移口径（AGPL 同源授权搬运）：卡片四件套结构（探测/安装/坑/降级）+ 证据等级
 * （[实证]=本机跑通 / [文证]=官方文档支持 / [推断]=待验证）照搬；**内容不搬**——
 * 竞品坑库实证全在 Linux/X11（xclip/xdotool/libnotify），Windows 侧须自证
 * （关键不对称，记忆钉死）。首批收录跨平台组件（官方支持 Windows [文证]），
 * 本机真机探针通过的组件滚动升级 [实证]。
 *
 * 消费面：install_packages 工具的 import 探测映射（import_name）+ implement
 * 任务书的组件速查行（componentQuickReference）。
 */

export interface ComponentCard {
  /** pip 包名（requirements.txt 声明用） */
  package: string
  /** import 模块名（探测用——与包名不同者如 Pillow→PIL） */
  importName: string
  /** 用途一句话 */
  purpose: string
  /** 探测命令（venv python 下执行） */
  probe: string
  /** 已知坑（Windows 侧） */
  pitfall: string
  /** 降级替代 */
  fallback: string
  /** 证据等级：本批全 [文证]（官方 Windows 支持），真机探针过一条升一条 [实证] */
  evidence: '实证' | '文证' | '推断'
}

export const WINDOWS_COMPONENT_CARDS: readonly ComponentCard[] = [
  {
    package: 'pynput',
    importName: 'pynput',
    purpose: '全局热键监听与键鼠注入',
    probe: 'python -c "from pynput.keyboard import Listener; print(\'ok\')"',
    pitfall: '监听回调在独立线程，操作 GUI 状态需回主线程调度 [推断]；管理员权限程序内注入受限 [文证]',
    fallback: 'keyboard 库（同类线程模型）',
    evidence: '文证',
  },
  {
    package: 'pystray',
    importName: 'pystray',
    purpose: '系统托盘图标与菜单（配 Pillow 画图标）',
    probe: 'python -c "import pystray; print(\'ok\')"',
    pitfall: '托盘菜单回调在独立线程，直接操作 GUI 需线程间通信 [文证]；icon.run() 阻塞主线程，业务线程 daemon 化',
    fallback: '无托盘：主窗口最小化 + 热键唤起',
    evidence: '文证',
  },
  {
    package: 'Pillow',
    importName: 'PIL',
    purpose: '图像处理/图标生成（pystray 配套）',
    probe: 'python -c "import PIL; print(PIL.__version__)"',
    pitfall: 'import 名是 PIL 不是 Pillow（探测/断言勿写错）',
    fallback: '无（图像刚需）',
    evidence: '实证',
  },
  {
    package: 'sounddevice',
    importName: 'sounddevice',
    purpose: '录音/播放（numpy 数组直出，便于接 ASR）',
    probe: 'python -c "import sounddevice as sd; print(len(sd.query_devices()))"',
    pitfall: 'portaudio 随 pip wheel 自带（Windows 免装系统库，与 Linux 不同）；无麦克风设备时 query_devices 可能为空 [文证]',
    fallback: 'winsound 标准库（纯播放提示音）',
    evidence: '文证',
  },
  {
    package: 'pyperclip',
    importName: 'pyperclip',
    purpose: '剪贴板读写',
    probe: 'python -c "import pyperclip; print(\'ok\')"',
    pitfall: 'Windows 侧无 Linux xclip 的 fork-daemon 挂死问题 [文证]',
    fallback: 'tkinter clipboard（需窗口与消息循环）',
    evidence: '文证',
  },
  {
    package: 'winotify',
    importName: 'winotify',
    purpose: 'Windows 原生 Toast 通知',
    probe: 'python -c "import winotify; print(\'ok\')"',
    pitfall: '通知需应用有 AUMID 上下文，脚本进程下用默认注册即可 [文证]',
    fallback: 'plyer（跨平台但依赖更重）',
    evidence: '文证',
  },
  {
    package: 'sherpa-onnx',
    importName: 'sherpa_onnx',
    purpose: '本地离线语音识别（SenseVoice，中/英/粤/日/韩；录音用 sounddevice）',
    probe: 'python -c "import sherpa_onnx; print(sherpa_onnx.__version__)"',
    pitfall: '非流式：整段录音后一次性转写（VAD 自动分段）；模型 239MB 首次自动下载到 ~/.proma/speech-models/（装包时项目根自动生成 speech_locator.py，import 它调 ensure_models() 拿模型路径，勿手写下载逻辑）；模型准备期 UI 需提示，勿卡死主线程',
    fallback: '无本地降级（文本输入兑底）',
    evidence: '文证',
  },
]

/** 任务书组件速查表（每组件一行，拼进 implement 约束段）。 */
export function componentQuickReference(): string {
  const lines = WINDOWS_COMPONENT_CARDS.map(
    (card) => `- ${card.package}（import ${card.importName}）：${card.purpose}｜坑：${card.pitfall}｜降级：${card.fallback}｜[${card.evidence}]`,
  )
  return ['可用组件速查（pip 声明安装，详卡见 install_packages 工具）：', ...lines].join('\n')
}
