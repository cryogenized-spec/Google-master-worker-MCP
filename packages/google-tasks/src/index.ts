import * as z from "zod/v4";
import { defineOperation, OperationRegistry } from "../../core/src/index.js";
import { GoogleJsonClient } from "../../google-http/src/index.js";

export const TASKS_READ = "https://www.googleapis.com/auth/tasks.readonly";
export const TASKS_WRITE = "https://www.googleapis.com/auth/tasks";

const resourceId = z.string().min(1).max(512)
  .refine(value => !/[\u0000-\u001f]/.test(value) && value !== "." && value !== "..");
const pageToken = z.string().max(1024).optional();
const maxResults = z.number().int().min(1).max(100).default(25);
const task = z.object({
  id: z.string(), title: z.string(), notes: z.string(),
  status: z.enum(["needsAction", "completed"]),
  scheduledDate: z.string().nullable(), updated: z.string(), parent: z.string().nullable()
}).strict();
const taskList = z.object({ id: z.string(), title: z.string(), updated: z.string() }).strict();
const common = { accountId: z.string(), nextPageToken: z.string().nullable(), partial: z.boolean() };

const listTasklistsInput = z.object({ pageToken, maxResults }).strict();
const listTasklistsOutput = z.object({ ...common, items: z.array(taskList) }).strict();
const listTasksInput = z.object({
  tasklistId: resourceId, pageToken, maxResults,
  showCompleted: z.boolean().default(false), showAssigned: z.boolean().default(false)
}).strict();
const listTasksOutput = z.object({
  ...common, tasklistId: z.string(), items: z.array(task), note: z.string()
}).strict();
const getTaskInput = z.object({ tasklistId: resourceId, taskId: resourceId }).strict();
const getTaskOutput = z.object({ accountId: z.string(), tasklistId: z.string(), task }).strict();
export const createTaskInput = z.object({
  tasklistId: resourceId, title: z.string().trim().min(1).max(1024),
  notes: z.string().max(8192).default(""),
  scheduledDate: z.iso.date().optional()
}).strict();
const createTaskOutput = z.object({
  accountId: z.string(), tasklistId: z.string(), created: z.literal(true), task
}).strict();

const small = (value: unknown, limit = 1024): string =>
  typeof value === "string" ? value.slice(0, limit) : "";
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
const dataItems = (data: Record<string, unknown>, limit: number): Record<string, unknown>[] =>
  (Array.isArray(data.items) ? data.items : []).slice(0, limit).map(object);
const taskShape = (raw: unknown) => {
  const value = object(raw);
  return {
    id: small(value.id, 512), title: small(value.title),
    notes: small(value.notes, 8192),
    status: value.status === "completed" ? "completed" as const : "needsAction" as const,
    scheduledDate: typeof value.due === "string" ? value.due.slice(0, 10) : null,
    updated: small(value.updated, 50), parent: small(value.parent, 512) || null
  };
};
const listShape = (raw: unknown) => {
  const value = object(raw);
  return { id: small(value.id, 512), title: small(value.title), updated: small(value.updated, 50) };
};
const nextPage = (data: Record<string, unknown>) => small(data.nextPageToken, 1024) || null;
const idPath = (id: string) => encodeURIComponent(id);

/** Google Tasks does not require the API consumer to discover an unrestricted REST endpoint. */
export function registerGoogleTasks(registry: OperationRegistry, client: GoogleJsonClient =
  new GoogleJsonClient("https://tasks.googleapis.com", "/tasks/v1/")): void {
  registry.register(defineOperation({
    name: "tasks_list_tasklists",
    description: "List one bounded page of Google Tasks lists for the connected account.",
    inputSchema: listTasklistsInput,
    outputSchema: listTasklistsOutput,
    scopesAnyOf: [TASKS_READ, TASKS_WRITE],
    risk: "read",
    async run(input, { session, principal }) {
      const data = await client.json({
        path: "/tasks/v1/users/@me/lists", accessToken: session.accessToken,
        query: { maxResults: input.maxResults, pageToken: input.pageToken }
      });
      return { accountId: principal.accountId,
        items: dataItems(data, input.maxResults).map(listShape),
        nextPageToken: nextPage(data), partial: Boolean(nextPage(data)) };
    }
  }));
  registry.register(defineOperation({
    name: "tasks_list_tasks",
    description: "List one bounded page of Google Tasks. A scheduled day is not necessarily a deadline.",
    inputSchema: listTasksInput,
    outputSchema: listTasksOutput,
    scopesAnyOf: [TASKS_READ, TASKS_WRITE],
    risk: "read",
    async run(input, { session, principal }) {
      const data = await client.json({
        path: "/tasks/v1/lists/" + idPath(input.tasklistId) + "/tasks",
        accessToken: session.accessToken,
        query: { maxResults: input.maxResults, pageToken: input.pageToken,
          showCompleted: input.showCompleted, showAssigned: input.showAssigned,
          showDeleted: false, showHidden: false }
      });
      return { accountId: principal.accountId, tasklistId: input.tasklistId,
        items: dataItems(data, input.maxResults).map(taskShape),
        nextPageToken: nextPage(data), partial: Boolean(nextPage(data)),
        note: "Scheduled dates are not necessarily deadlines. Hidden completed tasks are excluded." };
    }
  }));
  registry.register(defineOperation({
    name: "tasks_get_task",
    description: "Read one Google Task in a selected task list.",
    inputSchema: getTaskInput,
    outputSchema: getTaskOutput,
    scopesAnyOf: [TASKS_READ, TASKS_WRITE],
    risk: "read",
    async run(input, { session, principal }) {
      const data = await client.json({
        path: "/tasks/v1/lists/" + idPath(input.tasklistId) + "/tasks/" + idPath(input.taskId),
        accessToken: session.accessToken
      });
      return { accountId: principal.accountId, tasklistId: input.tasklistId, task: taskShape(data) };
    }
  }));
  registry.register(defineOperation({
    name: "tasks_create_task",
    description: "Create one Google Task only after a trusted, exact-action one-use approval. Date is a scheduled day.",
    inputSchema: createTaskInput,
    outputSchema: createTaskOutput,
    scopesAnyOf: [TASKS_WRITE],
    risk: "write",
    async run(input, { session, principal }) {
      const body: Record<string, string> = { title: input.title };
      if (input.notes) body.notes = input.notes;
      if (input.scheduledDate) body.due = input.scheduledDate + "T00:00:00.000Z";
      const data = await client.json({
        path: "/tasks/v1/lists/" + idPath(input.tasklistId) + "/tasks",
        accessToken: session.accessToken, method: "POST", body
      });
      return { accountId: principal.accountId, tasklistId: input.tasklistId,
        created: true as const, task: taskShape(data) };
    }
  }));
}
