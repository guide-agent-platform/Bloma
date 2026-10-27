import type {PrdReviewIssue} from './prd-review-contracts'
export function deriveVerdict(issues: PrdReviewIssue[]): 'pass' | 'needs_revision' {
  return issues.some((issue) => issue.severity === 'blocking' || issue.severity === 'major')
    ? 'needs_revision'
    : 'pass'
}
