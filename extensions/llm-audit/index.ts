import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { auditProviderBoundaryEvent, auditSessionEvent } from "../_shared/llm-audit";

export default function (pi: ExtensionAPI): void {
  const projectRoot = process.cwd();
  const sessionMeta = {
    module: "llm-audit",
    operation: "session_event",
    session_scope: "main_or_extension_visible",
  };

  for (const eventName of ["message_start", "message_update", "message_end", "agent_end"] as const) {
    pi.on(eventName as any, async (event: unknown) => {
      await auditSessionEvent(projectRoot, sessionMeta, event);
    });
  }

  pi.on("before_provider_request" as any, (event: unknown, ctx: unknown) => {
    void auditProviderBoundaryEvent(projectRoot, {
      module: "llm-audit",
      operation: "provider_request",
      session_scope: "main_or_extension_visible",
    }, event, ctx);
  });

  pi.on("after_provider_response" as any, (event: unknown, ctx: unknown) => {
    void auditProviderBoundaryEvent(projectRoot, {
      module: "llm-audit",
      operation: "provider_response",
      session_scope: "main_or_extension_visible",
    }, event, ctx);
  });
}
