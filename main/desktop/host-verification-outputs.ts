/** Host-rendered review UI is an output, never a product verification input. */
export const MVP_REVIEW_RELATIVE_PATH = '00_VERIFY/mvp-review.html'
export function isHostPresentationOutput(path: string): boolean {
  return path.replaceAll('\\', '/').toLowerCase() === MVP_REVIEW_RELATIVE_PATH.toLowerCase()
}
