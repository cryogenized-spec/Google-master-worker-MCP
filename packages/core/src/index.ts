import * as z from "zod/v4";

/** Only the gateway creates this context after authenticating the client. */
export interface Principal {
  readonly clientId: string;
  readonly accountId: string;
  readonly authenticated: true;
}

export interface GoogleSession {
  readonly accessToken: string;
  readonly scopes: readonly string[];
  readonly expiresAt: number; // Unix milliseconds
}

export interface SessionStore {
  get(accountId: string, clientId: string): Promise<GoogleSession | null>;
}

export interface ApprovalAction {
  readonly clientId: string;
  readonly accountId: string;
  readonly operation: string;
  readonly input: unknown;
}

export interface ApprovalGate {
  /** Must consume a host-issued, target-bound, short-lived, one-use grant. */
  consume(action: ApprovalAction): Promise<void>;
}

export type OperationRisk = "read" | "prepare" | "write" | "destructive" | "external";
export type OperationContext = {
  readonly principal: Principal;
  readonly session: GoogleSession;
};

export interface Operation<I extends z.ZodTypeAny, O extends z.ZodTypeAny> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: I;
  readonly outputSchema: O;
  /** Alternative accepted Google OAuth scopes; authorization is always checked. */
  readonly scopesAnyOf: readonly string[];
  readonly risk: OperationRisk;
  run(input: z.output<I>, context: OperationContext): Promise<z.input<O>>;
}

export function defineOperation<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  operation: Operation<I, O>
): Operation<I, O> {
  return Object.freeze(operation);
}

export class OperationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "OperationError";
  }
}

const ACCOUNT = /^[A-Za-z0-9_-]{1,64}$/;
const NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

export function publicError(error: unknown): { error: string } {
  // Never return provider exception text, tokens, fetched data or internal stacks.
  return { error: error instanceof OperationError ? error.code : "OPERATION_FAILED" };
}

export type OperationMetadata = Readonly<Pick<
  Operation<z.ZodTypeAny, z.ZodTypeAny>,
  "name" | "description" | "inputSchema" | "risk" | "scopesAnyOf"
>>;

export class OperationRegistry {
  private readonly operations = new Map<string, Operation<z.ZodTypeAny, z.ZodTypeAny>>();

  constructor(
    private readonly sessions: SessionStore,
    private readonly approvals?: ApprovalGate | "direct",
    private readonly now: () => number = () => Date.now()
  ) {}

  register<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(operation: Operation<I, O>): void {
    if (!NAME.test(operation.name) || this.operations.has(operation.name)) {
      throw new OperationError("INVALID_OPERATION_DEFINITION");
    }
    if (!operation.scopesAnyOf.length || !operation.description.trim()) {
      throw new OperationError("INVALID_OPERATION_DEFINITION");
    }
    this.operations.set(operation.name, operation as unknown as Operation<z.ZodTypeAny, z.ZodTypeAny>);
  }

  catalogue(): readonly OperationMetadata[] {
    return Array.from(this.operations.values(), value => ({
      name: value.name, description: value.description,
      inputSchema: value.inputSchema, risk: value.risk,
      scopesAnyOf: value.scopesAnyOf
    }));
  }

  async execute(name: string, rawInput: unknown, principal: Principal): Promise<unknown> {
    if (!principal || principal.authenticated !== true ||
        !ACCOUNT.test(principal.accountId) || !ACCOUNT.test(principal.clientId)) {
      throw new OperationError("CLIENT_UNAUTHORIZED");
    }
    const operation = this.operations.get(name);
    if (!operation) throw new OperationError("UNKNOWN_OPERATION");

    let input: unknown;
    try {
      input = operation.inputSchema.parse(rawInput);
    } catch {
      throw new OperationError("INVALID_ARGUMENTS");
    }

    const session = await this.sessions.get(principal.accountId, principal.clientId);
    if (!session || typeof session.accessToken !== "string" ||
        session.accessToken.length < 8 || !Array.isArray(session.scopes) ||
        !Number.isFinite(session.expiresAt)) {
      throw new OperationError("GOOGLE_SESSION_NOT_CONFIGURED");
    }
    if (session.expiresAt <= this.now() + 5000) {
      throw new OperationError("GOOGLE_SESSION_EXPIRED");
    }
    if (!operation.scopesAnyOf.some(scope => session.scopes.includes(scope))) {
      throw new OperationError("GOOGLE_SCOPE_MISSING");
    }

    if (operation.risk !== "read" && operation.risk !== "prepare") {
      // The protected remote gateway may opt into direct writes only after
      // validating BOTH mcp:write client authorization and Google OAuth scopes.
      // Older local clients retain their independent per-action gate by default.
      if (this.approvals !== "direct") {
        if (!this.approvals) throw new OperationError("WRITE_APPROVAL_REQUIRED");
        await this.approvals.consume({
          clientId: principal.clientId,
          accountId: principal.accountId,
          operation: name,
          input
        });
      }
    }

    const result = await operation.run(input, { principal, session });
    try {
      return operation.outputSchema.parse(result);
    } catch {
      throw new OperationError("INVALID_PROVIDER_OUTPUT");
    }
  }
}
