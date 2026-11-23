// SPEC §3 rule 8: one of three confidence levels per tool.
export type Confidence = "low" | "medium" | "high";

export const LOW_MIN_SAMPLES = 3;
export const HIGH_MIN_SAMPLES = 10;
export const HIGH_MIN_DISTINCT_ARGS = 3;
export const STALE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ConfidenceInput {
  /** Success samples (errors are not counted). */
  samples: number;
  /** Distinct argument hashes among those samples. */
  distinctArgs: number;
  /** Arrays seen anywhere in the success shapes, and how many of them had items. */
  arraysSeen: number;
  nonEmptyArrays: number;
  /** Timestamp of the newest success sample. */
  newest?: Date;
  now: Date;
}

export function confidence(input: ConfidenceInput): { level: Confidence; reasons: string[] } {
  const reasons: string[] = [];
  if (input.samples < LOW_MIN_SAMPLES) reasons.push(`fewer than ${LOW_MIN_SAMPLES} samples`);
  if (input.arraysSeen > 0 && input.nonEmptyArrays === 0) reasons.push("every array seen was empty");
  if (input.distinctArgs <= 1) reasons.push("at most 1 distinct argument set");
  let level: Confidence;
  if (reasons.length > 0) level = "low";
  else if (input.samples >= HIGH_MIN_SAMPLES && input.distinctArgs >= HIGH_MIN_DISTINCT_ARGS) level = "high";
  else level = "medium";

  if (input.newest) {
    const ageDays = (input.now.getTime() - input.newest.getTime()) / DAY_MS;
    if (ageDays > STALE_DAYS) {
      reasons.push(`newest sample is ${Math.floor(ageDays)} days old`);
      level = level === "high" ? "medium" : "low";
    }
  }
  return { level, reasons };
}
