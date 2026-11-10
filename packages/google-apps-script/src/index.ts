import * as z from "zod/v4";
import { defineOperation, OperationRegistry, OperationError } from "../../core/src/index.js";
import { GoogleJsonClient } from "../../google-http/src/index.js";

export const SCRIPT_READ = "https://www.googleapis.com/auth/script.projects.readonly";
export const SCRIPT_WRITE = "https://www.googleapis.com/auth/script.projects";

const scriptId = z.string().min(1).max(512)
  .refine(value => !/[\u0000-\u001f]/.test(value) && value !== "." && value !== "..");
const simpleName = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const idPath = (value: string) => encodeURIComponent(value);
const commonId = z.object({ scriptId }).strict();
const bounded = z.number().int().min(1).max(100).default(20);
const inputProject = z.object({ scriptId }).strict();
const outputProject = z.object({
  scriptId: z.string(), title: z.string(), parentId: z.string().nullable(),
  createTime: z.string(), updateTime: z.string()
}).strict();
const contentInput = z.object({ scriptId, versionNumber: z.number().int().positive().optional() }).strict();
const sourceFile = z.object({
  name: z.string(), type: z.enum(["SERVER_JS", "HTML", "JSON"]), source: z.string()
}).strict();
const contentOutput = z.object({
  scriptId: z.string(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.array(sourceFile)
}).strict();
const createProjectInput = z.object({
  title: z.string().trim().min(1).max(256),
  parentId: scriptId.optional()
}).strict();
const createProjectOutput = z.object({ scriptId: z.string(), title: z.string(), created: z.literal(true) }).strict();
const sourceChange = z.object({
  name: simpleName, type: z.enum(["SERVER_JS", "HTML"]),
  source: z.string().min(1).max(64000)
}).strict();
const updateSourceInput = z.object({
  scriptId, expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  changes: z.array(sourceChange).min(1).max(6)
}).strict();
const updateSourceOutput = z.object({
  scriptId: z.string(), changed: z.array(z.string()),
  fingerprint: z.string(), verified: z.literal(true)
}).strict();
const versionListInput = z.object({ scriptId, pageSize: bounded, pageToken: z.string().max(1024).optional() }).strict();
const version = z.object({ versionNumber: z.number().int(), description: z.string(), createTime: z.string() }).strict();
const versionListOutput = z.object({ scriptId: z.string(), versions: z.array(version),
  nextPageToken: z.string().nullable() }).strict();
const createVersionInput = z.object({ scriptId, description: z.string().max(1024).default("") }).strict();
const createVersionOutput = z.object({ scriptId: z.string(), versionNumber: z.number().int(),
  description: z.string(), created: z.literal(true) }).strict();
const deploymentListInput = versionListInput;
const deploymentListOutput = z.object({ scriptId: z.string(),
  deployments: z.array(z.object({
    deploymentId: z.string(), description: z.string(), updateTime: z.string()
  }).strict()), nextPageToken: z.string().nullable() }).strict();

type ScriptFile = z.infer<typeof sourceFile>;
const text = (value: unknown, limit = 1024): string =>
  typeof value === "string" ? value.slice(0, limit) : "";
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
const safeArray = (value: unknown, limit: number): Record<string, unknown>[] =>
  (Array.isArray(value) ? value : []).slice(0, limit).map(object);
const nextPage = (raw: Record<string, unknown>) => text(raw.nextPageToken, 1024) || null;

/** Canonical digest over script file NAME + TYPE + SOURCE, excluding mutable provider metadata. */
export async function fingerprintContent(files: readonly ScriptFile[]): Promise<string> {
  const stable = [...files].sort((a, b) => a.name.localeCompare(b.name))
    .map(file => [file.name, file.type, file.source]);
  const digest = await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(JSON.stringify(stable)));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

function getFiles(data: Record<string, unknown>): ScriptFile[] {
  if (!Array.isArray(data.files) || data.files.length > 30) {
    throw new OperationError("GOOGLE_RESPONSE_INVALID");
  }
  const result: ScriptFile[] = [];
  const names = new Set<string>();
  for (const raw of data.files) {
    const f = object(raw);
    const parsed = sourceFile.safeParse({
      name: f.name, type: f.type, source: f.source
    });
    if (!parsed.success || parsed.data.name.length > 128 ||
        parsed.data.source.length > 128000 || names.has(parsed.data.name)) {
      throw new OperationError("GOOGLE_RESPONSE_INVALID");
    }
    result.push(parsed.data);
    names.add(parsed.data.name);
  }
  // Apps Script must have a JSON manifest, and updateContent overwrites ALL files.
  if (!result.some(file => file.name === "appsscript" && file.type === "JSON")) {
    throw new OperationError("GOOGLE_MANIFEST_MISSING");
  }
  return result;
}

export function registerAppsScript(
  registry: OperationRegistry,
  client: GoogleJsonClient = new GoogleJsonClient("https://script.googleapis.com", "/v1/")
): void {
  async function readFiles(id: string, accessToken: string, versionNumber?: number) {
    const response = await client.json({
      path: "/v1/projects/" + idPath(id) + "/content",
      accessToken, query: { versionNumber }
    });
    const files = getFiles(response);
    return { files, fingerprint: await fingerprintContent(files) };
  }

  registry.register(defineOperation({
    name: "script_get_project",
    description: "Read Apps Script project metadata by known script ID; discovery is not provided by the Apps Script API.",
    inputSchema: inputProject, outputSchema: outputProject,
    scopesAnyOf: [SCRIPT_READ, SCRIPT_WRITE], risk: "read",
    async run(input, { session }) {
      const data = await client.json({
        path: "/v1/projects/" + idPath(input.scriptId), accessToken: session.accessToken
      });
      return { scriptId: text(data.scriptId, 512), title: text(data.title, 256),
        parentId: text(data.parentId, 512) || null,
        createTime: text(data.createTime, 64), updateTime: text(data.updateTime, 64) };
    }
  }));

  registry.register(defineOperation({
    name: "script_get_content",
    description: "Read full Apps Script project files and SHA-256 snapshot fingerprint for safe subsequent edits.",
    inputSchema: contentInput, outputSchema: contentOutput,
    scopesAnyOf: [SCRIPT_READ, SCRIPT_WRITE], risk: "read",
    async run(input, { session }) {
      const content = await readFiles(input.scriptId, session.accessToken, input.versionNumber);
      return { scriptId: input.scriptId, ...content };
    }
  }));

  registry.register(defineOperation({
    name: "script_create_project",
    description: "Create a standalone or bound Apps Script project after independently approved write.",
    inputSchema: createProjectInput, outputSchema: createProjectOutput,
    scopesAnyOf: [SCRIPT_WRITE], risk: "write",
    async run(input, { session }) {
      const body = { title: input.title, ...(input.parentId ? { parentId: input.parentId } : {}) };
      const data = await client.json({ path: "/v1/projects", method: "POST",
        accessToken: session.accessToken, body });
      return { scriptId: text(data.scriptId, 512), title: text(data.title, 256), created: true as const };
    }
  }));

  registry.register(defineOperation({
    name: "script_update_sources",
    description: "Guarded Apps Script source upsert. Requires prior fingerprint and independent exact-action approval; preserves all untouched files and manifest.",
    inputSchema: updateSourceInput, outputSchema: updateSourceOutput,
    scopesAnyOf: [SCRIPT_WRITE], risk: "destructive",
    async run(input, { session }) {
      const before = await readFiles(input.scriptId, session.accessToken);
      if (before.fingerprint !== input.expectedFingerprint) {
        throw new OperationError("CONTENT_CHANGED_REVIEW_REQUIRED");
      }
      const changes = new Set<string>();
      const byName = new Map(before.files.map(file => [file.name, { ...file }]));
      for (const change of input.changes) {
        if (change.name === "appsscript" || changes.has(change.name)) {
          throw new OperationError("INVALID_SOURCE_CHANGE");
        }
        changes.add(change.name);
        const old = byName.get(change.name);
        if (old && old.type !== change.type) {
          throw new OperationError("INVALID_SOURCE_CHANGE");
        }
        byName.set(change.name, change);
      }
      const files = Array.from(byName.values());
      const sentBytes = new TextEncoder().encode(JSON.stringify({ files })).byteLength;
      if (sentBytes > 200000) throw new OperationError("GOOGLE_REQUEST_TOO_LARGE");
      const expectedNew = await fingerprintContent(files);
      await client.json({
        path: "/v1/projects/" + idPath(input.scriptId) + "/content",
        method: "PUT", accessToken: session.accessToken, body: { files }
      });
      // The API has no atomic compare-and-swap precondition. Re-read for best-effort
      // verification; another writer may race between this read and the PUT.
      const after = await readFiles(input.scriptId, session.accessToken);
      if (after.fingerprint !== expectedNew) {
        throw new OperationError("CONTENT_WRITE_UNVERIFIED");
      }
      return { scriptId: input.scriptId, changed: Array.from(changes),
        fingerprint: after.fingerprint, verified: true as const };
    }
  }));

  registry.register(defineOperation({
    name: "script_list_versions",
    description: "Read a bounded page of immutable Apps Script project versions.",
    inputSchema: versionListInput, outputSchema: versionListOutput,
    scopesAnyOf: [SCRIPT_READ, SCRIPT_WRITE], risk: "read",
    async run(input, { session }) {
      const data = await client.json({
        path: "/v1/projects/" + idPath(input.scriptId) + "/versions",
        accessToken: session.accessToken,
        query: { pageSize: input.pageSize, pageToken: input.pageToken }
      });
      return { scriptId: input.scriptId, versions: safeArray(data.versions, input.pageSize)
        .map(v => ({ versionNumber: Number(v.versionNumber) || 0,
          description: text(v.description, 1024), createTime: text(v.createTime, 64) })),
        nextPageToken: nextPage(data) };
    }
  }));

  registry.register(defineOperation({
    name: "script_create_version",
    description: "Create a new immutable Apps Script source version after independent approval; does not deploy.",
    inputSchema: createVersionInput, outputSchema: createVersionOutput,
    scopesAnyOf: [SCRIPT_WRITE], risk: "write",
    async run(input, { session }) {
      const data = await client.json({
        path: "/v1/projects/" + idPath(input.scriptId) + "/versions",
        accessToken: session.accessToken, method: "POST",
        body: { description: input.description }
      });
      return { scriptId: input.scriptId, versionNumber: Number(data.versionNumber) || 0,
        description: text(data.description, 1024), created: true as const };
    }
  }));

  registry.register(defineOperation({
    name: "script_list_deployments",
    description: "Read one bounded page of Apps Script deployments. Does not deploy or execute code.",
    inputSchema: deploymentListInput, outputSchema: deploymentListOutput,
    scopesAnyOf: [SCRIPT_READ, SCRIPT_WRITE], risk: "read",
    async run(input, { session }) {
      const data = await client.json({
        path: "/v1/projects/" + idPath(input.scriptId) + "/deployments",
        accessToken: session.accessToken, query: { pageSize: input.pageSize, pageToken: input.pageToken }
      });
      return { scriptId: input.scriptId, deployments: safeArray(data.deployments, input.pageSize)
        .map(d => ({ deploymentId: text(d.deploymentId, 512),
          description: text(object(d.deploymentConfig).description, 1024),
          updateTime: text(d.updateTime, 64) })),
        nextPageToken: nextPage(data) };
    }
  }));
}
