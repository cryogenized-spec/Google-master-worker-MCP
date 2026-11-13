import { OperationRegistry, type Principal, publicError } from "../../core/src/index.js";

const MAX_INPUT_BYTES = 32 * 1024;
const MAX_OUTPUT_BYTES = 512 * 1024;
const OPERATION = /^\/v1\/operations\/([a-z][a-z0-9_]{0,95})$/;

function json(value: unknown, status = 200): Response {
  // Bound the serialized output too; Google source content can be large.
  const body = JSON.stringify(value);
  if (new TextEncoder().encode(body).byteLength > MAX_OUTPUT_BYTES) {
    return json({error:"RESPONSE_TOO_LARGE"}, 502);
  }
  return new Response(body, {
    status, headers:{
      "Content-Type":"application/json; charset=utf-8",
      "Cache-Control":"no-store",
      "X-Content-Type-Options":"nosniff",
      "Referrer-Policy":"no-referrer"
    }
  });
}

function jsonError(error: unknown): Response {
  const payload = publicError(error);
  const status = (
    ["INVALID_ARGUMENTS","INVALID_JSON_BODY","INPUT_TOO_LARGE"].includes(payload.error) ? 400 :
    payload.error === "UNKNOWN_OPERATION" ? 404 :
    ["GOOGLE_SCOPE_MISSING","CLIENT_UNAUTHORIZED","WRITE_APPROVAL_REQUIRED",
      "APPROVAL_ACTION_INVALID","APPROVAL_INPUT_INVALID"].includes(payload.error) ? 403 :
    ["GOOGLE_SESSION_NOT_CONFIGURED","GOOGLE_SESSION_EXPIRED","WORKSPACE_VAULT_NOT_CONFIGURED"].includes(payload.error) ? 503 :
    502
  );
  return json(payload,status);
}

async function boundedObject(request: Request): Promise<Record<string,unknown>> {
  const lengthHeader=request.headers.get("Content-Length");
  if (lengthHeader !== null) {
    if (!/^\d+$/.test(lengthHeader) || Number(lengthHeader) > MAX_INPUT_BYTES) {
      throw new Error("INPUT_TOO_LARGE");
    }
  }
  if (!request.body) throw new Error("INVALID_JSON_BODY");
  const reader=request.body.getReader();
  const parts:Uint8Array[]=[];
  let size=0;
  try {
    while(true){
      const {done,value}=await reader.read();
      if(done) break;
      size += value.byteLength;
      if(size>MAX_INPUT_BYTES) throw new Error("INPUT_TOO_LARGE");
      parts.push(value);
    }
  } finally {
    await reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
  const buffer=new Uint8Array(size);
  let at=0;
  for(const part of parts){buffer.set(part,at);at+=part.byteLength;}
  try {
    const input:unknown=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(buffer));
    if(!input || typeof input!=="object" || Array.isArray(input)) throw Error("object required");
    return input as Record<string,unknown>;
  } catch {
    throw new Error("INVALID_JSON_BODY");
  }
}

/**
 * Known, transport-independent read-only operations. Never expose write
 * operations, even if the core later receives an approval or broader scopes.
 */
export function readOperationCatalogue(registry:OperationRegistry) {
  return registry.catalogue().filter(item=>item.risk==="read")
    .map(item=>({name:item.name,description:item.description,risk:"read" as const}));
}

export function isRestPath(path:string):boolean {
  return path==="/v1/capabilities" || OPERATION.test(path);
}

export async function handleReadOnlyApi(
  request:Request, registry:OperationRegistry, principal:Principal,
  options:{writesEnabled?:boolean}={}
):Promise<Response> {
  const permitted=options.writesEnabled
    ? registry.catalogue().map(item=>({
        name:item.name,description:item.description,risk:item.risk
      }))
    : readOperationCatalogue(registry);
  const path=new URL(request.url).pathname;
  if(path==="/v1/capabilities"){
    if(request.method!=="GET") return json({error:"METHOD_NOT_ALLOWED"},405);
    return json({operations:permitted});
  }
  const operation=OPERATION.exec(path)?.[1];
  if(!operation) return json({error:"NOT_FOUND"},404);
  if(request.method!=="POST") return json({error:"METHOD_NOT_ALLOWED"},405);
  // When writes are off, fail closed before parsing or Google I/O.
  // With writes on, protected OAuth requires mcp:write, and the registry
  // enforces strict inputs and per-operation Google grants.
  if(!permitted.some(item=>item.name===operation)){
    return json({error:"UNKNOWN_OPERATION"},404);
  }
  if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
    (request.headers.get("Content-Type") || "").trim()
  )) return json({error:"INVALID_CONTENT_TYPE"},415);
  try {
    let input:Record<string,unknown>;
    try {input=await boundedObject(request);}
    catch(error){
      const code=error instanceof Error ? error.message : "INVALID_JSON_BODY";
      return json({error:code==="INPUT_TOO_LARGE"?"INPUT_TOO_LARGE":"INVALID_JSON_BODY"},400);
    }
    const result=await registry.execute(operation,input,principal);
    return json({result});
  }catch(error){return jsonError(error);}
}

function allowedOrigin(origin:string, targetOrigin:string, configured?:string):boolean {
  if(origin===targetOrigin) return true;
  if(!configured || configured.length>1024) return false;
  // No wildcard. Browser extension origins vary by installation and must be
  // configured individually after installing the trusted extension.
  const items=configured.split(",").map(x=>x.trim());
  if(items.length>8 || items.some(x=>!x)) return false;
  return items.some(item => {
    if(item!==origin) return false;
    if(/^moz-extension:\/\/[0-9a-f-]{8,64}$/i.test(item) ||
       /^chrome-extension:\/\/[a-p]{32}$/.test(item)) return true;
    try{
      const url=new URL(item);
      return url.protocol==="https:" && url.origin===item &&
        url.pathname==="/" && !url.username && !url.password &&
        !url.search && !url.hash;
    }catch{return false;}
  });
}

export function corsOrigin(request:Request, configured?:string):string|null|false {
  const origin=request.headers.get("Origin");
  if(origin===null) return null; // Android/native clients send no Origin.
  return allowedOrigin(origin,new URL(request.url).origin,configured) ? origin : false;
}

export function corsResponse(reply:Response, origin:string|null):Response {
  const copy=new Response(reply.body,reply);
  copy.headers.set("Vary","Origin");
  if(origin) copy.headers.set("Access-Control-Allow-Origin",origin);
  copy.headers.delete("Access-Control-Allow-Credentials");
  return copy;
}

/** Preflight has no bearer token; only respond to exact allowlisted origins. */
export function restPreflight(request:Request,configured?:string):Response {
  const path=new URL(request.url).pathname;
  const origin=corsOrigin(request,configured);
  if(!isRestPath(path) || origin===false || !origin) {
    return new Response(null,{status:403,headers:{"Cache-Control":"no-store"}});
  }
  const method=request.headers.get("Access-Control-Request-Method");
  const expected=path==="/v1/capabilities"?"GET":"POST";
  if(method!==expected){
    return new Response(null,{status:403,headers:{"Cache-Control":"no-store"}});
  }
  const raw=request.headers.get("Access-Control-Request-Headers")||"";
  const asked=raw?raw.toLowerCase().split(",").map(x=>x.trim()):[];
  const allowed=expected==="GET"?new Set(["authorization"]):
    new Set(["authorization","content-type"]);
  if(asked.some(x=>!allowed.has(x)) || asked.some(x=>!x)){
    return new Response(null,{status:403,headers:{"Cache-Control":"no-store"}});
  }
  return new Response(null,{status:204,headers:{
    "Access-Control-Allow-Origin":origin,
    "Access-Control-Allow-Methods":expected,
    "Access-Control-Allow-Headers":expected==="GET"?"Authorization":"Authorization, Content-Type",
    "Access-Control-Max-Age":"300",
    "Vary":"Origin",
    "Cache-Control":"no-store"
  }});
}
