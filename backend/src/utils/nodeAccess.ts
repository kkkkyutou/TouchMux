import type { NodeConfigEntry, NodeSummary } from "../types/models.js";

function trimTrailingSlash(value: string): string {
  return value.replace(/\/$/, "");
}

export function deriveWebSocketBaseUrl(httpBaseUrl: string): string | null {
  try {
    const url = new URL(httpBaseUrl);
    if (url.protocol === "http:") {
      url.protocol = "ws:";
    } else if (url.protocol === "https:") {
      url.protocol = "wss:";
    } else {
      return null;
    }
    return trimTrailingSlash(url.toString());
  } catch {
    return null;
  }
}

export function resolveNodeDirectAccess(entry: Pick<NodeConfigEntry, "publicBaseUrl" | "publicWsBaseUrl">): Pick<
  NodeSummary,
  "directHttpBaseUrl" | "directWsBaseUrl" | "directAccessReady"
> {
  const directHttpBaseUrl = entry.publicBaseUrl?.trim() ? trimTrailingSlash(entry.publicBaseUrl) : null;
  const directWsBaseUrl = entry.publicWsBaseUrl?.trim()
    ? trimTrailingSlash(entry.publicWsBaseUrl)
    : directHttpBaseUrl
      ? deriveWebSocketBaseUrl(directHttpBaseUrl)
      : null;
  return {
    directHttpBaseUrl,
    directWsBaseUrl,
    directAccessReady: Boolean(directHttpBaseUrl && directWsBaseUrl),
  };
}
