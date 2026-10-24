import { DecisionPool } from "./decision-pool.ts";
import { StoreError } from "./run-store.ts";
export class DecisionError extends Error {}
export const decisionError = (error: unknown, signal: AbortSignal) => signal.aborted
  ? signal.reason?.name === "TimeoutError" ? "operation_timeout" : "cancelled"
  : error instanceof DecisionError ? error.message : error instanceof StoreError ? error.message.includes(": stale_policy") ? "stale_policy" : error.message.includes(": operation_expired") ? "operation_expired" : "reducer_rejected" : "execution_failed";

// Shared existing Bitdeer adapter: complete structured output is validated before any action.
export async function fleetInference(options: {
  pool: DecisionPool; env: NodeJS.ProcessEnv; signal: AbortSignal; model: string;
  stage: "coordinator" | "specialist"; tokens: number; timeoutMs: number;
  system: unknown; input: unknown; schema: object; metric: any;
  validate: (value: any) => boolean; progress: () => Promise<unknown>;
}) {
  const { pool, env, signal, model, stage, tokens, timeoutMs, system, input, schema, metric, validate, progress } = options;
  signal.throwIfAborted();
  const began = Date.now();
  metric.reasoningEffort = env.BITDEER_REASONING_EFFORT || (/^zai-org\/GLM-5/.test(model) ? "low" : undefined);
  metric.promptBytes = JSON.stringify([system, input]).length;
  await progress();
  let release: (() => void) | undefined;
  let requestSignal: AbortSignal | undefined;

  try {
    const queuedAt = Date.now();
    release = await pool.acquire(signal);
    signal.throwIfAborted();
    metric.queueWaitMs = Date.now() - queuedAt;
    metric.startedAt = Date.now();
    metric.status = "running";
    await progress();
    requestSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(timeoutMs),
    ]);
    metric.requestAt = Date.now();
    const r = await fetch(
      "https://api-inference.bitdeer.ai/v1/chat/completions",
      {
        method: "POST",
        redirect: "error",
        signal: requestSignal,
        headers: {
          authorization: `Bearer ${env.BITDEER_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: metric.model,
          temperature: 0,
          max_tokens: tokens,
          ...(metric.reasoningEffort ? { reasoning_effort: metric.reasoningEffort } : {}),
          response_format: {
            type: "json_schema",
            json_schema: {
              name: stage === "coordinator" ? "fleet_plan" : "fleet_action",
              strict: true,
              schema,
            },
          },
          messages: [
            { role: "system", content: JSON.stringify(system) },
            { role: "user", content: JSON.stringify(input) },
          ],
        }),
      },
    );
    if (!r.ok) {
      metric.httpStatus = r.status;
      await r.body?.cancel();
      throw new DecisionError(
        r.status === 429 ? "provider_rate_limit" : "provider_http_error",
      );
    }
    const raw = await r.text();
    if (raw.length > 65536)
      throw new DecisionError("provider_malformed_output");
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new DecisionError("provider_malformed_output");
    }
    if (!data || typeof data !== "object")
      throw new DecisionError("provider_malformed_output");
    const choice = data.choices?.[0],
      message = choice?.message;
    if (data.usage)
      metric.usage = Object.fromEntries(
        ["prompt_tokens", "completion_tokens", "total_tokens", "reasoning_tokens"]
          .filter(
            (k) =>
              Number.isSafeInteger(data.usage[k]) && data.usage[k] >= 0,
          )
          .map((k) => [k, data.usage[k]]),
      );
    if (message?.refusal || choice?.finish_reason === "content_filter")
      throw new DecisionError("provider_refused");
    metric.finishReason = choice?.finish_reason ?? null;
    if (choice?.finish_reason === "length")
      throw new DecisionError("provider_truncated_output");
    if (choice?.finish_reason !== "stop")
      throw new DecisionError("provider_malformed_output");
    let value: any;
    try {
      value = JSON.parse(message?.content);
    } catch {
      metric.validationFailure = "json";
      throw new DecisionError("provider_malformed_output");
    }
    // Some schema-constrained refusals arrive as task text instead of message.refusal.
    if (
      stage === "coordinator" &&
      Array.isArray(value?.tasks) &&
      value.tasks.some(
        (task: any) =>
          typeof task?.objective === "string" &&
          /^(declined|refused|rejected)[.!]?$/i.test(task.objective.trim()),
      )
    )
      throw new DecisionError("provider_refused");
    if (!validate(value))
      throw new DecisionError("provider_malformed_output");
    metric.status = "completed";
    return value;
  } catch (error) {
    const code = signal.aborted
      ? decisionError(error, signal)
      : requestSignal?.aborted
        ? "provider_timeout"
        : error instanceof DecisionError
          ? error.message
          : "provider_transport_error";
    metric.status = "failed";
    metric.error = code;
    throw new DecisionError(code);
  } finally {
    metric.latencyMs = Date.now() - began;
    metric.inferenceMs = metric.requestAt ? Date.now() - metric.requestAt : 0;
    release?.();
    await progress();
  }
}
