"""Host-submitted GUI evidence for the six frozen todo-v1 criteria. No product edits.

Controls are discovered from their rendered labels/attributes. Assertions use fixed
values, not product-written tests or direct calls to generated business functions.
"""
import argparse
import json
import os
from pathlib import Path
import sys
import time
import importlib.util

spec = importlib.util.spec_from_file_location('owned_replay', Path(__file__).with_name('robustness-ui-replay.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

HELPERS = r'''(() => {
 const visible = e => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
 const button = pattern => [...document.querySelectorAll('button,[role=button]')].find(e => visible(e) && pattern.test(e.textContent.trim()));
 const rows = () => {
  const titles = [...document.querySelectorAll('span,div,p,label,s,del,em,strong,b,i,h2,h3,h4')].filter(e => e.children.length === 0 && e.textContent.trim() === '实验同名任务');
  return titles.map(e => {
   let row = e.closest('[data-id],[data-task-id],[data-bloma-id^="task.row."],[data-bloma-id^="list.row."]');
   if (!row) { row=e.parentElement; while(row && !row.querySelector('input[type=checkbox],button')) row=row.parentElement; }
   if (!row) throw Error('CONTROL_ADAPTER_ROW_MISSING');
   const toggle=row.querySelector('input[type=checkbox],[role=checkbox],[data-role=toggle]') || [...row.querySelectorAll('button')].find(b => /完成/.test(b.title+' '+b.getAttribute('aria-label')+' '+b.textContent));
   const del=[...row.querySelectorAll('button')].find(b => /删除|移除|Delete/i.test(b.title+' '+b.getAttribute('aria-label')+' '+b.textContent));
   const done=toggle?.type==='checkbox' ? toggle.checked : toggle?.getAttribute('aria-checked')==='true' || toggle?.dataset.done==='true' || /取消完成/.test(toggle?.title+' '+toggle?.getAttribute('aria-label')) || /line-through/.test(getComputedStyle(e).textDecorationLine);
   return {row,toggle,del,rawTitle:e.textContent,done};
  });
 };
 window.__externalTodoTest = {
  rows:()=>rows().filter(x=>visible(x.row)).map(x=>({title:x.rawTitle,done:x.done})),
  rowCount:()=>{const known=rows().find(x=>visible(x.row));if(!known)throw Error('CONTROL_ADAPTER_LIST_MISSING');return [...known.row.parentElement.children].filter(e=>visible(e)&&!!e.querySelector('input[type=checkbox],[role=checkbox],[data-role=toggle],button')).length;},
  add:(text)=>{const input=document.querySelector('#main-input,input[type=text],input:not([type]),textarea');if(!input)throw Error('CONTROL_ADAPTER_INPUT_MISSING');input.value=text;input.dispatchEvent(new Event('input',{bubbles:true}));const b=button(/新增|添加|加入|创建|^发送$|Add/i);if(!b)throw Error('CONTROL_ADAPTER_ADD_MISSING');b.click();},
  toggle:(i)=>{const r=rows().filter(x=>visible(x.row))[i];if(!r?.toggle)throw Error('CONTROL_ADAPTER_TOGGLE_MISSING');r.toggle.click();},
  delete:(i)=>{const r=rows().filter(x=>visible(x.row))[i];if(!r?.del)throw Error('CONTROL_ADAPTER_DELETE_MISSING');r.del.click();},
  filter:(view)=>{const patterns={all:/^全部/,active:/^未完成/,done:/^已完成/};const b=button(patterns[view]);if(!b)throw Error('CONTROL_ADAPTER_FILTER_MISSING');b.click();},
  acceptDelete:()=>{const b=button(/^确认删除$|^确定$|^删除任务$/);if(b)b.click();},
 };
 return true;
})()'''

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    root, output = args.root.resolve(), args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    data = output.parent / 'independent-app-data'
    data.mkdir(exist_ok=False)
    criteria = ['add-trim', 'empty-rejection', 'toggle-isolation', 'filters', 'delete-isolation', 'restart-persistence']
    report = {'root': str(root), 'data': str(data), 'checks': [], 'steps': [], 'scope': 'independent real WebView GUI; no direct business calls'}
    with (output.parent / 'product.log').open('w', encoding='utf-8') as log:
        replay = module.Replay(root, data, log, {'ready': "document.readyState==='complete' && !!document.querySelector('#main-input,input[type=text],input:not([type]),textarea')"})
        def js(expression):
            value = replay.js(expression)
            report['steps'].append({'expression': expression, 'result': value})
            return value
        def action(expression):
            js(expression); time.sleep(0.6)
        def check(id, fn, dependencies=()):
            if any(row['status'] != 'passed' for row in report['checks'] if row['id'] in dependencies):
                report['checks'].append({'id': id, 'status': 'pending', 'reason': 'Prerequisite GUI state was not established'})
                return
            try:
                fn(); report['checks'].append({'id': id, 'status': 'passed'})
            except AssertionError as error:
                report['checks'].append({'id': id, 'status': 'failed', 'error': str(error)})
            except Exception as error:
                report['checks'].append({'id': id, 'status': 'pending', 'harness_error': str(error)})
        def assert_rows(count, done=None):
            observed = js('window.__externalTodoTest.rows()')
            assert len(observed) == count, f'Expected {count} visible rows: {observed}'
            if done is not None:
                assert sum(row['done'] for row in observed) == done, f'Expected {done} completed rows: {observed}'
            return observed
        try:
            replay.start(); time.sleep(0.8); js(HELPERS)
            action("window.__externalTodoTest.filter('all')")
            def add_trim():
                action("window.__externalTodoTest.add('  实验同名任务  ')")
                observed = assert_rows(1, 0)
                assert observed[0]['title'] == '实验同名任务', observed
            check('add-trim', add_trim)
            def empty():
                before = js('window.__externalTodoTest.rowCount()')
                action("window.__externalTodoTest.add('   ')")
                assert_rows(1, 0)
                after = js('window.__externalTodoTest.rowCount()')
                assert before == after, f'Blank input changed the task row count: {before} -> {after}'
            check('empty-rejection', empty, ('add-trim',))
            def toggle():
                action("window.__externalTodoTest.add('实验同名任务')")
                assert_rows(2, 0)
                action('window.__externalTodoTest.toggle(0)'); assert_rows(2, 1)
                action('window.__externalTodoTest.toggle(0)'); assert_rows(2, 0)
                action('window.__externalTodoTest.toggle(0)'); assert_rows(2, 1)
            check('toggle-isolation', toggle, ('add-trim',))
            def filters():
                action("window.__externalTodoTest.filter('active')"); assert_rows(1, 0)
                action("window.__externalTodoTest.filter('done')"); assert_rows(1, 1)
                action("window.__externalTodoTest.filter('all')"); assert_rows(2, 1)
            check('filters', filters, ('toggle-isolation',))
            # Restore all view even if an assertion failed in another view.
            action("window.__externalTodoTest.filter('all')")
            def delete():
                action('window.__externalTodoTest.delete(1)')
                action('window.__externalTodoTest.acceptDelete()')
                assert_rows(1, 1)
            check('delete-isolation', delete, ('toggle-isolation',))
            def persistence():
                before = assert_rows(1, 1)
                replay.stop(); replay.start(); time.sleep(0.8); js(HELPERS)
                action("window.__externalTodoTest.filter('all')")
                after = assert_rows(1, 1)
                assert before == after, f'Restart changed rows: {before} -> {after}'
            check('restart-persistence', persistence, ('delete-isolation',))
        except Exception as error:
            report['harness_error'] = f'{type(error).__name__}: {error}'
        finally:
            replay.close()
    completed = {row['id'] for row in report['checks']}
    report['checks'] += [{'id': id, 'status': 'pending'} for id in criteria if id not in completed]
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    manual = [{'id': row['id'], 'passed': row['status'] == 'passed', 'evidence': str(output)} for row in report['checks'] if row['status'] in ('passed', 'failed')]
    output.with_name('manual.json').write_text(json.dumps(manual, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'checks': report['checks'], 'harness_error': report.get('harness_error')}, ensure_ascii=True))
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
