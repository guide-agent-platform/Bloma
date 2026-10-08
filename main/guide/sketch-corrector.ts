/**
 * 草图点选层注入器（批11 ①，2026-10-08）：UX 草图 HTML 落盘时内联注入——右栏
 * bloma-file:// 渲染的草图即获得点选标记能力（元素级语义，无需纠错实例）。
 *
 * 纪律：LLM 草图提示词禁止 <script> 是对模型产出的约束；本段是平台注入的确定性
 * 脚本（同骨架 v2 correction.js 语言）——createElement/textContent 构造、零外部
 * 资源、零网络，安全扫描红线内。标记经 postMessage(label=bloma-sketch-pick) 回传
 * 父页（PreviewPanel 收集→组装意见→AGENT_SEND_MESSAGE metadata source=
 * sketch_correction→ux-confirm takeUxSketchCorrection 一步消化）。
 */

/** 草图场景问题四分类（对齐 PRD §13.5「点选标记不满意」+ 草图期「方向验证」语义）。 */
const SKETCH_CORRECTOR_HTML = `
<style id="bloma-sketch-corrector-style">
  #bloma-sk-bar{position:fixed;top:0;left:0;right:0;z-index:9990;display:flex;align-items:center;gap:10px;
    padding:8px 14px;background:linear-gradient(90deg,#4f46e5,#818cf8);color:#fff;font:600 12px/1.4 "Segoe UI","Microsoft YaHei",sans-serif;
    box-shadow:0 2px 10px rgba(79,70,229,.35)}
  #bloma-sk-bar .sk-ico{width:20px;height:20px;border-radius:99px;background:rgba(255,255,255,.22);
    display:flex;align-items:center;justify-content:center;font-size:11px}
  #bloma-sk-bar .sk-count{margin-left:auto;padding:2px 10px;border-radius:99px;background:rgba(255,255,255,.2);font-size:11px}
  .sk-hover{outline:2px solid #4f46e5!important;outline-offset:2px;background:rgba(79,70,229,.08)!important;border-radius:6px;cursor:crosshair!important}
  #bloma-sk-panel{position:fixed;z-index:9991;width:260px;background:#fff;border-radius:12px;
    box-shadow:0 12px 40px rgba(0,0,0,.18),0 0 0 1px #e4e4e7;padding:12px;display:none;flex-direction:column;gap:8px;
    font:12px/1.5 "Segoe UI","Microsoft YaHei",sans-serif;color:#18181b}
  #bloma-sk-panel .sk-head{display:flex;align-items:center;font-weight:700}
  #bloma-sk-panel .sk-close{margin-left:auto;cursor:pointer;color:#a1a1aa;font-size:15px}
  .sk-kinds{display:flex;flex-wrap:wrap;gap:6px}
  .sk-kind{padding:5px 10px;border:1px solid #e4e4e7;border-radius:8px;background:#fafafa;cursor:pointer;font-size:11px;font-weight:600;color:#71717a}
  .sk-kind.on{background:#eef2ff;border-color:#4f46e5;color:#4f46e5}
  .sk-note{width:100%;box-sizing:border-box;padding:7px 10px;border:1px solid #e4e4e7;border-radius:8px;font-size:12px}
  .sk-ok{padding:7px 0;border:none;border-radius:8px;background:linear-gradient(90deg,#4f46e5,#6366f1);color:#fff;font-weight:700;cursor:pointer;font-size:12px}
</style>
<script id="bloma-sketch-corrector">
(function(){
  "use strict";
  var bar=document.createElement("div");bar.id="bloma-sk-bar";
  var ico=document.createElement("span");ico.className="sk-ico";ico.textContent="✎";
  var txt=document.createElement("span");txt.textContent="草图确认 · 直接点选不满意的地方";
  var count=document.createElement("span");count.className="sk-count";count.style.display="none";
  bar.appendChild(ico);bar.appendChild(txt);bar.appendChild(count);
  document.body.appendChild(bar);
  var panel=document.createElement("div");panel.id="bloma-sk-panel";
  document.body.appendChild(panel);
  var seq=0,hoverEl=null,kindValue=null,noteInput=null,target=null;
  function esc(s){return String(s==null?"":s).slice(0,40)}
  function labelOf(el){
    var t=(el.value||el.placeholder||el.textContent||"").trim().replace(/\\s+/g," ");
    if(el.tagName==="BUTTON"||el.getAttribute&&(el.getAttribute("role")==="button"))return"按钮「"+esc(t)+"」";
    if(el.tagName==="INPUT"||el.tagName==="TEXTAREA")return"输入框「"+esc(t)+"」";
    if(el.tagName==="IMG")return"图片「"+(el.getAttribute("alt")||"")+"」";
    if(el.children&&el.children.length>2)return"区域（"+esc(t)+"）";
    return"元素「"+esc(t)+"」"
  }
  function refreshCount(){if(seq>0){count.style.display="inline-block";count.textContent="已标记 "+seq+" 处"}else{count.style.display="none"}}
  function closePanel(){panel.style.display="none";kindValue=null}
  document.addEventListener("pointerover",function(e){
    if(e.target.closest("#bloma-sk-bar,#bloma-sk-panel")){if(hoverEl){hoverEl.classList.remove("sk-hover");hoverEl=null}return}
    var el=e.target;
    if(hoverEl!==el){if(hoverEl)hoverEl.classList.remove("sk-hover");hoverEl=el;el.classList.add("sk-hover")}
  },true);
  document.addEventListener("click",function(e){
    if(e.target.closest("#bloma-sk-bar,#bloma-sk-panel"))return;
    e.preventDefault();e.stopPropagation();
    target=e.target;
    while(panel.firstChild)panel.removeChild(panel.firstChild);
    var head=document.createElement("div");head.className="sk-head";
    head.textContent="标记："+labelOf(target);
    var close=document.createElement("span");close.className="sk-close";close.textContent="×";
    close.addEventListener("click",closePanel);
    head.appendChild(close);
    var kinds=document.createElement("div");kinds.className="sk-kinds";
    var defs=[["direction","方向不对"],["text","文案问题"],["layout","布局问题"],["missing","缺了东西"]];
    var btns=defs.map(function(d){
      var b=document.createElement("span");b.className="sk-kind";b.textContent=d[1];
      b.addEventListener("click",function(){kindValue=d[0];btns.forEach(function(x){x.classList.remove("on")});b.classList.add("on")});
      kinds.appendChild(b);return b
    });
    noteInput=document.createElement("input");noteInput.className="sk-note";noteInput.placeholder="可补一句（不填也行）";
    var ok=document.createElement("button");ok.className="sk-ok";ok.textContent="记下这一处";
    ok.addEventListener("click",function(){
      if(!kindValue)kindValue="direction";
      var map={direction:"方向不对",text:"文案问题",layout:"布局问题",missing:"缺了东西"};
      seq+=1;refreshCount();
      var rect=target.getBoundingClientRect();
      try{
        window.parent.postMessage({label:"bloma-sketch-pick",pick:{
          seq:seq,kind:kindValue,kindLabel:map[kindValue],target:labelOf(target),
          text:(target.textContent||"").trim().slice(0,40),note:noteInput.value.trim(),
          rect:{x:Math.round(rect.x),y:Math.round(rect.y),w:Math.round(rect.width),h:Math.round(rect.height)}
        }},"*")
      }catch(err){}
      target.classList.add("sk-hover");
      closePanel()
    });
    panel.appendChild(head);panel.appendChild(kinds);panel.appendChild(noteInput);panel.appendChild(ok);
    var r=target.getBoundingClientRect();
    panel.style.left=Math.min(Math.max(r.left,10),window.innerWidth-274)+"px";
    var top=r.bottom+8;if(top+230>window.innerHeight)top=Math.max(r.top-240,42);
    panel.style.top=top+"px";panel.style.display="flex";
    setTimeout(function(){noteInput.focus()},50)
  },true);
  document.addEventListener("keydown",function(e){if(e.key==="Escape")closePanel()},true);
})();
</script>
`

/**
 * 注入草图点选层（纯函数）：优先插在 </body> 前；无闭合标签则追加文档尾。
 * 幂等：已含注入标记则原样返回（防重复注入）。
 */
export function injectSketchCorrector(html: string): string {
  if (html.includes('bloma-sketch-corrector')) return html
  if (html.includes('</body>')) return html.replace('</body>', `${SKETCH_CORRECTOR_HTML}\n</body>`)
  return `${html}\n${SKETCH_CORRECTOR_HTML}\n`
}
