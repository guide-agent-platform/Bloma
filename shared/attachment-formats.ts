export const TEXT_ATTACHMENT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'log', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'xml', 'html', 'css', 'scss', 'js', 'jsx', 'ts', 'tsx', 'py', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs', 'sh', 'ps1', 'sql', 'vue', 'svelte', 'rb', 'php', 'r'])
export function isTextAttachmentName(name: string): boolean {
  return typeof name === 'string' && TEXT_ATTACHMENT_EXTENSIONS.has(name.split('.').at(-1)?.toLowerCase() ?? '')
}
