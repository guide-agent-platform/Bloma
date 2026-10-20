// Shared persistence helpers live below main so storage/json-store can reuse them.
export { WIN32_RETRYABLE, POSIX_RETRYABLE, DEFAULT_RETRYABLE_CODES,
  rmSyncWithRetry, renameWithRetry, renameIfDestinationAbsentWithRetry,
  type FsRetryDeps } from '../../../storage/fs-retry'
