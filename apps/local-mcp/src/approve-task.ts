#!/usr/bin/env node
// Human-operated local CLI. Not callable from an MCP tool.
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createTaskInput } from "../../../packages/google-tasks/src/index.js";
import { issueLocalApproval } from "./approvals.js";
const flags = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1];
  if (!key?.startsWith("--") || value === undefined) {
    throw new Error("Expected --tasklist, --title, optional --notes, --date pairs");
  }
  flags.set(key, value);
}
const input = createTaskInput.parse({
  tasklistId: flags.get("--tasklist"),
  title: flags.get("--title"),
  ...(flags.has("--notes") ? { notes: flags.get("--notes") } : {}),
  ...(flags.has("--date") ? { scheduledDate: flags.get("--date") } : {})
});
const accountId = process.env.GMW_GOOGLE_ACCOUNT || "default";
const action = { clientId: "local_dev", accountId,
  operation: "tasks_create_task", input };
const prompt = createInterface({ input: stdin, output: stdout });
try {
  stdout.write("Approve ONE Google Task creation for account " + accountId +
    ", list " + input.tasklistId + ", title " + JSON.stringify(input.title) +
    ", notes " + JSON.stringify(input.notes) +
    ", scheduled day " + (input.scheduledDate || "none") +
    "? Type APPROVE: ");
  const confirmation = await prompt.question("");
  if (confirmation !== "APPROVE") process.exitCode = 1;
  else {
    const result = await issueLocalApproval(action);
    stdout.write("One-use local approval expires " +
      new Date(result.expiresAt).toISOString() + ".\n");
  }
} finally { prompt.close(); }
