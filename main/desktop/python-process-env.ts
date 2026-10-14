/** Normalize both Python's standard streams and nested text-mode subprocess pipes.
 * PYTHONIOENCODING alone leaves subprocess.run(text=True) on the Windows locale.
 * Explicit operator overrides remain available for encoding compatibility checks. */
export function pythonEncodingEnv(parentEnv: NodeJS.ProcessEnv): Record<string, string> {
  return {
    PYTHONIOENCODING: parentEnv.PYTHONIOENCODING ?? 'utf-8',
    PYTHONUTF8: parentEnv.PYTHONUTF8 ?? '1',
  }
}
