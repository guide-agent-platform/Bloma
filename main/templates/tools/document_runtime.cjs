/* Product-owned text extraction and literal retrieval. No platform IPC, keys,
 * network, HTML conversion, or model calls. Call from a backend/worker. */
const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash } = require('node:crypto')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const MAX_BYTES = 16 * 1024 * 1024, MAX_TEXT = 2 * 1024 * 1024, MAX_PAGES = 500
const clean = text => text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim()

async function dependencies() {
  const pdf = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const mammoth = require('mammoth')
  if (typeof pdf.getDocument !== 'function' || typeof mammoth.extractRawText !== 'function') throw Error('DOCUMENT_PARSER_API_UNAVAILABLE')
  return { pdf, mammoth }
}
async function inspectDependencies() {
  const installed = await fs.realpath(path.join(__dirname, 'node_modules'))
  for (const name of ['pdfjs-dist', 'mammoth']) {
    const relative = path.relative(installed, await fs.realpath(require.resolve(name + '/package.json')))
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw Error('DOCUMENT_PROJECT_DEPENDENCIES_REQUIRED')
  }
  await dependencies()
  return Object.fromEntries(['pdfjs-dist', 'mammoth'].map(name => [name, { version: require(name + '/package.json').version }]))
}
function buildDocument(bytes, name, pages) {
  const documentId = hash(bytes), blocks = []
  let total = 0
  for (const { page, text } of pages) {
    const normalized = clean(text)
    total += normalized.length
    if (total > MAX_TEXT) throw Error('DOCUMENT_TEXT_LIMIT')
    // Bounded chunks retain offsets within extracted text, not invented DOCX pages.
    for (let start = 0; start < normalized.length; start += 1600) {
      const text = normalized.slice(start, start + 1600)
      blocks.push({ id: hash(`${documentId}:${page ?? 'text'}:${start}:${text}`), documentId, page, start, text })
    }
  }
  if (!blocks.length) throw Error('DOCUMENT_NO_TEXT: 扫描件需要另行OCR，未提取到文本')
  return { version: 1, documentId, name: path.basename(name), blocks, textCharacters: total,
    scope: 'extracted_text_only; PDF page numbers are physical pages; DOCX/TXT offsets are extracted text offsets' }
}
async function extractDocument(file, options = {}) {
  if (typeof file !== 'string' || !options.dataDir) throw Error('DOCUMENT_DATA_DIR_REQUIRED')
  const base = await fs.realpath(options.dataDir), actual = await fs.realpath(file), relative = path.relative(base, actual)
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw Error('DOCUMENT_OUTSIDE_DATA_DIR')
  const handle = await fs.open(actual, 'r')
  let bytes
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_BYTES) throw Error('DOCUMENT_SIZE_LIMIT')
    // Read at most MAX_BYTES+1 even if the file grows after stat.
    bytes = Buffer.alloc(Math.min(stat.size + 1, MAX_BYTES + 1))
    let read = 0
    while (read < bytes.length) {
      const { bytesRead } = await handle.read(bytes, read, bytes.length - read, read)
      if (!bytesRead) break
      read += bytesRead
    }
    bytes = bytes.subarray(0, read)
    if (read !== stat.size) throw Error('DOCUMENT_CHANGED_DURING_READ')
  } finally { await handle.close() }
  const ext = path.extname(actual).toLowerCase()
  if (['.txt', '.md'].includes(ext)) {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return buildDocument(bytes, actual, [{ text, page: null }])
  }
  if (ext === '.docx') {
    const mammoth = require('mammoth')
    const result = await mammoth.extractRawText({ buffer: bytes })
    return buildDocument(bytes, actual, [{ text: result.value, page: null }])
  }
  if (ext !== '.pdf') throw Error('DOCUMENT_FORMAT_UNSUPPORTED')
  const pdf = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = pdf.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useWorkerFetch: false, disableFontFace: true })
  let document
  try {
    document = await task.promise
    if (document.numPages > MAX_PAGES) throw Error('DOCUMENT_PAGE_LIMIT')
    const pages = []; let length = 0
    for (let page = 1; page <= document.numPages; page++) {
      const content = await (await document.getPage(page)).getTextContent()
      const text = content.items.map(item => typeof item.str === 'string' ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('')
      if ((length += text.length) > MAX_TEXT) throw Error('DOCUMENT_TEXT_LIMIT')
      pages.push({ page, text })
    }
    return buildDocument(bytes, actual, pages)
  } finally { await task.destroy() }
}
function validateDocuments(documents) {
  if (!Array.isArray(documents) || documents.length > 200) throw Error('DOCUMENT_COLLECTION_LIMIT')
  const ids = new Set(); let total = 0, count = 0
  for (const doc of documents) {
    if (!doc || !/^[a-f0-9]{64}$/.test(doc.documentId) || ids.has(doc.documentId) || !Array.isArray(doc.blocks)) throw Error('DOCUMENT_COLLECTION_INVALID')
    ids.add(doc.documentId)
    for (const block of doc.blocks) {
      if (++count > 100000 || typeof block.text !== 'string' || (total += block.text.length) > 8 * MAX_TEXT
        || block.documentId !== doc.documentId || block.id !== hash(`${doc.documentId}:${block.page ?? 'text'}:${block.start}:${block.text}`)) throw Error('DOCUMENT_BLOCK_INVALID')
    }
  }
}
function searchDocuments(documents, query, limit = 10) {
  validateDocuments(documents)
  if (typeof query !== 'string' || !query.trim() || query.length > 200 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw Error('DOCUMENT_QUERY_INVALID')
  const hits = [], needle = query.trim() // Exact literal matching preserves source offsets.
  for (const doc of documents) for (const block of doc.blocks) {
    const start = block.text.indexOf(needle)
    if (start >= 0) hits.push({ documentId: doc.documentId, blockId: block.id, name: doc.name, page: block.page, start, end: start + needle.length, quote: block.text.slice(start, start + needle.length) })
  }
  return { hits: hits.slice(0, limit), total: hits.length, truncated: hits.length > limit, method: 'case_sensitive_literal_per_block' }
}
function verifyCitation(documents, citation) {
  validateDocuments(documents)
  if (!citation || typeof citation.quote !== 'string' || !citation.quote.trim() || citation.quote.length > 1600) return { valid: false, reason: 'invalid_quote' }
  const doc = documents.find(item => item.documentId === citation.documentId), block = doc?.blocks.find(item => item.id === citation.blockId)
  if (!block) return { valid: false, reason: 'source_not_found' }
  const start = citation.start, end = citation.end
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > block.text.length || block.text.slice(start, end) !== citation.quote) return { valid: false, reason: 'quote_mismatch' }
  return { valid: true, documentId: doc.documentId, blockId: block.id, page: block.page, start, end, quote: block.text.slice(start, end), scope: 'exact_source_match_not_answer_correctness' }
}
module.exports = { extractDocument, searchDocuments, verifyCitation, inspectDependencies }
