// Private local-development approvals. Cloud deployment will require its own
// authenticated, durable, independent approval service (NOT filesystem grants).
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink, writeFile, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { OperationError, type ApprovalAction, type ApprovalGate } from "../../../packages/core/src/index.js";

const privateDirectory = () => join(homedir(), ".config", "google-master-worker", "approvals");
const fingerprint = (action: ApprovalAction) =>
  createHash("sha256").update(JSON.stringify(action)).digest("hex");
const pathFor = (directory: string, action: ApprovalAction) =>
  join(directory, fingerprint(action) + ".json");

async function ensurePrivate(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0) {
    throw new OperationError("APPROVAL_DIRECTORY_NOT_PRIVATE");
  }
}

export async function issueLocalApproval(
  action: ApprovalAction,
  options: { directory?: string; now?: number } = {}
): Promise<{ fingerprint: string; expiresAt: number }> {
  const directory = options.directory ?? privateDirectory();
  const now = options.now ?? Date.now();
  await ensurePrivate(directory);
  const record = { version: 1, action, issuedAt: now, expiresAt: now + 120000 };
  const path = pathFor(directory, action);
  try {
    await writeFile(path, JSON.stringify(record), { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let previous: unknown;
    try {
      const info = await handle.stat();
      if (!info.isFile() || (info.mode & 0o077) !== 0) {
        throw new OperationError("WRITE_APPROVAL_INVALID");
      }
      previous = JSON.parse(await handle.readFile({ encoding: "utf8" }));
    } finally { await handle.close(); }
    const old = previous as Record<string, unknown>;
    if (old.version !== 1 || JSON.stringify(old.action) !== JSON.stringify(action) ||
        typeof old.expiresAt !== "number") throw new OperationError("WRITE_APPROVAL_INVALID");
    if (old.expiresAt > now) throw new OperationError("WRITE_APPROVAL_ALREADY_ACTIVE");
    const renamed = path + ".expired-" + randomUUID();
    await rename(path, renamed);
    try {
      await writeFile(path, JSON.stringify(record), { encoding: "utf8", mode: 0o600, flag: "wx" });
    } finally {
      await unlink(renamed).catch(() => {});
    }
  }
  return { fingerprint: fingerprint(action), expiresAt: record.expiresAt };
}

export function createFileApprovalGate(options: {
  directory?: string; now?: () => number
} = {}): ApprovalGate {
  const directory = options.directory ?? privateDirectory();
  const now = options.now ?? (() => Date.now());
  return {
    async consume(action: ApprovalAction) {
      const path = pathFor(directory, action);
      const claimed = path + ".used-" + randomUUID();
      try { await rename(path, claimed); }
      catch { throw new OperationError("WRITE_APPROVAL_REQUIRED"); }
      try {
        const file = await open(claimed, constants.O_RDONLY | constants.O_NOFOLLOW);
        let record: Record<string, unknown>;
        try {
          const stat = await file.stat();
          if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
            throw new OperationError("WRITE_APPROVAL_INVALID");
          }
          record = JSON.parse(await file.readFile({ encoding: "utf8" })) as Record<string, unknown>;
        } finally { await file.close(); }
        const t = now();
        if (record.version !== 1 || typeof record.issuedAt !== "number" ||
            typeof record.expiresAt !== "number" || record.issuedAt > t ||
            record.expiresAt <= t || record.expiresAt - record.issuedAt > 120000 ||
            JSON.stringify(record.action) !== JSON.stringify(action)) {
          throw new OperationError("WRITE_APPROVAL_EXPIRED_OR_MISMATCHED");
        }
      } finally { await unlink(claimed).catch(() => {}); }
    }
  };
}
