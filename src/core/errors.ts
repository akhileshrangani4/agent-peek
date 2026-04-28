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
    super(`[${adapter}] ${message}`);
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

export class RegistryLockTimeoutError extends Error {
  readonly name = "RegistryLockTimeoutError";
  constructor() {
    super("Could not acquire lock on registry within timeout.");
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
