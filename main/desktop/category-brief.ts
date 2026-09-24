/**
 * 桌面品类底稿 v0.1（批次 B，2026-09-24）——调度员线的品类数据资产。
 *
 * 三块数据（全部自写；坑库证据分级与竞品 [实证] 协议同思想不同实现）：
 *   1. 双路径矩阵 DESKTOP_ROUTES：P1 Python 快速验证 / P2 Tauri 原生（P2 尚无实证）；
 *   2. 组件清单 DESKTOP_COMPONENTS：桌面程序常用组件（pip 包/用途/证据等级）；
 *   3. 坑库 DESKTOP_PITS：Windows 侧实测结论与陷阱（三级证据）。
 *
 * 证据等级（坑库三级证据协议）：
 *   field-tested [实证]——本机 Windows 11 真实跑通（testedAt+command+finding 留档）；
 *   inferred     [推断]——官方文档/社区结论，未本机验证；
 *   spike-required 待 Spike——无人验证过且影响选型/验收，按阶段表 Spike 判据必派实测。
 *
 * 消费方：desktop-arch 阶段任务书渲染（dispatcher-prompt 经本模块拼装环境清单与
 * 坑库提示）；批次 C 工程契约的组件 id 对齐本清单。改数据不改代码。
 *
 * 2026-09-24 Windows [实证] 六项回填：python/venv、pystray、pynput、sounddevice、
 * pyinstaller、winotify 全部本机跑通（批次 B-1 实测，证据明细见 DESKTOP_PITS）。
 */

// =========================================================================
// 证据分级
// =========================================================================

/** 坑库三级证据：[实证]>[推断]>待 Spike（Spike 判据见 dispatcher-phases desktop-arch 任务书）。 */
export type EvidenceLevel = 'field-tested' | 'inferred' | 'spike-required'

/** 证据等级人读标记（进提示词/报告）。 */
export const EVIDENCE_LABEL: Record<EvidenceLevel, string> = {
  'field-tested': '[实证]',
  inferred: '[推断]',
  'spike-required': '待Spike',
}

// =========================================================================
// 双路径矩阵
// =========================================================================

/** 桌面技术路径。 */
export interface DesktopRoute {
  id: 'p1-python-rapid' | 'p2-tauri-native'
  title: string
  /** 适用判据（何时选它）。 */
  when: string
  /** 技术栈组成。 */
  stack: string[]
  /** 已知风险（进架构阶段权衡）。 */
  risks: string[]
  /** 路径整体证据等级。 */
  evidence: EvidenceLevel
}

export const DESKTOP_ROUTES: readonly DesktopRoute[] = [
  {
    id: 'p1-python-rapid',
    title: 'P1 · Python 快速验证',
    when: '功能优先的效率工具（托盘/热键/剪贴板/录音/通知类）；交付体积与启动速度不敏感；需要快速迭代验证需求。',
    stack: ['Python 3.13（venv 隔离）', 'pystray（托盘）', 'pynput（全局热键/监听）', 'sounddevice（WASAPI 录音）', 'winotify（toast 通知）', 'pyinstaller（单文件打包）'],
    risks: [
      '单文件打包体积 ~8-26MB（含依赖），启动比原生慢',
      'GUI 密集型（多窗口/复杂界面）不适合，选 P2',
      '杀毒软件对 pyinstaller 产物偶发误报（分发场景需签名，本机自用可忽略）',
    ],
    evidence: 'field-tested',
  },
  {
    id: 'p2-tauri-native',
    title: 'P2 · Tauri 原生',
    when: '界面密集型应用（复杂 UI/多窗口）；交付体积/启动速度/内存敏感；需要系统深度集成（托盘+WebView 混合形态）。',
    stack: ['Tauri 2.x（Rust core + 系统 WebView2）', '前端框架按 web 线栈复用'],
    risks: [
      'Windows 侧需 Rust 工具链 + WebView2 运行时（Win11 自带，Win10 需确认）',
      '编译链路长（首次构建分钟级），快速验证期成本高',
      'Bloma 侧零实证：全链路（脚手架/热键/通知/打包）均待 Spike 后才可作为交付路径',
    ],
    evidence: 'spike-required',
  },
]

// =========================================================================
// 组件清单（desktop-arch 环境清单的预置底稿；evidence 会随实测升级）
// =========================================================================

/** 桌面组件条目。 */
export interface DesktopComponent {
  id: string
  name: string
  purpose: string
  pipPackage: string
  evidence: EvidenceLevel
  /** 注意事项/坑（联动 DESKTOP_PITS 明细）。 */
  notes: string
}

export const DESKTOP_COMPONENTS: readonly DesktopComponent[] = [
  {
    id: 'python-runtime',
    name: 'Python 解释器',
    purpose: '运行时本体；venv 做项目隔离',
    pipPackage: '',
    evidence: 'field-tested',
    notes: '本机 3.13.7；注意 WindowsApps/python.exe 是 Store 空壳（退出码 49 无输出），真解释器在 Programs\\Python\\Python313——检测一律用 `python --version` 实测而非路径存在性',
  },
  {
    id: 'tray-icon',
    name: '系统托盘',
    purpose: '常驻托盘图标 + 右键菜单',
    pipPackage: 'pystray (+ Pillow)',
    evidence: 'field-tested',
    notes: 'icon.run() 阻塞主线程（事件循环）；stop() 需从其他线程调；图标用 PIL.Image.new 生成即可',
  },
  {
    id: 'global-hotkey',
    name: '全局热键/键鼠监听',
    purpose: '全局快捷键、剪贴板工具的键盘监听',
    pipPackage: 'pynput',
    evidence: 'field-tested',
    notes: 'Listener(on_press=...) 即公共 API；平台后端类（Win32KeyListener 等）不可直接 import（ImportError）；特殊键走 key.name、字符键走 key.char（AttributeError 分流）',
  },
  {
    id: 'audio-capture',
    name: '录音采集',
    purpose: '麦克风录音（WASAPI 共享模式）',
    pipPackage: 'sounddevice (+ numpy)',
    evidence: 'field-tested',
    notes: 'sd.rec()+sd.wait() 阻塞式最简；hostapis 枚举 MME/DirectSound/WASAPI/WDM-KS；峰值统计需 numpy',
  },
  {
    id: 'toast-notify',
    name: 'Windows 通知',
    purpose: 'toast 弹窗通知',
    pipPackage: 'winotify',
    evidence: 'field-tested',
    notes: 'Notification(app_id, title, msg, duration)+show()；app_id 为显示名，无需注册真实 AUMID',
  },
  {
    id: 'packaging',
    name: '单文件打包',
    purpose: 'pyinstaller --onefile 产出独立 exe',
    pipPackage: 'pyinstaller',
    evidence: 'field-tested',
    notes: '纯 print 程序 ~20s/8.2MB；pystray+PIL --windowed ~17s/26MB；pyinstaller 6.x 自动收集 pystray/PIL 依赖，零 hidden-imports 手工指定；--specpath 隔离中间产物',
  },
  {
    id: 'gui-toolkit',
    name: '窗口 GUI（P1 内）',
    purpose: '简单设置窗/对话框（配合托盘）',
    pipPackage: 'pystray 内置无窗口；可选 tkinter（标准库自带）',
    evidence: 'inferred',
    notes: 'tkinter 随 CPython 发行版自带 [推断]；与 pystray 事件循环共存模式（线程模型）未实测——用到时先 Spike',
  },
  {
    id: 'clipboard-access',
    name: '剪贴板读写',
    purpose: '剪贴板历史/内容工具',
    pipPackage: 'pyperclip（或 pynput.monitor）',
    evidence: 'spike-required',
    notes: '纯文本读写 [推断] 可用；变更监听（轮询 vs 事件）在 Win11 的行为待实测——剪贴板类工具立项前必 Spike',
  },
]

/** 按证据等级过滤组件（环境清单渲染用）。 */
export function componentsByEvidence(level: EvidenceLevel): DesktopComponent[] {
  return DESKTOP_COMPONENTS.filter((c) => c.evidence === level)
}

// =========================================================================
// 坑库（Windows 侧实测明细；回填纪律：每条 field-tested 必带 testedAt/command/finding）
// =========================================================================

/** 坑库条目。 */
export interface DesktopPit {
  id: string
  topic: string
  evidence: EvidenceLevel
  /** [实证] 必填：实测日期（YYYY-MM-DD）。 */
  testedAt?: string
  /** [实证] 必填：可复现命令（或多行伪命令）。 */
  command?: string
  /** 结论/现象（事实性描述）。 */
  finding: string
  /** 对交付的影响与建议动作。 */
  action: string
}

export const DESKTOP_PITS: readonly DesktopPit[] = [
  {
    id: 'win-python-store-shell',
    topic: 'python3 是 MS Store 空壳',
    evidence: 'field-tested',
    testedAt: '2026-09-24',
    command: 'python3 --version  # 退出码 49 无输出\npython --version   # Python 3.13.7',
    finding: '本机 python3 命中 WindowsApps 空壳（静默失败）；真解释器是 python（Programs\\Python\\Python313）。',
    action: '一切探测/驱动用 python，禁用 python3；环境检测以 `python --version` 实际输出为准，不做路径存在性判断。',
  },
  {
    id: 'win-venv-create',
    topic: 'venv 创建开销',
    evidence: 'field-tested',
    testedAt: '2026-09-24',
    command: 'python -m venv <dir>',
    finding: '创建 ~3.8s、磁盘 ~13MB；Scripts/ 下 Activate.ps1/activate/activate.bat 齐全（PowerShell/cmd/bash 三态可用）；venv 内 python -m pip 直连可用。',
    action: '工程契约的驱动命令默认走 venv 内 Scripts/python.exe（绝对路径或激活后调用）；首次环境装配计入阶段预算（秒级，可接受）。',
  },
  {
    id: 'win-pystray-lifecycle',
    topic: 'pystray 托盘生命周期',
    evidence: 'field-tested',
    testedAt: '2026-09-24',
    command: "Icon('name', Image.new('RGB',(16,16)), title, menu=Menu(...)) → icon.run() → icon.stop()（他线程）",
    finding: 'Win11 托盘真实驻留；run() 阻塞主线程，stop() 须从其他线程调用，3s 自停干净退出零异常；菜单回调正常。',
    action: '骨架把 icon.run() 放主线程、业务线程 daemon 化；驱动验证用「启动 N 秒后 stop 退出码 0」探活模式。',
  },
  {
    id: 'win-pynput-backend-classes',
    topic: 'pynput 平台后端类不可直接 import',
    evidence: 'field-tested',
    testedAt: '2026-09-24',
    command: 'from pynput.keyboard import Win32KeyListener  # ImportError',
    finding: 'Listener/Controller 是唯一公共 API；Win32KeyListener 等后端类不在导出面。字符键 key.char、特殊键 key.name（AttributeError 分流）。',
    action: '代码与生成指引只用 Listener；热键判定的键名规范在驱动断言里以 <name> 形式对齐。',
  },
  {
    id: 'win-sounddevice-wasapi',
    topic: 'sounddevice WASAPI 录音',
    evidence: 'field-tested',
    testedAt: '2026-09-24',
    command: "sd.rec(int(dur*16000), samplerate=16000, channels=1, dtype='int16'); sd.wait()",
    finding: '0.5.6 枚举四 hostapi（MME/DirectSound/WASAPI/WDM-KS）；默认输入 Realtek 麦克风阵列；1s@16kHz 采集 peak=65（真实环境音）。',
    action: '录音类功能直接 sd.rec+sd.wait 起步；设备枚举结果进环境清单（无声卡机器降级为可预期失败分类）。',
  },
  {
    id: 'win-pyinstaller-onefile',
    topic: 'pyinstaller 单文件打包',
    evidence: 'field-tested',
    testedAt: '2026-09-24',
    command: 'python -m PyInstaller --onefile --windowed --distpath dist --workpath build --specpath build app.py',
    finding: '纯 print ~20s/8.2MB；pystray+PIL 托盘程序 ~17s/26MB，argv 传参正常，exe 直跑托盘自停正常；pyinstaller 6.x 自动收集 pystray/PIL 依赖零手工 hidden-imports。',
    action: '打包阶段固定 --onefile --windowed + --specpath 隔离中间产物；打包耗时（~20s）计入阶段预算；产物冒烟=运行 exe 带 --self-check 参数断言退出码。',
  },
  {
    id: 'win-winotify-toast',
    topic: 'winotify toast 通知',
    evidence: 'field-tested',
    testedAt: '2026-09-24',
    command: "Notification(app_id, title, msg, duration='short').show()",
    finding: 'toast 真实弹出、进程正常退出；set_audio(audio.Default) 正常；app_id 为显示名无需注册 AUMID。',
    action: '通知组件直接用；验证走人工确认（toast 无法程序化断言弹出，属驱动断言的 manual 分类）。',
  },
  {
    id: 'win-gbk-console-noise',
    topic: '控制台中文乱码是显示噪音',
    evidence: 'field-tested',
    testedAt: '2026-09-24',
    command: 'python -c "print(\'中文\')"  # GBK 控制台输出乱码',
    finding: '程序 stdout 中文在 GBK 代码页控制台显示乱码，但字节流本身正确（写文件/管道消费无影响）。',
    action: '驱动断言不依赖控制台中文显示；子进程输出比较用 UTF-8 重定向或 ASCII 标记（TRAY-OK 等英文锚点）。',
  },
  {
    id: 'win-clipboard-change-listen',
    topic: '剪贴板变更监听机制',
    evidence: 'spike-required',
    finding: '轮询（pyperclip+interval）与事件（Win32 AddClipboardFormatListener）两条路线在 Win11 的 CPU 占用/延迟/可靠性未实测。',
    action: '剪贴板类工具立项前必派 Spike 子会话实测（影响选型与验收驱动设计）。',
  },
  {
    id: 'win-tauri-toolchain',
    topic: 'Tauri 2.x Windows 工具链',
    evidence: 'spike-required',
    finding: 'Rust 工具链安装、WebView2 依赖、脚手架到打包全链路零实证。',
    action: 'P2 路径启用前必派 Spike（建议时间盒拆两条：工具链安装 30min + 最小窗体打包 30min）。',
  },
]

/** 坑库检索：按主题关键词。 */
export function findPits(keyword: string): DesktopPit[] {
  const kw = keyword.toLowerCase()
  return DESKTOP_PITS.filter(
    (p) => p.topic.toLowerCase().includes(kw) || p.finding.toLowerCase().includes(kw) || p.id.includes(kw),
  )
}

/** 证据统计（品类底稿健康度：field-tested 占比进 arch 阶段报告）。 */
export function evidenceSummary(): Record<EvidenceLevel, number> {
  const summary: Record<EvidenceLevel, number> = { 'field-tested': 0, inferred: 0, 'spike-required': 0 }
  for (const pit of DESKTOP_PITS) summary[pit.evidence] += 1
  return summary
}
