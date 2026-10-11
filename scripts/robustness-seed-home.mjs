// Only for the explicitly authorized six-case run. Encrypted secrets never enter stdout.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
const [target, authorization] = process.argv.slice(2)
if (!target || authorization !== '--authorized-credentials') throw new Error('Explicit credential-copy authorization required')
const home = resolve(target)
const rel = relative(resolve(tmpdir()), home)
if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || existsSync(join(home, 'projects.json'))) throw new Error('Fresh home inside the named temporary directory required')
const source = join(homedir(), '.proma')
mkdirSync(home, { recursive: true })
for (const name of ['bloma-channels.json', 'category-routing.json', 'settings.json']) copyFileSync(join(source, name), join(home, name))
mkdirSync(join(home, 'prompts'), { recursive: true })
for (const name of ['guide-system.md', 'prd-system.md']) copyFileSync(join(source, 'prompts', name), join(home, 'prompts', name))
mkdirSync(join(home, 'host-evidence'), { recursive: true })
copyFileSync(join(source, 'host-evidence/speech-component.json'), join(home, 'host-evidence/speech-component.json'))
const state = JSON.parse(readFileSync(join(process.env.APPDATA, 'bloma/Local State'), 'utf8'))
if (!state.os_crypt) throw new Error('Matching encrypted profile state missing')
mkdirSync(join(home, 'electron-user-data'), { recursive: true })
writeFileSync(join(home, 'electron-user-data/Local State'), JSON.stringify({ os_crypt: state.os_crypt }))
console.log(JSON.stringify({ home, isolated_user_data: true, encrypted_profile_seeded: true, plaintext_saved: false, source_modified: false }))
