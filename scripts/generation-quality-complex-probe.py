"""Independent fixed-value checks against a read-only snapshot, never the generated original."""
import argparse
import copy
from decimal import Decimal
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from unittest.mock import patch


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--reopen-data', type=Path)
    parser.add_argument('--fault-only', action='store_true')
    args = parser.parse_args()
    root = args.root.resolve()
    if 'generation-quality-audit' not in str(root) or not (root / 'snapshot-source.json').is_file():
        raise ValueError('Only the owned source snapshot can be executed')
    sys.path.insert(0, str(root))
    os.chdir(root)
    import app
    if args.reopen_data:
        logic = app.Logic(args.reopen_data)
        print(json.dumps({'plans': [{**row, 'detail': logic.get_plan(row['id'])} for row in logic.list_plans()['records']]}, ensure_ascii=True))
        return 0
    results = []
    def test(name, fn):
        try:
            observed = fn()
            results.append({'name': name, 'passed': True, 'observed': observed})
        except Exception as error:
            results.append({'name': name, 'passed': False, 'error': f'{type(error).__name__}: {error}'})
    def usage(row):
        return [Decimal(item['usage']) for item in row['materials']]
    def file_state(data):
        return {str(file.relative_to(data)): hashlib.sha256(file.read_bytes()).hexdigest() for file in data.rglob('*.json')}
    if args.fault_only:
        with tempfile.TemporaryDirectory(prefix='bloma-complex-fault-') as folder:
            data = Path(folder)
            logic = app.Logic(data)
            plan = logic.create_plan('故障测试方案')['plan']['id']
            materials = [{'name':'演示材料A','percent':80},{'name':'演示材料B','percent':20}]
            logic.generate_round(plan,100,materials,800,800)
            def failed_write():
                before = file_state(data)
                with patch('record_store.os.replace', side_effect=OSError('owned injected write failure')):
                    try: logic.generate_round(plan,120,materials,1200,1200)
                    except Exception: pass
                    else: raise AssertionError('write failure reported as success')
                assert file_state(data) == before
                assert logic.get_plan(plan)['plan']['round_count'] == 1
                logic.generate_round(plan,120,materials,1200,1200)
                assert logic.get_plan(plan)['plan']['round_count'] == 2
                return {'disk_and_memory_preserved':True,'retry_succeeded':True}
            test('failed_write_preserves_disk_and_memory_then_retry', failed_write)
            def corrupt_store():
                damaged = data/'corrupt'
                damaged.mkdir()
                file = damaged/'plans.json'
                original = b'{broken-json'
                file.write_bytes(original)
                try: app.Logic(damaged).list_plans()
                except Exception: pass
                else: raise AssertionError('corrupt store silently reset')
                assert file.read_bytes() == original
                return {'corrupt_file_preserved':True,'explicit_failure':True}
            test('corrupt_store_refuses_reset_and_preserves_original_bytes', corrupt_store)
        report = {'root':str(root),'scope':'owned filesystem fault and corruption injection',
                  'status':'passed' if all(row['passed'] for row in results) else 'failed','tests':results}
        args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
        print(json.dumps(report,ensure_ascii=True))
        return 0 if report['status']=='passed' else 1
    with tempfile.TemporaryDirectory(prefix='bloma-complex-independent-') as folder:
        data = Path(folder)
        logic = app.Logic(data)
        a = logic.create_plan('演示一')['plan']['id']
        ab = lambda x, y: [{'name': '演示材料A', 'percent': x}, {'name': '演示材料B', 'percent': y}]
        def rounds():
            rows = [logic.generate_round(a, 100, ab(80, 20), 800, 800)['round'],
                    logic.generate_round(a, 120, ab(80, 20), 1200, 1200)['round'],
                    logic.generate_round(a, 120, ab(70, 30), 1200, 1200)['round']]
            assert [usage(row) for row in rows] == [[Decimal(80), Decimal(20)], [Decimal(96), Decimal(24)], [Decimal(84), Decimal(36)]]
            assert rows[0]['svg'] != rows[1]['svg']
            def geometry(text):
                return [(el.tag, sorted((key, value) for key, value in el.attrib.items() if key in ('r','cx','cy','x','y','x1','x2','y1','y2','width','height','d','points'))) for el in ET.fromstring(text).iter()]
            assert geometry(rows[0]['svg']) != geometry(rows[1]['svg']), 'only dimension text changed'
            for index, expected in ((1, [80,20]), (2, [96,24]), (3, [84,36])):
                logic.view_round(a, index)
                detail = logic.get_plan(a)
                assert usage(detail['viewing']) == list(map(Decimal, expected))
                assert detail['latest']['index'] == 3
            return {'round_usage': [[str(value) for value in usage(row)] for row in rows], 'geometry_changed': True}
        test('fixed_three_rounds_history_and_svg_geometry', rounds)
        def invalid():
            before = file_state(data)
            refused = []
            for batch, materials in ((120,ab(90,30)), (-1,ab(70,30)), ('NaN',ab(70,30)), ('Infinity',ab(70,30))):
                try: logic.generate_round(a, batch, materials, 1200, 1200)
                except app.ValidationError: refused.append(True)
                else: refused.append(False)
            assert all(refused), refused
            assert logic.get_plan(a)['plan']['round_count'] == 3
            assert file_state(data) == before
            return {'refused': refused, 'disk_unchanged': True}
        test('invalid_ratio_negative_nan_infinity_preserve_disk', invalid)
        b = logic.create_plan('演示二')['plan']['id']
        logic.generate_round(b, 50, [{'name':'演示材料A','percent':60},{'name':'演示材料C','percent':40}], 600, 500)
        def restart():
            run = subprocess.run([sys.executable, '-B', str(Path(__file__).resolve()), str(root), str(args.output.resolve()), '--reopen-data', str(data)], capture_output=True, text=True, timeout=20)
            assert run.returncode == 0, run.stderr[-300:]
            rows = {row['name']:row for row in json.loads(run.stdout)['plans']}
            assert set(rows) == {'演示一','演示二'}
            assert rows['演示一']['round_count'] == 3
            assert usage(rows['演示一']['detail']['latest']) == [Decimal(84),Decimal(36)]
            assert usage(rows['演示二']['detail']['latest']) == [Decimal(30),Decimal(20)]
            return {'fresh_process': True, 'plans': ['演示一','演示二'], 'history_retained': True}
        test('two_plans_and_history_survive_fresh_process', restart)
        exported = None
        def transfer():
            nonlocal exported
            exported = json.loads(Path(logic.export_plan(a)['export']['path']).read_text(encoding='utf8'))
            assert len(exported['rounds']) == 3
            for kind in ('csv','svg'):
                file = Path(logic.export_round(a,3,kind)['export']['path'])
                assert file.is_relative_to(data) and file.stat().st_size > 0
            imported = logic.import_plan(json.dumps(exported,ensure_ascii=False))['plan']
            assert imported['id'] != a and imported['name'] != '演示一'
            assert usage(logic.get_plan(imported['id'])['latest']) == [Decimal(84),Decimal(36)]
            before = file_state(data)
            for payload in ('{bad-json', '{}'):
                try: logic.import_plan(payload)
                except app.ValidationError: pass
                else: raise AssertionError('bad import was accepted')
                assert file_state(data) == before
            return {'roundtrip_rounds':3,'malformed_import_preserves_disk':True}
        test('json_csv_svg_export_roundtrip_and_bad_import', transfer)
        def decimal_mass():
            plan = logic.create_plan('小数精度反例')['plan']['id']
            row = logic.generate_round(plan, '0.03', ab(50,50), 800, 800)['round']
            values = usage(row)
            assert sum(values) == Decimal('0.03'), f'valid 0.03kg batch produced {values}, sum={sum(values)}'
            return {'usage':list(map(str,values)), 'sum':str(sum(values))}
        test('valid_small_decimal_batch_conserves_total_mass', decimal_mass)
        def tampered_import():
            assert exported is not None
            payload = copy.deepcopy(exported)
            payload['name'] = '导入用量一致性反例'
            payload['rounds'][-1]['materials'][0]['usage'] = '999.00'
            before = file_state(data)
            try: imported = logic.import_plan(json.dumps(payload,ensure_ascii=False))['plan']
            except app.ValidationError:
                assert file_state(data) == before
                return {'inconsistent_derived_data_rejected':True}
            values = usage(logic.get_plan(imported['id'])['latest'])
            assert values == [Decimal(84),Decimal(36)], f'import trusted forged derived usage {values} instead of 84/36'
            return {'derived_data_recomputed':True}
        test('import_rejects_or_recomputes_inconsistent_derived_usage', tampered_import)
    report = {'root':str(root),'scope':'independent real Logic, owned disk, and fresh process; external model content not evaluated',
              'status':'passed' if all(row['passed'] for row in results) else 'failed', 'tests':results}
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps(report,ensure_ascii=True))
    return 0 if report['status']=='passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
