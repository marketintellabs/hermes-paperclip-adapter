import { createSubIssueTool } from "./create-sub-issue.js";
import { createSubIssuesTool } from "./create-sub-issues.js";
import { getIssueTool } from "./get-issue.js";
import { listMyIssuesTool } from "./list-my-issues.js";
import { postIssueCommentTool } from "./post-issue-comment.js";
import { postIssueInteractionTool } from "./post-issue-interaction.js";
import { updateIssueStatusTool } from "./update-issue-status.js";

export {
  createSubIssueTool,
  createSubIssuesTool,
  getIssueTool,
  listMyIssuesTool,
  postIssueCommentTool,
  postIssueInteractionTool,
  updateIssueStatusTool,
};

/**
 * The full set of tools registered by the paperclip-mcp server on boot.
 *
 * Keep this list intentionally small. The design principle is: every
 * tool exists because a concrete curl-in-prompt pattern from the v2/v3
 * template has been retired in its favor. When we add a new tool we
 * should also delete the corresponding curl example from the prompt.
 *
 * post_issue_interaction is in the registry but NOT in any agent's
 * default allowlist (0.8.21-mil.0). Agents only get it when their
 * `paperclipMcpTools` adapter config includes the name explicitly —
 * see the LinkedIn Strategist single-agent pilot for the canonical
 * usage. Pilot success (1 week clean) is the gate for advancing it
 * onto the fleet allowlist in 0.9.0-mil.0.
 *
 * Deliberately NOT included:
 *   - delete_issue / assign_to_self / read_s3_object: high blast-radius
 *     or wider surface. Revisit after v3 rollout soak.
 */
export const ALL_TOOLS = [
  listMyIssuesTool,
  getIssueTool,
  postIssueCommentTool,
  postIssueInteractionTool,
  createSubIssueTool,
  createSubIssuesTool,
  updateIssueStatusTool,
] as const;
