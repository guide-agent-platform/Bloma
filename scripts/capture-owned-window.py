"""PID-only PrintWindow capture. Never falls back to another app by title."""
import ctypes,json,sys,subprocess
from ctypes import wintypes as W
from PIL import Image
pid=int(sys.argv[1]);target=sys.argv[2]
tree=json.loads(subprocess.check_output(['pwsh.exe','-NoProfile','-Command','Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'],encoding='utf-8',timeout=15))
owned={pid}
for _ in range(20):
 children={int(x['ProcessId']) for x in tree if int(x['ParentProcessId']) in owned}
 if children.issubset(owned):break
 owned.update(children)
u=ctypes.WinDLL('user32',use_last_error=True);g=ctypes.WinDLL('gdi32',use_last_error=True)
try:ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:pass
u.GetWindowDC.argtypes=[W.HWND];u.GetWindowDC.restype=W.HDC
u.ReleaseDC.argtypes=[W.HWND,W.HDC]
u.GetWindowRect.argtypes=[W.HWND,ctypes.POINTER(W.RECT)]
u.GetWindowThreadProcessId.argtypes=[W.HWND,ctypes.POINTER(W.DWORD)]
u.IsWindowVisible.argtypes=[W.HWND]
u.PrintWindow.argtypes=[W.HWND,W.HDC,W.UINT]
g.CreateCompatibleDC.argtypes=[W.HDC];g.CreateCompatibleDC.restype=W.HDC
g.CreateCompatibleBitmap.argtypes=[W.HDC,ctypes.c_int,ctypes.c_int];g.CreateCompatibleBitmap.restype=W.HBITMAP
g.SelectObject.argtypes=[W.HDC,W.HGDIOBJ];g.SelectObject.restype=W.HGDIOBJ
g.DeleteObject.argtypes=[W.HGDIOBJ];g.DeleteDC.argtypes=[W.HDC]
g.GetDIBits.argtypes=[W.HDC,W.HBITMAP,W.UINT,W.UINT,ctypes.c_void_p,ctypes.c_void_p,W.UINT]
found=[]
@ctypes.WINFUNCTYPE(W.BOOL,W.HWND,W.LPARAM)
def visit(hwnd,_):
 owner=W.DWORD();u.GetWindowThreadProcessId(hwnd,ctypes.byref(owner))
 if owner.value in owned and u.IsWindowVisible(hwnd):
  rect=W.RECT();u.GetWindowRect(hwnd,ctypes.byref(rect));w=rect.right-rect.left;h=rect.bottom-rect.top
  if 40<w<8192 and 40<h<8192:found.append((hwnd,w,h))
 return True
u.EnumWindows(visit,0)
if not found:raise RuntimeError('No visible window belonging to owned PID')
hwnd,w,h=max(found,key=lambda x:x[1]*x[2]);dc=u.GetWindowDC(hwnd);memory=g.CreateCompatibleDC(dc);bmp=g.CreateCompatibleBitmap(dc,w,h);old=g.SelectObject(memory,bmp)
class Header(ctypes.Structure):
 _fields_=[('size',W.DWORD),('width',W.LONG),('height',W.LONG),('planes',W.WORD),('bits',W.WORD),('compression',W.DWORD),('image_size',W.DWORD),('xppm',W.LONG),('yppm',W.LONG),('colors',W.DWORD),('important',W.DWORD)]
try:
 if not (u.PrintWindow(hwnd,memory,2) or u.PrintWindow(hwnd,memory,0)):raise RuntimeError('PrintWindow failed')
 header=Header();header.size=ctypes.sizeof(Header);header.width=w;header.height=-h;header.planes=1;header.bits=32
 buf=ctypes.create_string_buffer(w*h*4)
 if not g.GetDIBits(memory,bmp,0,h,buf,ctypes.byref(header),0):raise RuntimeError('GetDIBits failed')
 Image.frombuffer('RGBA',(w,h),buf,'raw','BGRA',0,1).convert('RGB').save(target,'PNG')
 actual_pid=W.DWORD();u.GetWindowThreadProcessId(hwnd,ctypes.byref(actual_pid))
 print(json.dumps({'root_pid':pid,'window_pid':actual_pid.value,'owned_pids':sorted(owned),'screenshot':target,'size':[w,h]}))
finally:g.SelectObject(memory,old);g.DeleteObject(bmp);g.DeleteDC(memory);u.ReleaseDC(hwnd,dc)
