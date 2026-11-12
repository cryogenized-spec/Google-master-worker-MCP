/**
 * Google Master MCP one-session Workspace OAuth scope registry.
 *
 * Scope declarations are NOT API implementation permissions. Remote operations
 * remain gated by their own exact operation registry and client authorization.
 * Maintain this list alongside the operator's Google Auth Platform registration.
 * Some entries require Google Workspace business/education/admin eligibility.
 */
export const WORKSPACE_SCOPE_ENTRIES = [
  {service: "Tasks", scope: "https://www.googleapis.com/auth/tasks.readonly"},
  {service: "Tasks", scope: "https://www.googleapis.com/auth/tasks"},
  {service: "Apps Script", scope: "https://www.googleapis.com/auth/script.projects.readonly"},
  {service: "Apps Script", scope: "https://www.googleapis.com/auth/script.projects"},
  {service: "Apps Script", scope: "https://www.googleapis.com/auth/script.deployments"},
  {service: "Apps Script", scope: "https://www.googleapis.com/auth/script.processes"},
  {service: "Apps Script", scope: "https://www.googleapis.com/auth/script.metrics"},
  {service: "Drive", scope: "https://www.googleapis.com/auth/drive"},
  {service: "Drive", scope: "https://www.googleapis.com/auth/drive.activity.readonly"},
  {service: "Drive", scope: "https://www.googleapis.com/auth/drive.labels"},
  {service: "Documents", scope: "https://www.googleapis.com/auth/documents"},
  {service: "Sheets", scope: "https://www.googleapis.com/auth/spreadsheets"},
  {service: "Slides", scope: "https://www.googleapis.com/auth/presentations"},
  {service: "Calendar", scope: "https://www.googleapis.com/auth/calendar"},
  {service: "Gmail", scope: "https://www.googleapis.com/auth/gmail.modify"},
  {service: "Gmail", scope: "https://www.googleapis.com/auth/gmail.compose"},
  {service: "Gmail", scope: "https://www.googleapis.com/auth/gmail.send"},
  {service: "Gmail", scope: "https://www.googleapis.com/auth/gmail.labels"},
  {service: "Gmail", scope: "https://www.googleapis.com/auth/gmail.settings.basic"},
  {service: "Contacts", scope: "https://www.googleapis.com/auth/contacts"},
  {service: "Contacts", scope: "https://www.googleapis.com/auth/contacts.other.readonly"},
  {service: "Directory", scope: "https://www.googleapis.com/auth/directory.readonly"},
  {service: "Forms", scope: "https://www.googleapis.com/auth/forms.body"},
  {service: "Forms", scope: "https://www.googleapis.com/auth/forms.responses.readonly"},
  {service: "Chat", scope: "https://www.googleapis.com/auth/chat.spaces"},
  {service: "Chat", scope: "https://www.googleapis.com/auth/chat.messages"},
  {service: "Chat", scope: "https://www.googleapis.com/auth/chat.memberships"},
  {service: "Meet", scope: "https://www.googleapis.com/auth/meetings.space.created"},
  {service: "Meet", scope: "https://www.googleapis.com/auth/meetings.space.readonly"},
  {service: "Meet", scope: "https://www.googleapis.com/auth/meetings.space.settings"},
  {service: "Keep", scope: "https://www.googleapis.com/auth/keep"},
  {service: "Classroom", scope: "https://www.googleapis.com/auth/classroom.courses"},
  {service: "Classroom", scope: "https://www.googleapis.com/auth/classroom.rosters"},
  {service: "Classroom", scope: "https://www.googleapis.com/auth/classroom.coursework.students"},
  {service: "Classroom", scope: "https://www.googleapis.com/auth/classroom.announcements"},
  {service: "Admin SDK", scope: "https://www.googleapis.com/auth/admin.directory.user"},
  {service: "Admin SDK", scope: "https://www.googleapis.com/auth/admin.directory.group"},
  {service: "Groups Settings", scope: "https://www.googleapis.com/auth/apps.groups.settings"},
  {service: "Vault", scope: "https://www.googleapis.com/auth/ediscovery"},
] as const;

export const WORKSPACE_SCOPES: readonly string[] =
  Object.freeze(WORKSPACE_SCOPE_ENTRIES.map(entry => entry.scope));

export const WORKSPACE_SCOPES_SET: ReadonlySet<string> =
  new Set(WORKSPACE_SCOPES);

/**
 * Broad initial authorization candidate for a personal Gmail account.
 *
 * Keep the 39-scope registry intact for eligible Workspace organizations,
 * but avoid requesting administrator/organization-only functionality from
 * a consumer identity. A Google consent screen can still reject individual
 * scopes for policy or product-eligibility reasons; live consent is definitive.
 * tasks and script.projects write grants subsume their .readonly equivalents
 * for the current remote read operation catalogue.
 */
const PERSONAL_EXCLUSIONS = new Set<string>([
  "https://www.googleapis.com/auth/tasks.readonly",
  "https://www.googleapis.com/auth/script.projects.readonly",
  "https://www.googleapis.com/auth/drive.labels",
  "https://www.googleapis.com/auth/directory.readonly",
  "https://www.googleapis.com/auth/chat.spaces",
  "https://www.googleapis.com/auth/chat.messages",
  "https://www.googleapis.com/auth/chat.memberships",
  "https://www.googleapis.com/auth/keep",
  "https://www.googleapis.com/auth/classroom.courses",
  "https://www.googleapis.com/auth/classroom.rosters",
  "https://www.googleapis.com/auth/classroom.coursework.students",
  "https://www.googleapis.com/auth/classroom.announcements",
  "https://www.googleapis.com/auth/admin.directory.user",
  "https://www.googleapis.com/auth/admin.directory.group",
  "https://www.googleapis.com/auth/apps.groups.settings",
  "https://www.googleapis.com/auth/ediscovery"
]);

export const PERSONAL_WORKSPACE_SCOPES: readonly string[] =
  Object.freeze(WORKSPACE_SCOPES.filter(scope => !PERSONAL_EXCLUSIONS.has(scope)));

export const ORGANIZATION_ONLY_SCOPES: readonly string[] =
  Object.freeze(WORKSPACE_SCOPES.filter(scope => PERSONAL_EXCLUSIONS.has(scope)));
