export const ExitCode = {
  SUCCESS: 0,
  INPUT_INVALID: 10,
  PROMPT_UNREADABLE: 11,
  MODEL_INVOCATION_FAILED: 20,
  TIMEOUT: 21,
  OUTPUT_TOO_LARGE: 22,
  NORMALIZE_FAILED: 30,
  WORKSPACE_VIOLATION: 40,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/** Raised internally to unwind the pipeline with a specific exit code. */
export class RuntimeError extends Error {
  readonly code: ExitCodeValue;

  constructor(code: ExitCodeValue, message: string) {
    super(message);
    this.code = code;
    this.name = "RuntimeError";
  }
}

/** Classifies a failed opencode invocation attempt for the retry policy. */
export type FailureClass = "transport" | "timeout" | "malformed-output" | "terminal";

export interface StepFinishTelemetry {
  model?: string;
  attempts: number;
  duration_ms: number;
  tokens_input?: number;
  tokens_output?: number;
  cost?: number;
}

export interface NdjsonEvent {
  type: string;
  timestamp?: number;
  part?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface NormalizeOutcome {
  text: string;
  telemetry: Partial<StepFinishTelemetry>;
  warnings: string[];
}
