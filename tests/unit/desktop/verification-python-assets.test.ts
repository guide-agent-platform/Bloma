import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Execute the actual Python assets, never a GUI or generated application.
function assetCall(asset: string, expression: string, source: string): any {
  const code = `import importlib.util,json,sys,ast\nspec=importlib.util.spec_from_file_location('asset',sys.argv[1])\nm=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\ns= sys.argv[2]\n${expression}`
  return JSON.parse(execFileSync('python', ['-c', code, resolve('main/templates/tools', asset), source],
    { encoding: 'utf8', timeout: 10000, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' } }).trim())
}

describe('actual Python verification assets', () => {
  it('fixed-audio import wrapper preserves Python CLI loader methods without invoking any hardware', () => {
    const code = `import runpy,os,json\nos.environ.pop('BLR_FIXED_AUDIO_WAV',None)\nm=runpy.run_path('tests/fixtures/robustness/voice-sitecustomize.py')\nclass Loader:\n def get_code(self,name): return compile('x=42','fixture.py','exec')\n def get_filename(self,name): return 'fixture.py'\ng=m['GuardLoader'](Loader())\nns={}\nexec(g.get_code('fixture'),ns)\nprint(json.dumps({'value':ns['x'],'filename':g.get_filename('fixture')}))`
    const output = execFileSync('python', ['-c', code], { encoding: 'utf8', timeout: 10000, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' } })
    expect(JSON.parse(output)).toEqual({ value: 42, filename: 'fixture.py' })
  })
  it('validation mutation changes only the selected class method and reports its real name/line', () => {
    const source = 'class Logic:\n    def handle_send(self, text):\n        if not text:\n            raise ValueError("empty")\n        return text\n\ndef main():\n    if "--self-check" in args:\n        return 0\n    return 1\n'
    const result = assetCall('fault-seeds.py', 'mutated,info=m.apply_seed(s,"FS-VALIDATION-REMOVE")\nprint(json.dumps({"info":info,"source":mutated}))', source)
    expect(result.info).toMatchObject({ applied: true, function: 'handle_send', line: 3 })
    expect(result.source).not.toContain('if not text')
    expect(result.source).toContain("if '--self-check' in args:")
  })

  it('CLI dispatch is not an empty-input validation seed', () => {
    const result = assetCall('fault-seeds.py', 'mutated,info=m.apply_seed(s,"FS-VALIDATION-REMOVE")\nprint(json.dumps(info))', 'def main():\n    if "--self-check" in args:\n        return 0\n    return 1\n')
    expect(result.applied).toBe(false)
  })

  it('same-name save methods mutate only one selected function', () => {
    const source = 'class A:\n    def save(self,x):\n        x.write("a")\nclass B:\n    def save(self,x):\n        x.write("b")\n'
    const result = assetCall('fault-seeds.py', 'mutated,info=m.apply_seed(s,"FS-SAVE-NOP")\nprint(json.dumps({"source":mutated,"info":info}))', source)
    expect(result.source).toContain("x.write('b')")
    expect(result.source).not.toContain("x.write('a')")
  })

  it('state reads across an action are not aliases, direct aliases remain rejected', () => {
    const source = 'def test_state(session):\n    before=session.read("value")\n    session.click()\n    after=session.read("value")\n    assert before==after\n\ndef test_alias(actual):\n    expected=actual\n    assert expected==actual\n'
    const result = assetCall('contract-audit.py', 'print(json.dumps([f for n in ast.parse(s).body for f in m.audit_function(n,"fixture.py")]))', source)
    expect(result.filter((f: any) => f.state === 'reject')).toEqual([expect.objectContaining({ kind: 'alias-compare', line: 9 })])
  })

  it('cleanup fallback is inconclusive; swallowing errors inside a test remains rejected', () => {
    const source = 'def cleanup():\n    try: stop()\n    except Exception: pass\n\ndef test_behavior():\n    try: assert run()\n    except Exception: pass\n'
    const result = assetCall('contract-audit.py', 'print(json.dumps([f for n in ast.parse(s).body for f in m.audit_function(n,"fixture.py")]))', source)
    expect(result).toContainEqual(expect.objectContaining({ line: 3, state: 'inconclusive' }))
    expect(result).toContainEqual(expect.objectContaining({ line: 7, state: 'reject' }))
  })

  it('a snapshot alias followed by reassignment is a different observation', () => {
    const source = 'def test_state(session):\n    value=session.read()\n    before=value\n    session.click()\n    value=session.read()\n    assert before==value\n'
    const result = assetCall('contract-audit.py', 'print(json.dumps([f for n in ast.parse(s).body for f in m.audit_function(n,"fixture.py")]))', source)
    expect(result.filter((f: any) => f.state === 'reject')).toEqual([])
  })
})
