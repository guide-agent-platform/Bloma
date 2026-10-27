import { existsSync, readFileSync } from 'node:fs';
import { freezeNativeGuiTests, sameNativeTestBytes } from './native-gui-tests';
import { findProject, updateProject } from '../project/project-service';
import { readPrdBackplane } from '../project/prd-store';
import { prdScopeFingerprint } from '../project/requirement-contract';
import { guiSuitePath, installGuiAcceptanceSuite, parseGuiSuite } from '../desktop/gui-acceptance';
import { assertRetainedSoftwareBehavior } from './regression-baseline';
import { createHash } from 'node:crypto';
import { canRepairUnexecutedNativePlan } from './verification';
import { join } from 'node:path';
import { getPromaHome } from '../../storage/config-paths';
import { writeTextFileAtomic } from '../../storage/json-store';
export function registerNativeGuiTests(projectId: string, script: string, restart = false) {
    const project = findProject(projectId), brief = readPrdBackplane(projectId), scope = prdScopeFingerprint(brief);
    if (project.workflow_version !== 'software-v1' || !brief.user_confirmed_at || project.ux_confirmation?.prd_fingerprint !== scope)
        throw Error('GUI_CONFIRMED_SCOPE_REQUIRED');
    const covers = brief.requirements.map(item => item.id), native_tests = freezeNativeGuiTests(projectId, project.root_path, script, covers, restart);
    const suite = parseGuiSuite({ version: 1, scope_hash: scope, design_hash: project.ux_confirmation.design_hash, covers, steps: [], native_tests });
    if (existsSync(guiSuitePath(projectId))) {
        const bytes=readFileSync(guiSuitePath(projectId)),previous = parseGuiSuite(JSON.parse(bytes.toString('utf8')));
        const repairable=Boolean(previous.native_tests)&&canRepairUnexecutedNativePlan(projectId,createHash('sha256').update(bytes).digest('hex'))
        if (previous.scope_hash === scope && (!previous.native_tests || previous.native_tests.contract !== native_tests.contract && !sameNativeTestBytes(previous.native_tests, native_tests))&&!repairable)
            throw Error('GUI_EXISTING_EXPECTATIONS_CHANGED: 同目标只允许修正定位，不能改输入、断言或测试逻辑过关');
    }
    assertRetainedSoftwareBehavior(projectId, 'gui', suite);
    // Immutable identity pair records every accepted adapter revision. No model
    // can use the audit record to replace the frozen business contract.
    const previous = existsSync(guiSuitePath(projectId)) ? parseGuiSuite(JSON.parse(readFileSync(guiSuitePath(projectId), 'utf8'))) : undefined;
    writeTextFileAtomic(join(getPromaHome(), 'gui-native-adapters', projectId, `${native_tests.digest}.json`), JSON.stringify({
        version: 1, at: new Date().toISOString(), scope, previous: previous?.native_tests?.digest, current: native_tests.digest, contract: native_tests.contract,
        rule: 'static-locators-and-bounded-wait-options-v1'
    }));
    installGuiAcceptanceSuite(projectId, suite);
    updateProject(projectId, { gui_acceptance: { status: 'sealed', scope_hash: scope } });
    return suite;
}
