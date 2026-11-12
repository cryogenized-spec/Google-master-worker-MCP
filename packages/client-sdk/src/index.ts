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
  "meet_list_conferences", "meet_get_space"
] as const;

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

  private async request(path:string, method:"GET"|"POST",payload?:unknown):Promise<unknown> {
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
         ALLOWED.has(item.name) && typeof item.description==="string" &&
         item.risk==="read")) {
      throw new GoogleMasterClientError("REMOTE_RESPONSE_INVALID");
    }
    return data.operations as ReadCapability[];
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
