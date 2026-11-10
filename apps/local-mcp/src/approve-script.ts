#!/usr/bin/env node
// Human-issued, independent approval for one narrowly described Apps Script write.
// Never expose as an MCP tool or HTTP route.
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { issueLocalApproval } from "./approvals.js";
import * as z from "zod/v4";

const params = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1];
  if (!key?.startsWith("--") || value === undefined) {
    throw new Error("Use --action create|version|update with action-specific arguments.");
  }
  params.set(key, value);
}
const actionName = params.get("--action");
let operation = "";
let input: unknown;
const resource = z.string().min(1).max(512);
switch (actionName) {
  case "create":
    operation = "script_create_project";
    input = z.object({
      title: z.string().trim().min(1).max(256),
      parentId: resource.optional()
    }).strict().parse({
      title: params.get("--title"),
      ...(params.has("--parent") ? { parentId: params.get("--parent") } : {})
    });
    break;
  case "version":
    operation = "script_create_version";
    input = z.object({
      scriptId: resource, description: z.string().max(1024).default("")
    }).strict().parse({
      scriptId: params.get("--id"), description: params.get("--description") || ""
    });
    break;
  case "update": {
    operation = "script_update_sources";
    const filepath = params.get("--source-file");
    if (!filepath) throw new Error("Missing --source-file (local JS/HTML source file)");
    const source = await readFile(filepath, { encoding: "utf8" });
    input = z.object({
      scriptId: resource,
      expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      changes: z.array(z.object({
        name: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
        type: z.enum(["SERVER_JS", "HTML"]),
        source: z.string().min(1).max(64000)
      }).strict()).min(1).max(6)
    }).strict().parse({
      scriptId: params.get("--id"),
      expectedFingerprint: params.get("--expected"),
      changes: [{
        name: params.get("--name"), type: params.get("--type") || "SERVER_JS", source
      }]
    });
    break;
  }
  default:
    throw new Error("Unknown --action. Choose create, version, or update.");
}
const accountId = process.env.GMW_GOOGLE_ACCOUNT || "default";
const grant = { clientId: "local_dev", accountId, operation, input };
const io = createInterface({ input: stdin, output: stdout });
try {
  stdout.write("Review exact Google Apps Script write action:\n" +
    JSON.stringify({ accountId, operation, input }, null, 2).slice(0, 100000) +
    "\nType APPROVE to authorize this one action for 2 minutes: ");
  const answer = await io.question("");
  if (answer !== "APPROVE") process.exitCode = 1;
  else {
    const result = await issueLocalApproval(grant);
    stdout.write("One-use local approval expires " +
      new Date(result.expiresAt).toISOString() + ".\n");
  }
} finally { io.close(); }
