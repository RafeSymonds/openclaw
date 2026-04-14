import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logDebug: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  logDebug: mocks.logDebug,
  logError: mocks.logError,
}));

let toToolDefinitions: typeof import("./pi-tool-definition-adapter.js").toToolDefinitions;
let wrapToolParamValidation: typeof import("./pi-tools.params.js").wrapToolParamValidation;
let REQUIRED_PARAM_GROUPS: typeof import("./pi-tools.params.js").REQUIRED_PARAM_GROUPS;
let logError: typeof import("../logger.js").logError;

type ToolExecute = ReturnType<
  typeof import("./pi-tool-definition-adapter.js").toToolDefinitions
>[number]["execute"];
const extensionContext = {} as Parameters<ToolExecute>[4];

describe("pi tool definition adapter logging", () => {
  beforeAll(async () => {
    ({ toToolDefinitions } = await import("./pi-tool-definition-adapter.js"));
    ({ wrapToolParamValidation, REQUIRED_PARAM_GROUPS } = await import("./pi-tools.params.js"));
    ({ logError } = await import("../logger.js"));
  });

  beforeEach(() => {
    vi.mocked(logError).mockReset();
    mocks.logDebug.mockReset();
  });

  it("logs raw malformed edit params when required aliases are missing", async () => {
    const baseTool = {
      name: "edit",
      label: "Edit",
      description: "edits files",
      parameters: Type.Object({
        path: Type.String(),
        edits: Type.Array(
          Type.Object({
            oldText: Type.String(),
            newText: Type.String(),
          }),
        ),
      }),
      execute: async () => ({
        content: [{ type: "text" as const, text: "ok" }],
        details: { ok: true },
      }),
    } satisfies AgentTool;

    const tool = wrapToolParamValidation(baseTool, REQUIRED_PARAM_GROUPS.edit);
    const [def] = toToolDefinitions([tool]);
    if (!def) {
      throw new Error("missing tool definition");
    }

    await def.execute("call-edit-1", { path: "notes.txt" }, undefined, undefined, extensionContext);

    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining(
        '[tools] edit failed: Missing required parameter: edits (received: path). Supply correct parameters before retrying. raw_params={"path":"notes.txt"}',
      ),
    );
  });

  it("converts internal AbortError to tool_result when parent signal isn't aborted", async () => {
    const abortError = Object.assign(new Error("Request was aborted"), { name: "AbortError" });
    const baseTool = {
      name: "image",
      label: "Image",
      description: "vision tool",
      parameters: Type.Object({ image: Type.String() }),
      execute: async () => {
        throw abortError;
      },
    } satisfies AgentTool;

    const [def] = toToolDefinitions([baseTool]);
    if (!def) {
      throw new Error("missing tool definition");
    }

    const controller = new AbortController();
    const result = (await def.execute(
      "call-image-1",
      { image: "a.png" },
      controller.signal,
      undefined,
      extensionContext,
    )) as { content: Array<{ type: string; text: string }> };

    expect(controller.signal.aborted).toBe(false);
    expect(result.content?.[0]?.text).toContain("Request was aborted");
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining("[tools] image failed: Request was aborted"),
    );
  });

  it("rethrows run-level aborts wrapped by wrapToolWithAbortSignal (pre-execute)", async () => {
    const { wrapToolWithAbortSignal } = await import("./pi-tools.abort.js");
    const baseTool = {
      name: "image",
      label: "Image",
      description: "vision tool",
      parameters: Type.Object({ image: Type.String() }),
      execute: vi.fn(async () => ({
        content: [{ type: "text" as const, text: "ok" }],
        details: { ok: true },
      })),
    } satisfies AgentTool;

    const runController = new AbortController();
    runController.abort();
    const wrapped = wrapToolWithAbortSignal(baseTool, runController.signal);
    const [def] = toToolDefinitions([wrapped]);
    if (!def) {
      throw new Error("missing tool definition");
    }

    await expect(
      def.execute("call-image-run-1", { image: "a.png" }, undefined, undefined, extensionContext),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(baseTool.execute).not.toHaveBeenCalled();
  });

  it("rethrows run-level aborts that trip during tool execution", async () => {
    const { wrapToolWithAbortSignal } = await import("./pi-tools.abort.js");
    const runController = new AbortController();
    const baseTool = {
      name: "image",
      label: "Image",
      description: "vision tool",
      parameters: Type.Object({ image: Type.String() }),
      execute: async () => {
        runController.abort();
        const err = Object.assign(new Error("Request was aborted"), { name: "AbortError" });
        throw err;
      },
    } satisfies AgentTool;

    const wrapped = wrapToolWithAbortSignal(baseTool, runController.signal);
    const [def] = toToolDefinitions([wrapped]);
    if (!def) {
      throw new Error("missing tool definition");
    }

    await expect(
      def.execute("call-image-run-2", { image: "a.png" }, undefined, undefined, extensionContext),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rethrows AbortError when parent signal is aborted", async () => {
    const abortError = Object.assign(new Error("Request was aborted"), { name: "AbortError" });
    const baseTool = {
      name: "image",
      label: "Image",
      description: "vision tool",
      parameters: Type.Object({ image: Type.String() }),
      execute: async () => {
        throw abortError;
      },
    } satisfies AgentTool;

    const [def] = toToolDefinitions([baseTool]);
    if (!def) {
      throw new Error("missing tool definition");
    }

    const controller = new AbortController();
    controller.abort();
    await expect(
      def.execute(
        "call-image-2",
        { image: "a.png" },
        controller.signal,
        undefined,
        extensionContext,
      ),
    ).rejects.toBe(abortError);
  });

  it("accepts nested edits arrays for the current edit schema", async () => {
    const execute = vi.fn(async (_toolCallId: string, params: unknown) => ({
      content: [{ type: "text" as const, text: JSON.stringify(params) }],
      details: { ok: true },
    }));
    const baseTool = {
      name: "edit",
      label: "Edit",
      description: "edits files",
      parameters: Type.Object({
        path: Type.String(),
        edits: Type.Array(
          Type.Object({
            oldText: Type.String(),
            newText: Type.String(),
          }),
        ),
      }),
      execute,
    } satisfies AgentTool;

    const tool = wrapToolParamValidation(baseTool, REQUIRED_PARAM_GROUPS.edit);
    const [def] = toToolDefinitions([tool]);
    if (!def) {
      throw new Error("missing tool definition");
    }

    const payload = {
      path: "notes.txt",
      edits: [
        { oldText: "alpha", newText: "beta" },
        { oldText: "gamma", newText: "" },
      ],
    };

    await def.execute("call-edit-batch", payload, undefined, undefined, extensionContext);

    expect(execute).toHaveBeenCalledWith("call-edit-batch", payload, undefined, undefined);
    expect(logError).not.toHaveBeenCalled();
  });
});
