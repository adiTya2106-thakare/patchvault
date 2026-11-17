export interface AgentRunContext {
  workspaceRoot: string;
  prompt: string;
  onEvent: (type: string, meta: Record<string, string | number | boolean | null>) => void;
  onToken?: (token: string) => void;
  abortSignal?: AbortSignal;
}

export interface AgentRunResult {
  sessionId: string | null;
  /** Files the agent said it intends to change, if the integration can report that. */
  plannedChanges: string[] | null;
  summary: string;
  fallbackUsed?: boolean;
  fallbackModel?: string;
  cancelled?: boolean;
}

/** PATCHVAULT never runs an agent loop itself. It only calls an adapter. */
export interface AgentAdapter {
  readonly name: string;
  /** true only for simulated adapters. Surfaced in the UI and stored in the capsule. */
  readonly isMock: boolean;
  run(ctx: AgentRunContext): Promise<AgentRunResult>;
}
