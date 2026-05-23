/**
 * staging-types — provisional correction staging entry schema (ADR 0025 §4.1.5).
 *
 * Staging entries are unconfirmed classifier hypotheses. They live in
 * `~/.abrain/.state/sediment/staging/` and are NOT in the memory_search
 * corpus. The staging-loader reads them to provide context for future
 * classifier runs. They age out after 30 days or are resolved (promoted
 * to durable / attributed to existing entry / archived).
 */

export interface StagingEntry {
  /** Bare slug: provisional-{hash8} */
  slug: string;
  status: "provisional";
  kind: "provisional-correction";
  created: string;           // ISO timestamp
  updated?: string;

  /** True until a future classifier resolves this hypothesis */
  attribution_pending: boolean;

  /** Device that captured this signal (for cross-device staging sync) */
  originating_device: string;

  /** Natural-language description of what the classifier guessed */
  hypothesis: string;

  /** Verbatim quotes from the user that triggered this hypothesis */
  source_utterance: Array<{
    quote: string;
    context: string;         // surrounding text
    captured_at: string;     // ISO
  }>;

  /** How the classifier suggested this be resolved */
  suggested_resolution_paths: string[];

  /** Raw CorrectionSignal output (for audit trace) */
  correction_signal?: {
    typing: string;
    confidence: number;
    scope_description: string;
    correction_intent: string;
    most_likely_error_direction: string;
  };

  /** Frontmatter: warning for downstream consumers */
  _provenance_warning: string;
}

export interface StagingFileOnDisk {
  schema_version: 1;
  entry: StagingEntry;
}
