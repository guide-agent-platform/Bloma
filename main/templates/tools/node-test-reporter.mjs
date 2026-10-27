// Executed by Node's reporter parent, not by the project test module. Console
// JSON and returned status strings are never treated as native test events.
export default async function* report(events) {
    for await (const event of events) {
        if (!['test:pass', 'test:fail'].includes(event.type))
            continue;
        const d = event.data;
        const error = d.details?.error?.cause ?? d.details?.error;
        const bounded = value => value === undefined ? undefined : String(typeof value === 'string' ? value : JSON.stringify(value)).slice(0, 1600);
        yield JSON.stringify({ type: event.type, name: d.name, skip: d.skip, todo: d.todo,
            assertion: error ? { expected: bounded(error.expected ?? error.matcherResult?.expected), actual: bounded(error.actual ?? error.matcherResult?.actual) } : undefined,
            error: d.details?.error ? String(d.details.error.stack ?? d.details.error.message ?? d.details.error).slice(0, 5000) : undefined }) + '\n';
    }
}
