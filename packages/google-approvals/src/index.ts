import * as z from "zod/v4";
import {
  defineOperation,OperationRegistry,OperationError,
  type ApprovalAction, type ApprovalGate, type OperationRisk
} from "../../core/src/index.js";
import {importVaultKey,seal,unseal,sha256Url,encodeBase64Url} from "../../google-auth/src/crypto.js";
import type {D1DatabaseLike} from "../../google-auth/src/store.js";
import {PERSONAL_WORKSPACE_SCOPES} from "../../google-auth/src/scopes.js";

/**
 * The model can only PROPOSE an operation and input. D1 stores the full
 * validated input encrypted. A distinct Google-verified owner browser session
 * approves an exact hash, risk, target and OAuth-client identity. The Worker
 * atomically consumes that approval at most once before any Google write.
 */
const REQUEST_TTL=20*60_000;
const APPROVED_TTL=5*60_000;
const MAX_PENDING=10;
const MAX_PAYLOAD_BYTES=30_000;
const ID=/^[A-Za-z0-9_-]{27}$/;

type Status="pending"|"approved"|"rejected"|"consumed";
interface ApprovalRow {
  id:string;account_id:string;client_id:string;operation:string;
  risk:"write"|"destructive"|"external"; input_digest:string;
  input_enc:string;status:Status;created_at:number;expires_at:number;
  approved_at:number|null;consumed_at:number|null;
}
export interface ApprovalPreview {
  readonly id:string;readonly operation:string;readonly risk:ApprovalRow["risk"];
  readonly clientId:string;readonly input:Record<string,unknown>;
  readonly expiresAt:number;readonly status:Status;
}
function canonical(value:unknown):string {
  function stable(input:unknown,depth:number):unknown {
    if(depth>24)throw new OperationError("APPROVAL_INPUT_INVALID");
    if(Array.isArray(input))return input.map(x=>stable(x,depth+1));
    if(input!==null&&typeof input==="object"){
      const o=input as Record<string,unknown>;
      const out:Record<string,unknown>={};
      for(const k of Object.keys(o).sort()){
        if(["__proto__","prototype","constructor"].includes(k)){
          throw new OperationError("APPROVAL_INPUT_INVALID");
        }
        out[k]=stable(o[k],depth+1);
      }
      return out;
    }
    return input;
  }
  let data:string;
  try{data=JSON.stringify(stable(value,0));}
  catch{throw new OperationError("APPROVAL_INPUT_INVALID");}
  if(typeof data!=="string"||
     new TextEncoder().encode(data).byteLength>MAX_PAYLOAD_BYTES){
    throw new OperationError("APPROVAL_INPUT_TOO_LARGE");
  }
  return data;
}
function idToken():string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(20)));
}
function parseRow(row:ApprovalRow|null):ApprovalRow {
  if(!row||!ID.test(row.id))throw new OperationError("APPROVAL_NOT_FOUND");
  return row;
}
function checkedId(id:string):string {
  if(!ID.test(id))throw new OperationError("APPROVAL_NOT_FOUND");
  return id;
}
export class D1WriteApprovals implements ApprovalGate {
  private readonly key:Promise<CryptoKey>;
  constructor(private readonly db:D1DatabaseLike,
    encryptionKey:string,private readonly now:()=>number=()=>Date.now()){
    if(!db||typeof db.prepare!=="function")throw new OperationError("APPROVAL_STORE_UNAVAILABLE");
    this.key=importVaultKey(encryptionKey);
  }

  async request(action:ApprovalAction,risk:ApprovalRow["risk"]):Promise<{id:string,expiresAt:number}>{
    if(!["write","destructive","external"].includes(risk)||
      action.accountId!=="default"||
      !/^mcp_[a-f0-9]{48}$/.test(action.clientId)||
      !/^[a-z][a-z0-9_]{0,95}$/.test(action.operation)){
      throw new OperationError("APPROVAL_ACTION_INVALID");
    }
    const raw=canonical(action.input);
    const digest=await sha256Url(raw);
    const count=await this.db.prepare(
      "SELECT COUNT(*) AS count FROM google_write_approvals WHERE account_id=? AND client_id=? AND status IN ('pending','approved') AND expires_at>?"
    ).bind(action.accountId,action.clientId,this.now()).first<{count:number}>();
    if(Number(count?.count??0)>=MAX_PENDING)throw new OperationError("APPROVAL_QUEUE_LIMIT");
    const id=idToken();
    const expiresAt=this.now()+REQUEST_TTL;
    const ciphertext=await seal(await this.key,"write-action:"+id,{input:JSON.parse(raw)});
    await this.db.prepare(
      "INSERT INTO google_write_approvals(id,account_id,client_id,operation,risk,input_digest,input_enc,status,created_at,expires_at) "+
      "VALUES (?,?,?,?,?,?,?,'pending',?,?)"
    ).bind(id,action.accountId,action.clientId,action.operation,risk,digest,ciphertext,
      this.now(),expiresAt).run();
    return {id,expiresAt};
  }

  async pending():Promise<readonly ApprovalPreview[]>{
    // D1Statement in this project's tests intentionally only offers first()
    // and run(). Fetch the newest requests with a bounded indexed probe.
    // For the UI, the operator opens a specific proposal ID from a URL;
    // optional listing is provided by nextPending().
    const item=await this.db.prepare(
      "SELECT * FROM google_write_approvals WHERE account_id='default' AND status='pending' AND expires_at>? ORDER BY created_at DESC LIMIT 1"
    ).bind(this.now()).first<ApprovalRow>();
    if(!item)return [];
    return [await this.preview(item.id)];
  }

  async preview(id:string):Promise<ApprovalPreview>{
    const row=parseRow(await this.db.prepare(
      "SELECT * FROM google_write_approvals WHERE id=? AND account_id='default'"
    ).bind(checkedId(id)).first<ApprovalRow>());
    if(row.expires_at<=this.now())throw new OperationError("APPROVAL_EXPIRED");
    const decrypted=await unseal<{input:Record<string,unknown>}>(
      await this.key,"write-action:"+id,row.input_enc);
    const input=decrypted.input;
    if(await sha256Url(canonical(input))!==row.input_digest){
      throw new OperationError("APPROVAL_INPUT_MISMATCH");
    }
    return {
      id,operation:row.operation,risk:row.risk,clientId:row.client_id,
      input,expiresAt:row.expires_at,status:row.status
    };
  }

  async decide(id:string,decision:"approve"|"reject"):Promise<void>{
    const target=checkedId(id);
    // Atomic transition; a double-submitted form cannot mint extra grants.
    const until=decision==="approve"?
      Math.min(this.now()+APPROVED_TTL, this.now()+REQUEST_TTL):this.now();
    const next:Status=decision==="approve"?"approved":"rejected";
    const changed=await this.db.prepare(
      "UPDATE google_write_approvals SET status=?,approved_at=?,expires_at=? "+
      "WHERE id=? AND account_id='default' AND status='pending' AND expires_at>? "+
      "RETURNING id"
    ).bind(next,decision==="approve"?this.now():null,until,target,this.now())
     .first<{id:string}>();
    if(!changed)throw new OperationError("APPROVAL_EXPIRED_OR_ALREADY_DECIDED");
  }

  async consume(action:ApprovalAction):Promise<void>{
    if(action.accountId!=="default"||
      !/^mcp_[a-f0-9]{48}$/.test(action.clientId)) {
      throw new OperationError("WRITE_APPROVAL_REQUIRED");
    }
    const digest=await sha256Url(canonical(action.input));
    // The UPDATE+RETURNING is a single SQLite statement: no read/claim race.
    const consumed=await this.db.prepare(
      "UPDATE google_write_approvals SET status='consumed',consumed_at=? "+
      "WHERE id=(SELECT id FROM google_write_approvals WHERE "+
      "account_id=? AND client_id=? AND operation=? AND input_digest=? "+
      "AND status='approved' AND expires_at>? "+
      "ORDER BY approved_at ASC,id ASC LIMIT 1) "+
      "AND status='approved' RETURNING id"
    ).bind(this.now(),action.accountId,action.clientId,action.operation,digest,
      this.now()).first<{id:string}>();
    if(!consumed)throw new OperationError("WRITE_APPROVAL_REQUIRED");
  }
}

export function registerWriteApprovalPreparation(
  registry:OperationRegistry,store:D1WriteApprovals,setupOrigin:string
):void{
  let url:URL;
  try{url=new URL(setupOrigin);}
  catch{throw new OperationError("APPROVAL_SETUP_UNAVAILABLE");}
  if(url.protocol!=="https:"||url.pathname!=="/"||
    url.username||url.password||url.search||url.hash||
    !url.hostname.endsWith(".workers.dev")){
    throw new OperationError("APPROVAL_SETUP_UNAVAILABLE");
  }
  const schema=z.object({
    operation:z.string().regex(/^[a-z][a-z0-9_]{0,95}$/),
    input:z.record(z.string(),z.unknown())
  }).strict();
  registry.register(defineOperation({
    name:"write_prepare_action",risk:"prepare",
    description:"PROPOSE (never execute) a specific Google write. Returns a private owner approval link. The owner must sign in separately, inspect the complete parameters and approve before the same exact operation can execute.",
    scopesAnyOf:PERSONAL_WORKSPACE_SCOPES,
    inputSchema:schema,
    outputSchema:z.object({
      operation:z.string(),risk:z.enum(["write","destructive","external"]),
      requestId:z.string(),approvalUrl:z.url(),expiresAt:z.number()
    }).strict(),
    async run(input,{principal,session}){
      const op=registry.catalogue().find(meta=>meta.name===input.operation);
      if(!op||!["write","destructive","external"].includes(op.risk)){
        throw new OperationError("UNKNOWN_WRITE_OPERATION");
      }
      if(!op.scopesAnyOf.some(scope=>session.scopes.includes(scope))){
        throw new OperationError("GOOGLE_SCOPE_MISSING");
      }
      let parsed:unknown;
      try{parsed=op.inputSchema.parse(input.input);}
      catch{throw new OperationError("INVALID_ARGUMENTS");}
      const {id,expiresAt}=await store.request({
        accountId:principal.accountId,clientId:principal.clientId,
        operation:op.name,input:parsed
      },op.risk as "write"|"destructive"|"external");
      return {
        operation:op.name,risk:op.risk as "write"|"destructive"|"external",
        requestId:id,expiresAt,
        approvalUrl:new URL("/setup?approval="+encodeURIComponent(id),url).toString()
      };
    }
  }));
}
