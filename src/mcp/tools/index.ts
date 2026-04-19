import { createSubIssueTool } from "./create-sub-issue.js";
import { getIssueTool } from "./get-issue.js";
import { listMyIssuesTool } from "./list-my-issues.js";
import { postIssueCommentTool } from "./post-issue-comment.js";

export { createSubIssueTool, getIssueTool, listMyIssuesTool, postIssueCommentTool };

/**
 * The full set of tools registered by the paperclip-mcp server on boot.
 *
 * Keep this list intentionally small. The design principle is: every
 * tool exists because a concrete curl-in-prompt pattern from the v2
 * template has been retired in its favor. When we add a new tool we
 * should also delete the corresponding curl example from the prompt.
 *
 * Deliberately NOT included:
 *   - update_issue_status: adapter owns terminal status via RESULT: marker.
 *   - delete_issue / assign_to_self: high blast-radius; revisit after soak.
 */
export const ALL_TOOLS = [
  listMyIssuesTool,
  getIssueTool,
  postIssueCommentTool,
  createSubIssueTool,
] as const;
