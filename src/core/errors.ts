export class SessionNotFoundError extends Error {
  readonly name = "SessionNotFoundError";
  constructor(public selector: string) {
    super(`No session matched selector: ${selector}`);
  }
}

export class AmbiguousSelectorError extends Error {
  readonly name = "AmbiguousSelectorError";
  constructor(public selector: string, public candidates: string[]) {
    super(`Selector "${selector}" matched ${candidates.length} sessions: ${candidates.join(", ")}`);
  }
}

export class AdapterError extends Error {
  readonly name: string = "AdapterError";
  constructor(public adapter: string, message: string, public override cause?: unknown) {
    super(`[${adapter}] ${message}`, { cause });
  }
}

export class AdapterNotFoundError extends Error {
  readonly name = "AdapterNotFoundError";
  constructor(public adapter: string) {
    super(`Adapter "${adapter}" is not installed.`);
  }
}

export class CursorMismatchError extends Error {
  readonly name = "CursorMismatchError";
  constructor(public cursorAdapter: string, public sessionAdapter: string) {
    super(`Cursor was issued by adapter "${cursorAdapter}" but session uses "${sessionAdapter}".`);
  }
}

export class InvalidCursorError extends Error {
  readonly name = "InvalidCursorError";
  constructor(message: string) {
    super(`Invalid cursor: ${message}`);
  }
}

export class RegistryLockTimeoutError extends Error {
  readonly name = "RegistryLockTimeoutError";
  constructor(cause?: unknown) {
    super("Could not acquire lock on registry within timeout.", { cause });
  }
}

export class TranscriptUnreadableError extends AdapterError {
  override readonly name = "TranscriptUnreadableError";
}

export class TranscriptCorruptError extends AdapterError {
  override readonly name = "TranscriptCorruptError";
}

export class SummaryUnavailableError extends Error {
  readonly name = "SummaryUnavailableError";
  constructor(public reason: string) {
    super(`Summary mode unavailable: ${reason}`);
  }
}

export class PostRejectedError extends Error {
  readonly name = "PostRejectedError";
  constructor(public reason: string) {
    super(`Post rejected: ${reason}`);
  }
}

export class PostNotFoundError extends Error {
  readonly name = "PostNotFoundError";
  constructor(public postId: string) {
    super(`No post found with id: ${postId}`);
  }
}

export class NotAProjectError extends Error {
  readonly name = "NotAProjectError";
  constructor(public dir: string) {
    super(`Not a usable project directory: ${dir}`);
  }
}
