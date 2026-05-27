/**
 * Single source of truth for the API base path used by the UI.
 *
 * Standalone Paperclip: defaults to `/api` (server lives at the same
 * origin as the UI). Embedded under Infrakaihatsu at
 * `/admin/paperclip/`: set `VITE_API_BASE=/admin/paperclip/api` at
 * build time so REST + WebSocket calls go through the admin-domain
 * reverse-proxy instead of hitting the host origin's `/api/*` — which
 * in Infrakaihatsu's case is a *different* backend (FastAPI) that
 * would either 404 or return unrelated payloads.
 *
 * Used by:
 *   - REST: `api/client.ts`, `api/auth.ts`, `api/health.ts`,
 *     `adapters/dynamic-loader.ts`, `adapters/schema-config-fields.tsx`,
 *     `plugins/bridge.ts`, `components/NewAgentDialog.tsx`
 *   - HTML form `action`: `pages/Auth.tsx`, `pages/InviteLanding.tsx`
 *   - WebSocket paths: `context/LiveUpdatesProvider.tsx`,
 *     `components/transcript/useLiveRunTranscripts.ts`,
 *     `pages/AgentDetail.tsx`
 *
 * Pair with `PAPERCLIP_EMBED_BASE` in `vite.config.ts` (controls the
 * Vite `base` HTML/asset prefix). They must move together — see
 * Infrakaihatsu's `.workflow/WAVE7_PR6_PAPERCLIP_PREFIX_NOTES.md`.
 */

function normalizeApiBase(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return "/api";
  // Strip trailing slash so apiPath() can append a leading-slash path
  // without producing "/admin/paperclip/api//foo".
  const withoutTrailing = trimmed.replace(/\/+$/, "");
  // Force leading slash so an operator who sets `VITE_API_BASE=api`
  // does not produce relative URLs that resolve against the current
  // route (which is route-state-dependent and brittle).
  return withoutTrailing.startsWith("/") ? withoutTrailing : `/${withoutTrailing}`;
}

export const API_BASE: string = normalizeApiBase(
  import.meta.env.VITE_API_BASE as string | undefined,
);

/**
 * Compose an API-prefixed path. `apiPath("/foo")` →
 * `"/api/foo"` standalone, `"/admin/paperclip/api/foo"` embedded.
 *
 * Leading slash is normalized — `apiPath("foo")` works too.
 */
export function apiPath(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE}${normalized}`;
}
