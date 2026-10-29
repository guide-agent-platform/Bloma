// Product-owned Windows OCR bridge. No model/API requests or language downloads.
const {execFile}=require('node:child_process'),{promisify}=require('node:util'),fs=require('node:fs/promises'),path=require('node:path')
const {createHash,randomUUID}=require('node:crypto'),exec=promisify(execFile)
async function worker(mode,request,options={}) {
  if(process.platform!=='win32')throw Error('OCR_WINDOWS_REQUIRED')
  const timeout=options.timeoutMs??30000
  if(!Number.isInteger(timeout)||timeout<100||timeout>60000)throw Error('OCR_TIMEOUT_INVALID')
  const executable=path.join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe')
  const args=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'ocr_worker.ps1'),'-Mode',mode]
  if(request)args.push('-RequestPath',request)
  try {
    const result=await exec(executable,args,{windowsHide:true,timeout,maxBuffer:2*1024*1024,encoding:'utf8',signal:options.signal})
    return JSON.parse(result.stdout.trim())
  } catch(error) {
    if(options.signal?.aborted)throw Error('OCR_CANCELLED')
    if(error.killed)throw Error('OCR_TIMEOUT')
    throw Error('OCR_UNAVAILABLE: '+String(error.stderr||error.message).slice(-1200))
  }
}
async function inspectOcr(options={}) {return worker('inspect',null,options)}
async function recognizeImage(file,options={}) {
  if(typeof file!=='string'||typeof options.dataDir!=='string'||typeof options.language!=='string'||!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(options.language))throw Error('OCR_INPUT_AND_LANGUAGE_REQUIRED')
  options.signal?.throwIfAborted()
  const base=await fs.realpath(options.dataDir),actual=await fs.realpath(file),relative=path.relative(base,actual),info=await fs.stat(actual)
  if(path.isAbsolute(relative)||relative==='..'||relative.startsWith('..'+path.sep))throw Error('OCR_OUTSIDE_DATA_DIR')
  if(!info.isFile()||info.size===0||info.size>16*1024*1024||!['.png','.jpg','.jpeg','.bmp'].includes(path.extname(actual).toLowerCase()))throw Error('OCR_IMAGE_INVALID')
  const bytes=await fs.readFile(actual)
  if(bytes.length>16*1024*1024)throw Error('OCR_IMAGE_INVALID')
  const sha256=createHash('sha256').update(bytes).digest('hex'),request=path.join(base,`.ocr-${randomUUID()}.json`)
  try {
    await fs.writeFile(request,JSON.stringify({file:actual,language:options.language,sha256}),{flag:'wx'})
    const result=await worker('recognize',request,options)
    if(result.source_sha256!==sha256||typeof result.text!=='string'||!Array.isArray(result.lines))throw Error('OCR_RESULT_INVALID')
    return {...result,status:result.text.trim()?'recognized':'no_text',scope:'ocr_text_not_verified_transcription'}
  } finally {await fs.unlink(request).catch(()=>{})}
}
module.exports={inspectOcr,recognizeImage}
