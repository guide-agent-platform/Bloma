import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const python = process.platform === 'win32' ? 'python' : 'python3'
const available = spawnSync(python, ['--version'], { encoding: 'utf8' }).status === 0
const prefix = `
import importlib.util,json,sys,tempfile
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('record_store',sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
directory=tempfile.TemporaryDirectory();root=Path(directory.name)
path=root/'records.json'
store=module.JsonRecordStore(path,required_keys=('id','name'))
`
function run(code: string) {
  const result = spawnSync(python, ['-B', '-c', prefix + code, resolve('main/templates/skeletons/desktop-python/record_store.py')], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
}
describe.skipIf(!available)('platform JSON record store (real Python)', () => {
  it('persists updates, detaches reads and allows equal business content', () => run(`
assert not path.exists() and store.read()==[]
store.update(lambda records: records.extend([{'id':'1','name':'meal'},{'id':'2','name':'meal'}]))
snapshot=store.read();snapshot[0]['name']='changed'
assert store.read()[0]['name']=='meal'
assert module.JsonRecordStore(path,required_keys=('id','name')).read()==store.read()
assert len(store.read())==2
`))
  it('does not commit memory or disk if atomic replacement fails', () => run(`
store.update(lambda rows: rows.append({'id':'1','name':'before'}))
before=path.read_bytes()
try:
    with patch.object(module.os,'replace',side_effect=OSError('disk failure')):
        store.update(lambda rows: rows.append({'id':'2','name':'after'}))
except OSError: pass
else: raise AssertionError('write should fail')
assert store.read()==[{'id':'1','name':'before'}]
assert path.read_bytes()==before
assert not list(root.glob('*.tmp'))
`))
  it('preserves corrupt and invalid-schema files and refuses overwriting them', () => run(`
for invalid in ['broken {','{}','[{}]']:
    path.write_text(invalid,encoding='utf-8');before=path.read_bytes()
    damaged=module.JsonRecordStore(path,required_keys=('id','name'))
    for operation in [damaged.read,lambda:damaged.update(lambda rows:rows.append({'id':'x','name':'new'}))]:
        try:operation()
        except module.DataIntegrityError:pass
        else:raise AssertionError('corrupt data accepted')
    assert path.read_bytes()==before
`))
  it('failed validation and business actions leave the previous state intact', () => run(`
store.update(lambda rows:rows.append({'id':'1','name':'valid'}));before=path.read_bytes()
try:store.update(lambda rows:rows.append({'id':'2'}))
except module.DataIntegrityError:pass
else:raise AssertionError('schema failure accepted')
def failing(rows):
    rows.clear()
    raise ValueError('business validation failed')
try:store.update(failing)
except ValueError:pass
assert store.read()==[{'id':'1','name':'valid'}] and path.read_bytes()==before
`))
})
