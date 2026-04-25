/**
 * Canonical adapter version.
 *
 * Referenced by both the MCP server's connection banner
 * (`[paperclip-mcp] server paperclip@<version> connected …`) and the
 * adapter's `resultJson.adapterVersion` field, so every heartbeat run in
 * Paperclip records which version of the adapter produced it.
 *
 * Keep in sync with `package.json` on every release. The release workflow
 * checks this at publish time (see `.github/workflows/release.yml`).
 */
export const ADAPTER_VERSION = "0.8.10-mil.0";
