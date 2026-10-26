import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { GuiAcceptanceSuite } from '../desktop/gui-acceptance';
import type { LaunchDeclaration } from '../desktop/launch-smoke';
import { openDebugSession, actDebugSession, closeDebugSessions } from './debug-sessions';
import { debugWorkspace } from './debug-workspace';
import { frozenNativeGuiEntry, nativeGuiObservations } from './native-gui-tests';
export async function runNativeGuiTests(input: {
    projectId: string;
    root: string;
    launch: LaunchDeclaration;
    suite: GuiAcceptanceSuite;
    signal?: AbortSignal;
}) {
    const native = input.suite.native_tests!, file = frozenNativeGuiEntry(input.projectId, native, input.root);
    const sessionId = `host-native-${randomUUID()}`, signal = input.signal ?? new AbortController().signal;
    const workspace=debugWorkspace(input.projectId,sessionId)
    const reports: Array<{
        code: number;
        events: string;
        trace: string;
    }> = [];
    const runtimeFailures:string[]=[]
    try {
        for (const phase of native.restart ? ['initial', 'reopened'] : ['initial']) {
            signal.throwIfAborted();
            const opened = await openDebugSession({ projectId: input.projectId, sessionId, root: input.root, launch: input.launch, signal, formal:true });
            const directory = debugWorkspace(input.projectId, sessionId), report = join(directory, `native-${phase}.jsonl`), trace = join(directory, `native-${phase}-trace.json`);
            const observed = await actDebugSession({ projectId: input.projectId, sessionId, id: opened.id, signal, nativeTests: { file, phase, report, trace } });
            const outcome = observed.steps.find(step => step.id === 'native-tests')?.actual as {
                exit_code?: number;
                stderr?: string;
            } | undefined;
            if (!existsSync(report) || !existsSync(trace) || statSync(report).size > 2 * 1024 * 1024 || statSync(trace).size > 16384)
                throw Error(`GUI_NATIVE_REPORT_MISSING: ${outcome?.stderr ?? ''}\n${existsSync(report) ? readFileSync(report, 'utf8').slice(-8000) : 'Node reporter did not produce output'}`);
            const runtimeErrors = observed.observations.filter(row => row.version === observed.version && /^renderer\.(?:error|startup_error)$/.test(row.kind));
            runtimeFailures.push(...runtimeErrors.map(row=>row.message))
            reports.push({ code: runtimeErrors.length ? 1 : outcome?.exit_code ?? 1, events: readFileSync(report, 'utf8'), trace: readFileSync(trace, 'utf8') });
            await closeDebugSessions(input.projectId, sessionId);
            if (outcome?.exit_code !== 0 || runtimeErrors.length)
                break;
        }
        frozenNativeGuiEntry(input.projectId, native, input.root);
        const result=nativeGuiObservations(input.suite,reports)
        return runtimeFailures.length?{...result,status:'failed' as const,error:`GUI_NATIVE_RUNTIME_ERROR: ${runtimeFailures[0]}`,
          steps:[...result.steps,{id:'native-runtime',passed:false,actual:runtimeFailures.slice(0,3)}]}:result
    }
    finally {
        await closeDebugSessions(input.projectId, sessionId);
        // Reports and synthetic data remain inspectable; don't retain a large
        // Chromium profile for every finished formal test run. These are owned
        // isolated test directories, never a user's daily browser profile.
        for(const name of ['formal-profile','profile','environment-home']){
          const target=join(workspace,name)
          if(!existsSync(target))continue
          if(lstatSync(target).isSymbolicLink()||relative(realpathSync(workspace),realpathSync(target))!==name)throw Error('GUI_NATIVE_CLEANUP_PATH_INVALID')
          try{rmSync(target,{recursive:true,force:true,maxRetries:3,retryDelay:100})}catch{console.warn('Native test profile cleanup deferred; isolated diagnostic workspace retained')}
        }
    }
}
