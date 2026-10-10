import React from 'react'
import { useAtomValue } from 'jotai'
import { currentProjectAtom, desktopArtifactsAtom } from '../agent-atoms'

/** A real project artifact, explicitly static; never a fabricated running window. */
export const ProgramScreenshot: React.FC = () => {
  const project=useAtomValue(currentProjectAtom)
  const artifacts=useAtomValue(desktopArtifactsAtom)
  const item=artifacts.projectId===project?.project_id ? artifacts.items.find(item=>item.kind==='image' && /LAUNCH\.png$/i.test(item.path)) ?? artifacts.items.find(item=>item.kind==='image') : undefined
  const [image,setImage]=React.useState<{projectId:string;path:string;url:string} | null>(null)
  React.useEffect(()=>{
    let disposed=false
    const api=window.electronAPI?.desktopArtifacts
    if (!project||!item||!api?.image) return
    void api.image({request_id:crypto.randomUUID(),project_id:project.project_id,path:item.path}).then(result=>{
      if (!disposed&&result.ok) setImage({projectId:project.project_id,path:item.path,url:result.data.data_url})
    }).catch(()=>{})
    return ()=>{disposed=true}
  },[project?.project_id,item?.path,item?.mtime,artifacts.version])
  if (!image||image.projectId!==project?.project_id||image.path!==item?.path) return null
  return <figure className="theatre-program-screenshot"><img src={image.url} alt={`${project?.name ?? '程序'}的实际截图`} /><figcaption>程序截图 · 静态预览，启动后在独立窗口使用</figcaption></figure>
}
