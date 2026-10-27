/**
 * 语音识别模型资产清单（2026-10-05 语音批，结构搬自 DeepSeek Harness MIT 源码
 * packages/experimental/speech-to-text-sensevoice/runtime/assets.json——固定修订+字节+SHA-256 三重锚定）。
 *
 * 模型三件：SenseVoiceSmall INT8（中/英/粤/日/韩离线转写）+ tokens 词表 + Silero VAD。
 * FP32（938MB）后置不收录——INT8 是听写场景的默认精度（DSH 同款决策，量化有词差但成本减 3/4）。
 *
 * 缓存根：`~/.proma/speech-models/sensevoice-int8/`（Local-First 存储惯例）。
 * **A（平台语音输入）与 C（产物 tkinter 程序的 speech_locator.py）共用此目录**，
 * 一份模型两条生态只下一次；模型永不进项目目录（快照/交付清单/安全扫描零感知）。
 *
 * 下载源双轨：huggingface.co（官方）+ hf-mirror.com（国内镜像，本机实测可达）。
 */

import { isAbsolute, join, resolve } from 'node:path'
import { getPromaHome } from '../../../storage/config-paths'

/** 固定修订的可下载资产（URL 含 commit hash，内容不可变）。 */
export interface SpeechAsset {
  readonly name: string
  readonly url: string
  readonly bytes: number
  readonly sha256: string
}

export interface SpeechModelManifest {
  readonly model: SpeechAsset
  readonly tokens: SpeechAsset
  readonly vad: SpeechAsset
}

/** HF 仓库固定修订（2024-07-17 版 SenseVoice 转换权重）。 */
const HF_REPO = 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17'
const HF_REV = '2365baeacb507f821a0c8120fcee3d484dba7a07'

const MODEL_BYTES = 239_233_841
const MODEL_SHA256 = 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51'
const TOKENS_BYTES = 315_894
const TOKENS_SHA256 = 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc'
const VAD_BYTES = 1_807_522
const VAD_SHA256 = 'a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28'

/** 模型缓存根目录（A/C 两生态共用的唯一真相源路径）。 */
export function speechModelRoot(): string {
  const explicit=process.env.BLOMA_SPEECH_MODEL_DIR?.trim()
  if(explicit&&!isAbsolute(explicit))throw Error('SPEECH_MODEL_DIRECTORY_ABSOLUTE_REQUIRED')
  return explicit?resolve(explicit):join(getPromaHome(), 'speech-models', 'sensevoice-int8')
}

/** 公开下载源（探测顺序无关，并发 HEAD 先回 2xx 者优先；显式指定则不回退）。 */
export const SPEECH_DOWNLOAD_ORIGINS = ['https://huggingface.co', 'https://hf-mirror.com'] as const

function asset(origin: string, repo: string, rev: string, name: string, bytes: number, sha256: string): SpeechAsset {
  return { name, bytes, sha256, url: `${origin}/${repo}/resolve/${rev}/${name}` }
}

/** 全量资产清单（按源展开前的锚定事实；下载时再按源生成 URL）。 */
export const SPEECH_MODEL_MANIFEST: SpeechModelManifest = {
  model: {
    name: 'model.int8.onnx', bytes: MODEL_BYTES, sha256: MODEL_SHA256,
    url: `https://huggingface.co/${HF_REPO}/resolve/${HF_REV}/model.int8.onnx`,
  },
  tokens: {
    name: 'tokens.txt', bytes: TOKENS_BYTES, sha256: TOKENS_SHA256,
    url: `https://huggingface.co/${HF_REPO}/resolve/${HF_REV}/tokens.txt`,
  },
  vad: {
    name: 'silero_vad.onnx', bytes: VAD_BYTES, sha256: VAD_SHA256,
    url: 'https://huggingface.co/csukuangfj/vad/resolve/fba88cd2e921609e7675c3aaf51e0b9b295da4bc/silero_vad.onnx',
  },
}

/** 生成指定源的资产 URL（源探测后调用；manifest.url 恒为 HF 官方形态仅作展示）。 */
export function assetUrlForOrigin(assetName: string, origin: string): string {
  if (assetName === 'model.int8.onnx') return asset(origin, HF_REPO, HF_REV, assetName, MODEL_BYTES, MODEL_SHA256).url
  if (assetName === 'tokens.txt') return asset(origin, HF_REPO, HF_REV, assetName, TOKENS_BYTES, TOKENS_SHA256).url
  return asset(origin, 'csukuangfj/vad', 'fba88cd2e921609e7675c3aaf51e0b9b295da4bc', assetName, VAD_BYTES, VAD_SHA256).url
}

/** 就绪态的三个绝对路径（缓存根 + 文件名）。 */
export function speechModelPaths(): { model: string; tokens: string; vad: string } {
  const root = speechModelRoot()
  return {
    model: join(root, SPEECH_MODEL_MANIFEST.model.name),
    tokens: join(root, SPEECH_MODEL_MANIFEST.tokens.name),
    vad: join(root, SPEECH_MODEL_MANIFEST.vad.name),
  }
}
