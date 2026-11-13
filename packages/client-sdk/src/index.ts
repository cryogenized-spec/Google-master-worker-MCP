/**
 * Portable read-only first-party client. Use only with an OAuth bearer token
 * acquired by an application-specific public-client authorization-code + PKCE
 * flow. This library DOES NOT manage, persist, refresh or invent tokens.
 */
export const READ_OPERATION_NAMES = [
  "tasks_list_tasklists", "tasks_list_tasks", "tasks_get_task",
  "script_get_project", "script_get_content",
  "script_list_versions", "script_list_deployments",
  "drive_list_files", "drive_get_file", "drive_query_activity",
  "docs_get_document", "sheets_get_spreadsheet", "sheets_get_values",
  "slides_get_presentation", "calendar_list_calendars", "calendar_list_events",
  "gmail_list_messages", "gmail_get_message", "gmail_list_labels",
  "contacts_list_connections", "forms_get_form", "forms_list_responses",
  "meet_list_conferences", "meet_get_space",
  "tasks_get_tasklist",
  "tasks_list_tasks_extended",
  "script_list_user_processes",
  "script_list_script_processes",
  "script_get_metrics",
  "script_get_deployment",
  "drive_get_about",
  "drive_list_file_permissions",
  "drive_get_file_permission",
  "drive_list_file_comments",
  "drive_get_file_comment",
  "drive_list_comment_replies",
  "drive_list_file_revisions",
  "drive_get_file_revision",
  "drive_get_changes_start_token",
  "drive_list_changes",
  "drive_list_shared_drives",
  "drive_get_shared_drive",
  "docs_get_document_tabs",
  "sheets_get_formulas",
  "sheets_get_grid_slice",
  "sheets_get_developer_metadata",
  "slides_get_page",
  "slides_get_page_thumbnail",
  "calendar_get_event",
  "calendar_list_event_instances",
  "calendar_get_calendar",
  "calendar_list_settings",
  "calendar_get_setting",
  "calendar_list_access_rules",
  "calendar_get_access_rule",
  "calendar_get_colors",
  "gmail_get_profile",
  "gmail_get_message_full",
  "gmail_list_threads",
  "gmail_get_thread",
  "gmail_list_drafts",
  "gmail_get_draft",
  "gmail_get_label",
  "gmail_list_history",
  "gmail_get_settings_vacation",
  "gmail_get_settings_imap",
  "gmail_get_settings_pop",
  "gmail_get_settings_language",
  "gmail_get_settings_auto_forwarding",
  "gmail_list_settings_filters",
  "gmail_get_settings_filter",
  "gmail_list_forwarding_addresses",
  "gmail_list_send_as",
  "gmail_get_send_as",
  "gmail_list_delegates",
  "contacts_get_person",
  "contacts_search_contacts",
  "contacts_list_contact_groups",
  "contacts_get_contact_group",
  "contacts_list_other_contacts",
  "forms_get_response",
  "forms_list_watches",
  "meet_get_conference_record",
  "meet_list_participants",
  "meet_get_participant",
  "meet_list_participant_sessions",
  "meet_list_recordings",
  "meet_get_recording",
  "meet_list_transcripts",
  "meet_get_transcript",
  "meet_list_transcript_entries",
  "meet_list_smart_notes",
  "meet_list_members",
  "meet_get_member",
  "calendar_query_freebusy",
  "drive_get_comment_reply",
  "calendar_get_calendar_list_entry",
  "gmail_get_attachment",
  "meet_get_participant_session",
  "meet_get_smart_note",
  "meet_get_transcript_entry"
] as const;

export const WRITE_OPERATION_NAMES = [
  "tasks_create_task",
  "script_create_project",
  "script_update_sources",
  "script_create_version",
  "drive_create_folder",
  "calendar_create_event",
  "sheets_update_values",
  "gmail_create_draft",
  "gmail_send_message",
  "tasks_create_tasklist",
  "tasks_update_tasklist",
  "tasks_delete_tasklist",
  "tasks_patch_task",
  "tasks_delete_task",
  "tasks_move_task",
  "tasks_clear_completed",
  "script_create_deployment",
  "script_update_deployment",
  "script_delete_deployment",
  "drive_create_file",
  "drive_copy_file",
  "drive_update_file",
  "drive_trash_file",
  "drive_restore_file",
  "drive_delete_file",
  "drive_create_permission",
  "drive_update_permission",
  "drive_delete_permission",
  "drive_create_comment",
  "drive_update_comment",
  "drive_delete_comment",
  "drive_create_reply",
  "drive_delete_reply",
  "drive_update_reply",
  "drive_delete_revision",
  "docs_create_document",
  "docs_batch_update",
  "sheets_create_spreadsheet",
  "sheets_append_values",
  "sheets_clear_values",
  "sheets_batch_update_values",
  "sheets_batch_update",
  "slides_create_presentation",
  "slides_batch_update",
  "calendar_patch_event",
  "calendar_delete_event",
  "calendar_move_event",
  "calendar_create_calendar",
  "calendar_patch_calendar",
  "calendar_delete_calendar",
  "calendar_patch_calendar_list",
  "calendar_insert_calendar_list",
  "calendar_delete_calendar_list",
  "calendar_create_acl",
  "calendar_update_acl",
  "calendar_delete_acl",
  "gmail_update_draft",
  "gmail_delete_draft",
  "gmail_send_draft",
  "gmail_create_label",
  "gmail_update_label",
  "gmail_delete_label",
  "gmail_modify_message",
  "gmail_batch_modify_messages",
  "gmail_trash_message",
  "gmail_untrash_message",
  "gmail_modify_thread",
  "gmail_trash_thread",
  "gmail_untrash_thread",
  "gmail_set_vacation",
  "gmail_create_filter",
  "gmail_delete_filter",
  "contacts_create_contact",
  "contacts_update_contact",
  "contacts_delete_contact",
  "contacts_create_group",
  "contacts_update_group",
  "contacts_delete_group",
  "contacts_modify_group_members",
  "forms_create_form",
  "forms_batch_update",
  "forms_set_publish_settings",
  "forms_renew_watch",
  "forms_delete_watch",
  "meet_create_space",
  "meet_patch_space",
  "meet_end_active_conference",
  "meet_create_member",
  "meet_patch_member",
  "meet_delete_member"
] as const;
export type WriteOperationName = typeof WRITE_OPERATION_NAMES[number];
const WRITE_ALLOWED = new Set<string>(WRITE_OPERATION_NAMES);

export type ReadOperationName = typeof READ_OPERATION_NAMES[number];

export interface ReadApiClientOptions {
  /** Exact protected resource URI, e.g. https://mcp.domain.tld/mcp */
  resourceUrl:string;
  /** The calling app obtains its own scoped MCP OAuth token. */
  getAccessToken:() => Promise<string>;
  transport?: typeof fetch;
  timeoutMs?:number;
}
export interface ReadCapability {
  name:ReadOperationName;
  description:string;
  risk:"read";
}

const ALLOWED = new Set<string>(READ_OPERATION_NAMES);
const MAX_OUTPUT_BYTES=512*1024;

function responseError(value:unknown):string {
  if(value && typeof value==="object" && !Array.isArray(value)) {
    const code=(value as Record<string,unknown>).error;
    if(typeof code==="string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(code)) return code;
  }
  return "REMOTE_REQUEST_FAILED";
}
export class GoogleMasterClientError extends Error {
  constructor(readonly code:string, readonly status:number = 0) {
    super(code);
    this.name="GoogleMasterClientError";
  }
}
function validatedResource(input:string):string {
  let uri:URL;
  try{uri=new URL(input);}catch{throw new GoogleMasterClientError("INVALID_RESOURCE_URL");}
  if(uri.protocol!=="https:" || uri.pathname!=="/mcp" ||
      uri.username || uri.password || uri.search || uri.hash || uri.port ||
      uri.href !== uri.origin+"/mcp") {
    throw new GoogleMasterClientError("INVALID_RESOURCE_URL");
  }
  return uri.origin;
}
async function limitedJson(response:Response):Promise<unknown> {
  const claimed=response.headers.get("Content-Length");
  if(claimed && (/^\d+$/.test(claimed) === false || Number(claimed)>MAX_OUTPUT_BYTES)){
    throw new GoogleMasterClientError("RESPONSE_TOO_LARGE",response.status);
  }
  if(!response.body) throw new GoogleMasterClientError("REMOTE_RESPONSE_INVALID",response.status);
  const reader=response.body.getReader();
  const chunks:Uint8Array[]=[];
  let size=0;
  try{
    for(;;){
      const {done,value}=await reader.read();
      if(done)break;
      size+=value.byteLength;
      if(size>MAX_OUTPUT_BYTES){
        throw new GoogleMasterClientError("RESPONSE_TOO_LARGE",response.status);
      }
      chunks.push(value);
    }
  }finally{
    await reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
  const all=new Uint8Array(size);
  let at=0;
  for(const c of chunks){all.set(c,at);at+=c.byteLength;}
  try{
    return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(all)) as unknown;
  }catch{
    throw new GoogleMasterClientError("REMOTE_RESPONSE_INVALID",response.status);
  }
}

export class GoogleMasterReadClient {
  private readonly origin:string;
  private readonly transport:typeof fetch;
  private readonly getAccessToken:ReadApiClientOptions["getAccessToken"];
  private readonly timeoutMs:number;
  constructor(options:ReadApiClientOptions){
    this.origin=validatedResource(options.resourceUrl);
    if(typeof options.getAccessToken!=="function") {
      throw new GoogleMasterClientError("TOKEN_PROVIDER_REQUIRED");
    }
    this.getAccessToken=options.getAccessToken;
    this.transport=options.transport ?? fetch;
    this.timeoutMs=options.timeoutMs??12000;
    if(!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs<1000 ||
        this.timeoutMs>30000){
      throw new GoogleMasterClientError("INVALID_TIMEOUT");
    }
  }

  protected async request(path:string, method:"GET"|"POST",payload?:unknown):Promise<unknown> {
    const token=await this.getAccessToken();
    if(typeof token!=="string" || token.length<8 || token.length>8192 ||
        /[\s\u0000-\u001f]/.test(token)) {
      throw new GoogleMasterClientError("CLIENT_TOKEN_INVALID");
    }
    const headers:Record<string,string>={
      Authorization:"Bearer "+token, Accept:"application/json"
    };
    const body=method==="POST"?JSON.stringify(payload):undefined;
    if(body!==undefined) {
      if(new TextEncoder().encode(body).byteLength>32768){
        throw new GoogleMasterClientError("INPUT_TOO_LARGE");
      }
      headers["Content-Type"]="application/json";
    }
    let response:Response;
    try{
      response=await this.transport(this.origin+path,{
        method,headers,body,cache:"no-store",credentials:"omit",
        redirect:"error",referrerPolicy:"no-referrer",
        signal:AbortSignal.timeout(this.timeoutMs)
      });
    }catch{
      throw new GoogleMasterClientError("REMOTE_UNAVAILABLE");
    }
    let parsed:unknown;
    try {
      parsed=await limitedJson(response);
    } catch(error) {
      // OAuth resource servers may return an empty/plain-text challenge.
      // Preserve the HTTP status without ever echoing the provider body.
      if(!response.ok && error instanceof GoogleMasterClientError &&
          error.code==="REMOTE_RESPONSE_INVALID") {
        throw new GoogleMasterClientError(
          response.status===401 ? "CLIENT_UNAUTHORIZED" :
          response.status===403 ? "CLIENT_FORBIDDEN" : "REMOTE_REQUEST_FAILED",
          response.status
        );
      }
      throw error;
    }
    if(!response.ok){
      throw new GoogleMasterClientError(responseError(parsed),response.status);
    }
    if(!parsed || typeof parsed!=="object" || Array.isArray(parsed)){
      throw new GoogleMasterClientError("REMOTE_RESPONSE_INVALID",response.status);
    }
    return parsed;
  }

  async capabilities():Promise<ReadCapability[]> {
    const data=await this.request("/v1/capabilities","GET") as Record<string,unknown>;
    if(!Array.isArray(data.operations) ||
       !data.operations.every(item=>item && typeof item==="object" &&
         typeof item.name==="string" && typeof item.description==="string" &&
         ["read","prepare","write","destructive","external"].includes(item.risk))) {
      throw new GoogleMasterClientError("REMOTE_RESPONSE_INVALID");
    }
    const reads=data.operations.filter(item=>item.risk==="read");
    if(!reads.every(item=>ALLOWED.has(item.name))){
      throw new GoogleMasterClientError("REMOTE_RESPONSE_INVALID");
    }
    return reads as ReadCapability[];
  }

  async call<T=unknown>(name:ReadOperationName,input:Record<string,unknown>={}):Promise<T> {
    if(!ALLOWED.has(name)){
      throw new GoogleMasterClientError("UNKNOWN_OPERATION");
    }
    if(!input || typeof input!=="object" || Array.isArray(input)){
      throw new GoogleMasterClientError("INVALID_ARGUMENTS");
    }
    const data=await this.request("/v1/operations/"+name,"POST",input) as Record<string,unknown>;
    if(!Object.hasOwn(data,"result")) {
      throw new GoogleMasterClientError("REMOTE_RESPONSE_INVALID");
    }
    return data.result as T;
  }
}

/**
 * Write-capable REST client: one authenticated call executes the mutation.
 * Connection authorization requires mcp:write; Google scope checks remain server-side.
 */
export class GoogleMasterWriteClient extends GoogleMasterReadClient {
  async writeCapabilities():Promise<Array<{name:WriteOperationName,risk:"write"|"destructive"|"external"}>> {
    const data=await this.request("/v1/capabilities","GET") as Record<string,unknown>;
    if(!Array.isArray(data.operations))throw new GoogleMasterClientError("REMOTE_RESPONSE_INVALID");
    return data.operations.filter((entry:unknown)=>{
      if(!entry||typeof entry!=="object")return false;
      const x=entry as Record<string,unknown>;
      return typeof x.name==="string"&&WRITE_ALLOWED.has(x.name) &&
        ["write","destructive","external"].includes(String(x.risk));
    });
  }

  async callWrite<T=unknown>(name:WriteOperationName,input:Record<string,unknown>):Promise<T>{
    if(!WRITE_ALLOWED.has(name)||!input||Array.isArray(input)||typeof input!=="object"){
      throw new GoogleMasterClientError("INVALID_ARGUMENTS");
    }
    const reply=await this.request("/v1/operations/"+name,"POST",input) as Record<string,unknown>;
    if(!Object.hasOwn(reply,"result")){
      throw new GoogleMasterClientError("REMOTE_RESPONSE_INVALID");
    }
    return reply.result as T;
  }
}
