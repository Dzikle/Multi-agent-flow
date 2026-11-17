import { z } from "zod";

const id = z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const isoTime = z.string().datetime({ offset: true });
const data = z.record(z.string(), z.unknown()).default({});

export const eventSchema = z.object({
  event_id: id,
  type: z.enum([
    "run.created", "run.started", "run.waiting", "run.blocked", "run.resumed",
    "run.completed", "run.failed", "run.cancelled",
    "attempt.started", "attempt.progress", "attempt.heartbeat",
    "attempt.succeeded", "attempt.failed", "attempt.interrupted",
    "attempt.timed_out", "attempt.cancelled",
    "system.tick", "system.idle", "system.error"
  ]),
  run_id: id.optional(),
  attempt_id: id.optional(),
  actor: z.string().min(1).max(100),
  occurred_at: isoTime.optional(),
  data
}).strict();
export type EventInput = z.infer<typeof eventSchema>;

export const usageSchema = z.object({
  sample_id: id,
  attempt_id: id,
  provider: z.string().min(1).max(100),
  model: z.string().max(200).optional(),
  input_tokens: z.number().int().nonnegative().nullable().optional(),
  output_tokens: z.number().int().nonnegative().nullable().optional(),
  cached_input_tokens: z.number().int().nonnegative().nullable().optional(),
  cost_usd_micros: z.number().int().nonnegative().nullable().optional(),
  source: z.enum(["provider_reported", "estimated", "manual"])
}).strict();
export type UsageInput = z.infer<typeof usageSchema>;

export class LedgerError extends Error {
  constructor(public readonly code: string, message: string, public readonly httpStatus = 400) {
    super(message);
  }
}
