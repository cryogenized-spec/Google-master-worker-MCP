import * as z from "zod/v4";
import {defineOperation,OperationRegistry,OperationError, type OperationRisk} from "../../core/src/index.js";
import {GoogleJsonClient, type QueryValue} from "../../google-http/src/index.js";

/** M23: named Google mutations; every call requires independent host approval. */
type Service="tasks"|"script"|"drive"|"docs"|"sheets"|"slides"|
  "calendar"|"gmail"|"people"|"forms"|"meet";
type Method="POST"|"PATCH"|"PUT"|"DELETE";
type Payload=(input:Record<string,unknown>)=>unknown;
interface Spec {
  name:string; service:Service; method:Method; path:string;
  scope:string[]; risk:Exclude<OperationRisk,"read"|"prepare">;
  shape:Record<string,z.ZodTypeAny>; payload?:Payload;
  query?:Record<string,QueryValue> | ((input:Record<string,unknown>)=>Record<string,QueryValue>);
}
const oauth=(name:string)=>"https://www.googleapis.com/auth/"+name;
const itemId=z.string().min(1).max(512)
 .refine(s=>!/[\/\\\u0000-\u001f]/.test(s)&&s!=="."&&s!==".."&&!s.includes(".."));
const email=z.email().max(320);
const label=z.string().trim().min(1).max(256);
const description=z.string().max(6000);
const when=z.iso.datetime({offset:true});
const primitive=z.union([z.string().max(4096),z.number().finite(),z.boolean()]);
const cells=z.array(z.array(primitive).max(40)).min(1).max(200);
const cleanJSON=z.record(z.string(),z.unknown()).refine(value=>{
  try{return JSON.stringify(value).length<=23000;}catch{return false;}
},"JSON object is too large");
const batch=z.array(cleanJSON).min(1).max(30);
const pathId=(template:string)=>[...template.matchAll(/\/:([a-z][A-Za-z0-9]*)/g)].map(x=>x[1]);
const specs:Spec[]=[];
function add(name:string,service:Service,method:Method,path:string,scope:string[],
  risk:Spec["risk"],shape:Spec["shape"],payload?:Payload,
  query?:Spec["query"]):void {
  specs.push({name,service,method,path,scope,risk,shape,payload,query});
}
const TS=[oauth("tasks")], AS=[oauth("script.projects")],
  ASD=[oauth("script.deployments")], D=[oauth("drive")],
  DOC=[oauth("documents")], SH=[oauth("spreadsheets")],
  SL=[oauth("presentations")], CAL=[oauth("calendar")],
  GM=[oauth("gmail.modify")], GC=[oauth("gmail.compose")],
  GS=[oauth("gmail.send")], GL=[oauth("gmail.labels")],
  GSET=[oauth("gmail.settings.basic")],
  CONTACT=[oauth("contacts")], FORM=[oauth("forms.body")],
  MEET_CREATED=[oauth("meetings.space.created")],
  MEET_SETTINGS=[oauth("meetings.space.settings")];

const title={title:label}, name={name:label};
const empty={};
const patchBody=(x:Record<string,unknown>)=>x.body;
const payload=(x:Record<string,unknown>)=>x.values;
const valuesShape={values:cells};
const requested=(x:Record<string,unknown>)=>({requests:x.requests});
const mutate=(x:Record<string,unknown>)=>({body:x.body});

/** Tasks and tasklists, including completed/clear/move operations. */
add("tasks_create_tasklist","tasks","POST","/tasks/v1/users/@me/lists",TS,"write",title,x=>({title:x.title}));
add("tasks_update_tasklist","tasks","PATCH","/tasks/v1/users/@me/lists/:tasklistId",TS,"write",title,x=>({title:x.title}));
add("tasks_delete_tasklist","tasks","DELETE","/tasks/v1/users/@me/lists/:tasklistId",TS,"destructive",empty);
add("tasks_patch_task","tasks","PATCH","/tasks/v1/lists/:tasklistId/tasks/:taskId",TS,"write",{
  title:z.string().max(1024).optional(),notes:description.optional(),
  status:z.enum(["needsAction","completed"]).optional(),
  due:when.optional(),completed:when.optional()
},x=>Object.fromEntries(Object.entries(x).filter(([key,v])=>!["tasklistId","taskId"].includes(key)&&v!==undefined)));
add("tasks_delete_task","tasks","DELETE","/tasks/v1/lists/:tasklistId/tasks/:taskId",TS,"destructive",empty);
add("tasks_move_task","tasks","POST","/tasks/v1/lists/:tasklistId/tasks/:taskId/move",TS,"write",{
  parent:itemId.optional(),previous:itemId.optional()
},undefined,x=>({parent:x.parent as string|undefined,previous:x.previous as string|undefined}));
add("tasks_clear_completed","tasks","POST","/tasks/v1/lists/:tasklistId/clear",TS,"destructive",empty);

/** Apps Script projects: full source replacements still need separate diff review. */
add("script_create_deployment","script","POST","/v1/projects/:scriptId/deployments",ASD,"external",{
  versionNumber:z.number().int().positive(),description:description.optional()
},x=>({versionNumber:x.versionNumber,description:x.description}));
add("script_update_deployment","script","PUT","/v1/projects/:scriptId/deployments/:deploymentId",ASD,"external",{
  versionNumber:z.number().int().positive(),description:description.optional()
},x=>({deploymentConfig:{versionNumber:x.versionNumber,description:x.description,
  manifestFileName:"appsscript"}}));
add("script_delete_deployment","script","DELETE","/v1/projects/:scriptId/deployments/:deploymentId",ASD,"destructive",empty);

/** Drive file/folder metadata, copies, shares, revisions and collaboration. */
add("drive_create_file","drive","POST","/drive/v3/files",D,"write",{
  name:label,mimeType:z.string().min(1).max(128),parentId:itemId.optional(),
  description:description.optional()
},x=>({name:x.name,mimeType:x.mimeType,description:x.description,
  ...(x.parentId?{parents:[x.parentId]}:{})}),
 {fields:"id,name,mimeType,webViewLink,parents"});
add("drive_copy_file","drive","POST","/drive/v3/files/:fileId/copy",D,"write",{
  name:label,parentId:itemId.optional()
},x=>({name:x.name,...(x.parentId?{parents:[x.parentId]}:{})}),
 {fields:"id,name,mimeType,webViewLink"});
add("drive_update_file","drive","PATCH","/drive/v3/files/:fileId",D,"write",{
  name:label.optional(),description:description.optional(),
  starred:z.boolean().optional(),trashed:z.boolean().optional(),
  addParents:itemId.optional(),removeParents:itemId.optional()
},x=>Object.fromEntries(Object.entries(x).filter(([key,v])=>
  !["fileId","addParents","removeParents"].includes(key)&&v!==undefined)),
 x=>({fields:"id,name,mimeType,parents,trashed,webViewLink",
   addParents:x.addParents as string|undefined,removeParents:x.removeParents as string|undefined}));
add("drive_trash_file","drive","PATCH","/drive/v3/files/:fileId",D,"destructive",empty,()=>({trashed:true}));
add("drive_restore_file","drive","PATCH","/drive/v3/files/:fileId",D,"write",empty,()=>({trashed:false}));
add("drive_delete_file","drive","DELETE","/drive/v3/files/:fileId",D,"destructive",empty);
add("drive_create_permission","drive","POST","/drive/v3/files/:fileId/permissions",D,"external",{
  type:z.enum(["user","group","domain","anyone"]),
  role:z.enum(["reader","commenter","writer"]),
  emailAddress:email.optional(),domain:z.string().max(255).optional(),
  sendNotificationEmail:z.boolean().default(false)
},x=>({type:x.type,role:x.role,emailAddress:x.emailAddress,domain:x.domain}),
 x=>({sendNotificationEmail:x.sendNotificationEmail as boolean,fields:"id,type,role,emailAddress,domain"}));
add("drive_update_permission","drive","PATCH","/drive/v3/files/:fileId/permissions/:permissionId",D,"external",{
  role:z.enum(["reader","commenter","writer"])
},x=>({role:x.role}),{fields:"id,type,role"});
add("drive_delete_permission","drive","DELETE","/drive/v3/files/:fileId/permissions/:permissionId",D,"destructive",empty);
add("drive_create_comment","drive","POST","/drive/v3/files/:fileId/comments",D,"external",{
  content:z.string().min(1).max(4000)
},x=>({content:x.content}),{fields:"id,content,createdTime"});
add("drive_update_comment","drive","PATCH","/drive/v3/files/:fileId/comments/:commentId",D,"external",{
  content:z.string().min(1).max(4000)
},x=>({content:x.content}),{fields:"id,content,modifiedTime"});
add("drive_delete_comment","drive","DELETE","/drive/v3/files/:fileId/comments/:commentId",D,"destructive",empty);
add("drive_create_reply","drive","POST","/drive/v3/files/:fileId/comments/:commentId/replies",D,"external",{
  content:z.string().min(1).max(4000)
},x=>({content:x.content}),{fields:"id,content,createdTime"});
add("drive_delete_reply","drive","DELETE","/drive/v3/files/:fileId/comments/:commentId/replies/:replyId",D,"destructive",empty);
add("drive_delete_revision","drive","DELETE","/drive/v3/files/:fileId/revisions/:revisionId",D,"destructive",empty);

/** Docs & Sheets & Slides batchUpdates: bounded, exact JSON approved by owner. */
add("docs_create_document","docs","POST","/v1/documents",DOC,"write",title,x=>({title:x.title}));
add("docs_batch_update","docs","POST","/v1/documents/:documentId:batchUpdate",DOC,"write",{
  requests:batch,requiredRevisionId:z.string().max(256).optional()
},x=>({requests:x.requests,...(x.requiredRevisionId?
 {writeControl:{requiredRevisionId:x.requiredRevisionId}}:{})}));
add("sheets_create_spreadsheet","sheets","POST","/v4/spreadsheets",SH,"write",title,x=>({properties:{title:x.title}}));
add("sheets_append_values","sheets","POST","/v4/spreadsheets/:spreadsheetId/values/:range:append",SH,"write",{
  range:z.string().min(1).max(160),...valuesShape,
  valueInputOption:z.enum(["RAW","USER_ENTERED"]).default("USER_ENTERED")
},x=>({range:x.range,majorDimension:"ROWS",values:x.values}),
 x=>({valueInputOption:x.valueInputOption as string,insertDataOption:"INSERT_ROWS"}));
add("sheets_clear_values","sheets","POST","/v4/spreadsheets/:spreadsheetId/values/:range:clear",SH,"destructive",{
  range:z.string().min(1).max(160)
},()=>({}));
add("sheets_batch_update_values","sheets","POST","/v4/spreadsheets/:spreadsheetId/values:batchUpdate",SH,"write",{
  data:z.array(z.object({range:z.string().min(1).max(160),values:cells}).strict()).min(1).max(15),
  valueInputOption:z.enum(["RAW","USER_ENTERED"]).default("USER_ENTERED")
},x=>({valueInputOption:x.valueInputOption,data:x.data}));
add("sheets_batch_update","sheets","POST","/v4/spreadsheets/:spreadsheetId:batchUpdate",SH,"write",{
  requests:batch
},requested);
add("slides_create_presentation","slides","POST","/v1/presentations",SL,"write",title,x=>({title:x.title}));
add("slides_batch_update","slides","POST","/v1/presentations/:presentationId:batchUpdate",SL,"write",{
  requests:batch
},requested);

/** Calendar events, calendars, lists and access control. */
add("calendar_patch_event","calendar","PATCH","/calendar/v3/calendars/:calendarId/events/:eventId",CAL,"write",{
  summary:label.optional(),description:description.optional(),
  location:z.string().max(512).optional(),
  start:when.optional(),end:when.optional(),
  status:z.enum(["confirmed","tentative","cancelled"]).optional()
},x=>({summary:x.summary,description:x.description,location:x.location,
  ...(x.start?{start:{dateTime:x.start}}:{}),...(x.end?{end:{dateTime:x.end}}:{}),
  status:x.status}),{sendUpdates:"none"});
add("calendar_delete_event","calendar","DELETE","/calendar/v3/calendars/:calendarId/events/:eventId",CAL,"destructive",empty,undefined,{sendUpdates:"none"});
add("calendar_create_calendar","calendar","POST","/calendar/v3/calendars",CAL,"write",{
  summary:label,timeZone:z.string().min(1).max(80).optional(),
  description:description.optional()
},x=>({summary:x.summary,timeZone:x.timeZone,description:x.description}));
add("calendar_patch_calendar","calendar","PATCH","/calendar/v3/calendars/:calendarId",CAL,"write",{
  summary:label.optional(),description:description.optional()
},x=>({summary:x.summary,description:x.description}));
add("calendar_delete_calendar","calendar","DELETE","/calendar/v3/calendars/:calendarId",CAL,"destructive",empty);
add("calendar_patch_calendar_list","calendar","PATCH","/calendar/v3/users/me/calendarList/:calendarId",CAL,"write",{
  colorId:z.string().max(15).optional(),hidden:z.boolean().optional(),
  selected:z.boolean().optional(),summaryOverride:label.optional()
},x=>({colorId:x.colorId,hidden:x.hidden,selected:x.selected,
  summaryOverride:x.summaryOverride}));
add("calendar_insert_calendar_list","calendar","POST","/calendar/v3/users/me/calendarList",CAL,"write",{
  calendarId:itemId
},x=>({id:x.calendarId}));
add("calendar_delete_calendar_list","calendar","DELETE","/calendar/v3/users/me/calendarList/:calendarId",CAL,"destructive",empty);
add("calendar_create_acl","calendar","POST","/calendar/v3/calendars/:calendarId/acl",CAL,"external",{
  scopeType:z.enum(["user","group","domain","default"]),scopeValue:z.string().max(320).optional(),
  role:z.enum(["freeBusyReader","reader","writer","owner"])
},x=>({scope:{type:x.scopeType,value:x.scopeValue},role:x.role}));
add("calendar_update_acl","calendar","PATCH","/calendar/v3/calendars/:calendarId/acl/:ruleId",CAL,"external",{
  role:z.enum(["freeBusyReader","reader","writer","owner"])
},x=>({role:x.role}));
add("calendar_delete_acl","calendar","DELETE","/calendar/v3/calendars/:calendarId/acl/:ruleId",CAL,"destructive",empty);

/** Gmail drafts, labels, message state and permanent deletion. */
add("gmail_update_draft","gmail","PUT","/gmail/v1/users/me/drafts/:draftId",GC,"write",{
  rawBase64Url:z.string().regex(/^[A-Za-z0-9_-]{16,100000}$/)
},x=>({id:x.draftId,message:{raw:x.rawBase64Url}}));
add("gmail_delete_draft","gmail","DELETE","/gmail/v1/users/me/drafts/:draftId",GC,"destructive",empty);
add("gmail_send_draft","gmail","POST","/gmail/v1/users/me/drafts/send",GS,"external",{
  draftId:itemId
},x=>({id:x.draftId}));
add("gmail_create_label","gmail","POST","/gmail/v1/users/me/labels",GL,"write",{
  name:label,labelListVisibility:z.enum(["labelShow","labelShowIfUnread","labelHide"]).optional(),
  messageListVisibility:z.enum(["show","hide"]).optional()
},x=>({name:x.name,labelListVisibility:x.labelListVisibility,messageListVisibility:x.messageListVisibility}));
add("gmail_update_label","gmail","PATCH","/gmail/v1/users/me/labels/:labelId",GL,"write",{
  name:label.optional(),labelListVisibility:z.enum(["labelShow","labelShowIfUnread","labelHide"]).optional(),
  messageListVisibility:z.enum(["show","hide"]).optional()
},x=>({name:x.name,labelListVisibility:x.labelListVisibility,messageListVisibility:x.messageListVisibility}));
add("gmail_delete_label","gmail","DELETE","/gmail/v1/users/me/labels/:labelId",GL,"destructive",empty);
const labelChange={addLabelIds:z.array(itemId).max(30).default([]),removeLabelIds:z.array(itemId).max(30).default([])};
add("gmail_modify_message","gmail","POST","/gmail/v1/users/me/messages/:messageId/modify",GM,"write",labelChange,
 x=>({addLabelIds:x.addLabelIds,removeLabelIds:x.removeLabelIds}));
add("gmail_batch_modify_messages","gmail","POST","/gmail/v1/users/me/messages/batchModify",GM,"write",{
  ids:z.array(itemId).min(1).max(100),...labelChange
},x=>({ids:x.ids,addLabelIds:x.addLabelIds,removeLabelIds:x.removeLabelIds}));
add("gmail_trash_message","gmail","POST","/gmail/v1/users/me/messages/:messageId/trash",GM,"destructive",empty);
add("gmail_untrash_message","gmail","POST","/gmail/v1/users/me/messages/:messageId/untrash",GM,"write",empty);
add("gmail_delete_message","gmail","DELETE","/gmail/v1/users/me/messages/:messageId",GM,"destructive",empty);
add("gmail_modify_thread","gmail","POST","/gmail/v1/users/me/threads/:threadId/modify",GM,"write",labelChange,
 x=>({addLabelIds:x.addLabelIds,removeLabelIds:x.removeLabelIds}));
add("gmail_trash_thread","gmail","POST","/gmail/v1/users/me/threads/:threadId/trash",GM,"destructive",empty);
add("gmail_untrash_thread","gmail","POST","/gmail/v1/users/me/threads/:threadId/untrash",GM,"write",empty);
add("gmail_delete_thread","gmail","DELETE","/gmail/v1/users/me/threads/:threadId",GM,"destructive",empty);
add("gmail_set_vacation","gmail","PUT","/gmail/v1/users/me/settings/vacation",GSET,"external",{
  enableAutoReply:z.boolean(),responseSubject:z.string().max(250).optional(),
  responseBodyPlainText:description.optional(),restrictToContacts:z.boolean().optional()
},x=>({enableAutoReply:x.enableAutoReply,responseSubject:x.responseSubject,
 responseBodyPlainText:x.responseBodyPlainText,restrictToContacts:x.restrictToContacts}));
add("gmail_create_filter","gmail","POST","/gmail/v1/users/me/settings/filters",GSET,"write",{
  criteria:cleanJSON,action:cleanJSON
},x=>({criteria:x.criteria,action:x.action}));
add("gmail_delete_filter","gmail","DELETE","/gmail/v1/users/me/settings/filters/:filterId",GSET,"destructive",empty);

/** People contact CRUD, contact groups and group memberships. */
add("contacts_create_contact","people","POST","/v1/people:createContact",CONTACT,"write",{
  givenName:label,familyName:z.string().max(200).optional(),
  emailAddress:email.optional(),phoneNumber:z.string().max(80).optional()
},x=>({names:[{givenName:x.givenName,familyName:x.familyName}],
  ...(x.emailAddress?{emailAddresses:[{value:x.emailAddress}]}:{}),
  ...(x.phoneNumber?{phoneNumbers:[{value:x.phoneNumber}]}:{})}));
add("contacts_update_contact","people","PATCH","/v1/people/:personId:updateContact",CONTACT,"write",{
  etag:z.string().min(1).max(512),
  names:z.array(z.object({givenName:label,familyName:z.string().max(200).optional()}).strict()).max(3).optional(),
  emailAddresses:z.array(z.object({value:email}).strict()).max(10).optional(),
  phoneNumbers:z.array(z.object({value:z.string().min(1).max(80)}).strict()).max(10).optional()
},x=>({resourceName:"people/"+x.personId,etag:x.etag,
  names:x.names,emailAddresses:x.emailAddresses,phoneNumbers:x.phoneNumbers}),
 x=>({updatePersonFields:["names","emailAddresses","phoneNumbers"].filter(k=>x[k]!==undefined).join(",")}));
add("contacts_delete_contact","people","DELETE","/v1/people/:personId:deleteContact",CONTACT,"destructive",empty);
add("contacts_create_group","people","POST","/v1/contactGroups",CONTACT,"write",{
  name:label
},x=>({contactGroup:{name:x.name}}));
add("contacts_update_group","people","PUT","/v1/contactGroups/:groupId",CONTACT,"write",{
  name:label
},x=>({contactGroup:{name:x.name,resourceName:"contactGroups/"+x.groupId},
  updateGroupFields:"name"}));
add("contacts_delete_group","people","DELETE","/v1/contactGroups/:groupId",CONTACT,"destructive",empty);
add("contacts_modify_group_members","people","POST","/v1/contactGroups/:groupId/members:modify",CONTACT,"write",{
  resourceNamesToAdd:z.array(z.string().regex(/^people\/[^/]{1,200}$/)).max(100).default([]),
  resourceNamesToRemove:z.array(z.string().regex(/^people\/[^/]{1,200}$/)).max(100).default([])
},x=>({resourceNamesToAdd:x.resourceNamesToAdd,resourceNamesToRemove:x.resourceNamesToRemove}));

/** Forms authoring, publishing and watch lifecycle. */
add("forms_create_form","forms","POST","/v1/forms",FORM,"write",title,x=>({info:{title:x.title}}));
add("forms_batch_update","forms","POST","/v1/forms/:formId:batchUpdate",FORM,"write",{
  requests:batch,revisionId:z.string().max(256).optional()
},x=>({requests:x.requests,includeFormInResponse:false,
  ...(x.revisionId?{writeControl:{requiredRevisionId:x.revisionId}}:{})}));
add("forms_set_publish_settings","forms","POST","/v1/forms/:formId:setPublishSettings",FORM,"external",{
  isPublished:z.boolean(),isAcceptingResponses:z.boolean()
},x=>({publishSettings:{publishState:{
  isPublished:x.isPublished,isAcceptingResponses:x.isAcceptingResponses}},
  updateMask:"publishState"}));
add("forms_renew_watch","forms","POST","/v1/forms/:formId/watches/:watchId:renew",FORM,"external",empty);
add("forms_delete_watch","forms","DELETE","/v1/forms/:formId/watches/:watchId",FORM,"destructive",empty);

/** Meet meeting spaces and participant membership. */
add("meet_create_space","meet","POST","/v2/spaces",MEET_CREATED,"write",empty,()=>({}));
add("meet_patch_space","meet","PATCH","/v2/spaces/:spaceId",MEET_SETTINGS,"external",{
  accessType:z.enum(["OPEN","TRUSTED","RESTRICTED"]).optional(),
  entryPointAccess:z.enum(["ALL","CREATOR_APP_ONLY"]).optional()
},x=>({name:"spaces/"+x.spaceId,config:{accessType:x.accessType,
  entryPointAccess:x.entryPointAccess}}),
 x=>({updateMask:["config.accessType","config.entryPointAccess"].filter(k=>
   x[k.split(".")[1]]!==undefined).join(",")}));
add("meet_end_active_conference","meet","POST","/v2/spaces/:spaceId:endActiveConference",MEET_CREATED,"destructive",empty,()=>({}));
add("meet_create_member","meet","POST","/v2/spaces/:spaceId/members",MEET_SETTINGS,"external",{
  email:email,role:z.enum(["COHOST","ROLE_UNSPECIFIED"]).default("ROLE_UNSPECIFIED")
},x=>({email:x.email,role:x.role}));
add("meet_patch_member","meet","PATCH","/v2/spaces/:spaceId/members/:memberId",MEET_SETTINGS,"external",{
  role:z.enum(["COHOST","ROLE_UNSPECIFIED"])
},x=>({role:x.role}),{updateMask:"role"});
add("meet_delete_member","meet","DELETE","/v2/spaces/:spaceId/members/:memberId",MEET_SETTINGS,"destructive",empty);

export const WRITE_SPECS: readonly Spec[]=Object.freeze(specs);
function encode(value:unknown):string{return encodeURIComponent(String(value));}
function route(template:string, input:Record<string,unknown>):string {
  return template.replace(/(\/):([a-z][A-Za-z0-9]*)/g,(_full,slash:string,key:string)=>{
    const value=input[key];
    if(typeof value!=="string")throw new OperationError("INVALID_ARGUMENTS");
    return slash+encode(value);
  });
}
function clientMap(overrides:Partial<Record<Service,GoogleJsonClient>>) {
  const www="https://www.googleapis.com";
  return {
    tasks:overrides.tasks??new GoogleJsonClient("https://tasks.googleapis.com","/tasks/v1/"),
    script:overrides.script??new GoogleJsonClient("https://script.googleapis.com","/v1/"),
    drive:overrides.drive??new GoogleJsonClient(www,"/drive/v3/"),
    docs:overrides.docs??new GoogleJsonClient("https://docs.googleapis.com","/v1/"),
    sheets:overrides.sheets??new GoogleJsonClient("https://sheets.googleapis.com","/v4/"),
    slides:overrides.slides??new GoogleJsonClient("https://slides.googleapis.com","/v1/"),
    calendar:overrides.calendar??new GoogleJsonClient(www,"/calendar/v3/"),
    gmail:overrides.gmail??new GoogleJsonClient("https://gmail.googleapis.com","/gmail/v1/"),
    people:overrides.people??new GoogleJsonClient("https://people.googleapis.com","/v1/"),
    forms:overrides.forms??new GoogleJsonClient("https://forms.googleapis.com","/v1/"),
    meet:overrides.meet??new GoogleJsonClient("https://meet.googleapis.com","/v2/")
  };
}
function trimResult(value:unknown,limit=16000,depth=0):unknown {
  if(typeof value==="string")return value.slice(0,limit);
  if(typeof value==="number"||typeof value==="boolean"||value===null)return value;
  if(depth>=8)return null;
  if(Array.isArray(value))return value.slice(0,70).map(v=>trimResult(v,limit,depth+1));
  if(value&&typeof value==="object"){
    const result:Record<string,unknown>={};
    for(const [key,val] of Object.entries(value).slice(0,80)){
      if(key==="__proto__"||key==="constructor"||key==="prototype")continue;
      result[key.slice(0,128)]=trimResult(val,limit,depth+1);
    }
    return result;
  }
  return null;
}
const outputSchema=z.object({result:z.record(z.string(),z.unknown())}).strict();
export function registerGoogleWriteCatalogue(
  registry:OperationRegistry,overrides:Partial<Record<Service,GoogleJsonClient>>={}
):void {
  const clients=clientMap(overrides);
  for(const spec of WRITE_SPECS){
    const fields:Record<string,z.ZodTypeAny>={};
    for(const key of pathId(spec.path))fields[key]=itemId;
    Object.assign(fields,spec.shape);
    const inputSchema=z.object(fields).strict();
    registry.register(defineOperation({
      name:spec.name,risk:spec.risk,scopesAnyOf:spec.scope,
      description:"Modify "+spec.name.replaceAll("_"," ")+" in connected Google; "+
        "exact action and full parameters require separate owner approval.",
      inputSchema,outputSchema,
      async run(input,{session}){
        const value=input as Record<string,unknown>;
        if(spec.method==="PATCH" && !spec.payload) {
          throw new OperationError("WRITE_OPERATION_INVALID");
        }
        const data=await clients[spec.service].json({
          path:route(spec.path,value),method:spec.method,
          accessToken:session.accessToken,
          ...(spec.query?{query:typeof spec.query==="function"?spec.query(value):spec.query}:{}),
          ...((spec.method==="POST"||spec.method==="PATCH"||spec.method==="PUT")
            ?{body:spec.payload?spec.payload(value):{}}:{})
        });
        const normalized=trimResult(data);
        return {result:normalized&&typeof normalized==="object"&&!Array.isArray(normalized)
          ? normalized as Record<string,unknown>:{}};
      }
    }));
  }
}
