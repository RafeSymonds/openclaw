import { copyPluginToolMeta } from "../plugins/tools.js";
import { bindAbortRelay } from "../utils/fetch-timeout.js";
import { copyChannelAgentToolMeta } from "./channel-tools.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

export const RUN_ABORT_MARKER = "__openclawRunAbort";

export function markRunAbortError(err: unknown): void {
  if (err && typeof err === "object") {
    (err as Record<string, unknown>)[RUN_ABORT_MARKER] = true;
  }
}

export function isRunAbortError(err: unknown): boolean {
  return Boolean(
    err && typeof err === "object" && (err as Record<string, unknown>)[RUN_ABORT_MARKER] === true,
  );
}

function throwAbortError(): never {
  const err = new Error("Aborted");
  err.name = "AbortError";
  markRunAbortError(err);
  throw err;
}

/**
 * Checks if an object is a valid AbortSignal using structural typing.
 * This is more reliable than `instanceof` across different realms (VM, iframe, etc.)
 * where the AbortSignal constructor may differ.
 */
function isAbortSignal(obj: unknown): obj is AbortSignal {
  return obj instanceof AbortSignal;
}

function combineAbortSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (!a && !b) {
    return undefined;
  }
  if (a && !b) {
    return a;
  }
  if (b && !a) {
    return b;
  }
  if (a?.aborted) {
    return a;
  }
  if (b?.aborted) {
    return b;
  }
  if (typeof AbortSignal.any === "function" && isAbortSignal(a) && isAbortSignal(b)) {
    return AbortSignal.any([a, b]);
  }

  const controller = new AbortController();
  const onAbort = bindAbortRelay(controller);
  a?.addEventListener("abort", onAbort, { once: true });
  b?.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
}

export function wrapToolWithAbortSignal(
  tool: AnyAgentTool,
  abortSignal?: AbortSignal,
): AnyAgentTool {
  if (!abortSignal) {
    return tool;
  }
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }
  const wrappedTool: AnyAgentTool = {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const combined = combineAbortSignals(signal, abortSignal);
      if (combined?.aborted) {
        throwAbortError();
      }
      try {
        return await execute(toolCallId, params, combined, onUpdate);
      } catch (err) {
        // If the run-level signal tripped during execution (e.g. fetch was
        // canceled via the combined signal), tag the error so the tool
        // definition adapter rethrows it to terminate the turn instead of
        // converting it into a tool_result.
        if (abortSignal.aborted && !signal?.aborted) {
          markRunAbortError(err);
        }
        throw err;
      }
    },
  };
  copyPluginToolMeta(tool, wrappedTool);
  copyChannelAgentToolMeta(tool as never, wrappedTool as never);
  return wrappedTool;
}
