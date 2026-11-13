import * as z from "zod/v4";
import { defineOperation, OperationRegistry } from "../../core/src/index.js";
import { GoogleJsonClient, type QueryValue } from "../../google-http/src/index.js";

/**
 * M22: an explicit catalogue of bounded read methods, not an arbitrary HTTP
 * proxy. All destinations, URL templates, query options and OAuth scopes are
 * hardcoded by the server. Input values cannot select a Google API endpoint.
 *
 * A POST is still a "read" only for specific Google query endpoints that
 * document no side effects (Calendar freeBusy). Writes are not exposed.
 */

const scope = (name: string) => "https://www.googleapis.com/auth/" + name;
const ident = z.string().min(1).max(512).refine(value =>
  !/[\u0000-\u001f/\\]/.test(value) &&
  value !== "." && value !== ".." && !value.includes(".."));
const page = z.number().int().min(1).max(50).default(20);
const cursor = z.string().max(1024).optional();
const queryText = (max: number) => z.string().min(1).max(max).optional();
const isoTime = z.iso.datetime({offset:true});

const listOutput = z.object({
  items:z.array(z.record(z.string(),z.unknown())).max(50),
  nextPageToken:z.string().nullable(),
  partial:z.boolean(),
  truncated:z.boolean(),
  nextSyncToken:z.string().nullable().optional(),
  historyId:z.string().nullable().optional()
}).strict();
const detailOutput = z.object({
  item:z.record(z.string(),z.unknown()),
  truncated:z.boolean()
}).strict();

type Service = "tasks" | "script" | "drive" | "calendar" | "docs" |
  "sheets" | "slides" | "gmail" | "people" | "forms" | "meet";
type ReadClientMap = Record<Service,GoogleJsonClient>;

interface ReadSpec {
  readonly name:string;
  readonly description:string;
  readonly service:Service;
  readonly path:string;
  readonly scopes:readonly string[];
  readonly listKey?:string;
  readonly pageField?:string | null;
  readonly fixed?:Readonly<Record<string, QueryValue>>;
  readonly options?:Readonly<Record<string,z.ZodTypeAny>>;
}

const s = (service:Service, name:string, path:string, scopes:readonly string[],
  listKey?:string, extra:Partial<ReadSpec> = {}):ReadSpec=>({
  service,name,path,scopes,description:
    "Read " + name.replaceAll("_"," ") + " for the connected Google account; " +
    "bounded, scoped, and never modifies provider state.",
  ...(listKey ? {listKey} : {}),...extra
});

const TASK=[scope("tasks")];
const SCRIPT=[scope("script.processes")];
const SCRIPT_METRICS=[scope("script.metrics")];
const SCRIPT_DEPLOY=[scope("script.deployments"),scope("script.projects")];
const DRIVE=[scope("drive")];
const DOCS=[scope("documents"),scope("drive")];
const SHEETS=[scope("spreadsheets"),scope("drive")];
const SLIDES=[scope("presentations"),scope("drive")];
const CAL=[scope("calendar")];
const MAIL=[scope("gmail.modify")];
const DRAFT=[scope("gmail.compose")];
const SETTINGS=[scope("gmail.settings.basic")];
const CONTACTS=[scope("contacts")];
const OTHER=[scope("contacts.other.readonly")];
const FORM=[scope("forms.body")];
const FORM_RESPONSE=[scope("forms.responses.readonly"),scope("drive")];
const MEET=[scope("meetings.space.readonly"),scope("meetings.space.created")];

/** No open-ended URL/body/query proxy: every provider route is enumerated here. */
export const READ_SPECS: readonly ReadSpec[] = Object.freeze([
  // Google Tasks: task-list metadata and richer task pagination.
  s("tasks","tasks_get_tasklist","/tasks/v1/users/@me/lists/:tasklistId",TASK),
  s("tasks","tasks_list_tasks_extended","/tasks/v1/lists/:tasklistId/tasks",TASK,"items",{
    pageField:"maxResults",options:{
      showCompleted:z.boolean().default(true),showHidden:z.boolean().default(false),
      showDeleted:z.boolean().default(false),updatedMin:isoTime.optional()
    }
  }),

  // Google Apps Script: the separate process, deployment and metrics grants.
  s("script","script_list_user_processes","/v1/processes",SCRIPT,"processes"),
  s("script","script_list_script_processes","/v1/processes:listScriptProcesses",SCRIPT,"processes",{
    options:{scriptId:ident}
  }),
  s("script","script_get_metrics","/v1/projects/:scriptId/metrics",SCRIPT_METRICS,undefined,{
    fixed:{metricsGranularity:"DAILY"},
    options:{metricsGranularity:z.enum(["DAILY","WEEKLY"]).default("DAILY")}
  }),
  s("script","script_get_deployment","/v1/projects/:scriptId/deployments/:deploymentId",SCRIPT_DEPLOY),

  // Drive metadata, permissions, activity pointers, change feed and revisions.
  s("drive","drive_get_about","/drive/v3/about",DRIVE,undefined,{
    fixed:{fields:"user(displayName,emailAddress),storageQuota,importFormats,exportFormats"}
  }),
  s("drive","drive_list_file_permissions","/drive/v3/files/:fileId/permissions",DRIVE,"permissions",{
    fixed:{fields:"nextPageToken,permissions(id,type,role,emailAddress,displayName,domain,deleted,expirationTime)"}
  }),
  s("drive","drive_get_file_permission","/drive/v3/files/:fileId/permissions/:permissionId",DRIVE,undefined,{
    fixed:{fields:"id,type,role,emailAddress,displayName,domain,deleted,expirationTime"}
  }),
  s("drive","drive_list_file_comments","/drive/v3/files/:fileId/comments",DRIVE,"comments",{
    fixed:{fields:"nextPageToken,comments(id,content,createdTime,modifiedTime,resolved,author(displayName,emailAddress),replies(id,content,createdTime))"}
  }),
  s("drive","drive_get_file_comment","/drive/v3/files/:fileId/comments/:commentId",DRIVE,undefined,{
    fixed:{fields:"id,content,createdTime,modifiedTime,resolved,author(displayName,emailAddress),replies"}
  }),
  s("drive","drive_list_comment_replies","/drive/v3/files/:fileId/comments/:commentId/replies",DRIVE,"replies",{
    fixed:{fields:"nextPageToken,replies(id,content,createdTime,modifiedTime,action,author(displayName,emailAddress))"}
  }),
  s("drive","drive_list_file_revisions","/drive/v3/files/:fileId/revisions",DRIVE,"revisions",{
    fixed:{fields:"nextPageToken,revisions(id,modifiedTime,mimeType,size,keepForever,lastModifyingUser(displayName,emailAddress))"}
  }),
  s("drive","drive_get_file_revision","/drive/v3/files/:fileId/revisions/:revisionId",DRIVE,undefined,{
    fixed:{fields:"id,modifiedTime,mimeType,size,keepForever,lastModifyingUser(displayName,emailAddress)"}
  }),
  s("drive","drive_get_changes_start_token","/drive/v3/changes/startPageToken",DRIVE),
  s("drive","drive_list_changes","/drive/v3/changes",DRIVE,"changes",{
    pageField:"pageSize",options:{pageToken:z.string().min(1).max(1024)},
    fixed:{fields:"nextPageToken,newStartPageToken,changes(changeType,removed,time,fileId,file(id,name,mimeType,modifiedTime),driveId)"}
  }),
  s("drive","drive_list_shared_drives","/drive/v3/drives",DRIVE,"drives",{
    fixed:{fields:"nextPageToken,drives(id,name,createdTime,hidden)"}
  }),
  s("drive","drive_get_shared_drive","/drive/v3/drives/:driveId",DRIVE,undefined,{
    fixed:{fields:"id,name,createdTime,hidden"}
  }),

  // Docs, Sheets and Slides: tabs, formulas, grid slices and page metadata.
  s("docs","docs_get_document_tabs","/v1/documents/:documentId",DOCS,undefined,{
    fixed:{includeTabsContent:true}
  }),
  s("sheets","sheets_get_formulas","/v4/spreadsheets/:spreadsheetId/values/:range",SHEETS,undefined,{
    fixed:{valueRenderOption:"FORMULA",majorDimension:"ROWS"},
    options:{range:z.string().min(1).max(150)}
  }),
  s("sheets","sheets_get_grid_slice","/v4/spreadsheets/:spreadsheetId",SHEETS,undefined,{
    fixed:{includeGridData:true,fields:"spreadsheetId,sheets(properties(sheetId,title),data(startRow,startColumn,rowData(values(formattedValue,userEnteredValue,effectiveValue))))"},
    options:{ranges:z.string().min(1).max(150)}
  }),
  s("sheets","sheets_get_developer_metadata","/v4/spreadsheets/:spreadsheetId/developerMetadata/:metadataId",SHEETS),
  s("slides","slides_get_page","/v1/presentations/:presentationId/pages/:pageObjectId",SLIDES),
  s("slides","slides_get_page_thumbnail","/v1/presentations/:presentationId/pages/:pageObjectId/thumbnail",SLIDES),

  // Calendar: event details, instances, settings, access controls and colors.
  s("calendar","calendar_get_event","/calendar/v3/calendars/:calendarId/events/:eventId",CAL),
  s("calendar","calendar_list_event_instances","/calendar/v3/calendars/:calendarId/events/:eventId/instances",CAL,"items",{
    pageField:"maxResults",options:{timeMin:isoTime.optional(),timeMax:isoTime.optional()}
  }),
  s("calendar","calendar_get_calendar","/calendar/v3/calendars/:calendarId",CAL),
  s("calendar","calendar_list_settings","/calendar/v3/users/me/settings",CAL,"items",{pageField:"maxResults"}),
  s("calendar","calendar_get_setting","/calendar/v3/users/me/settings/:settingId",CAL),
  s("calendar","calendar_list_access_rules","/calendar/v3/calendars/:calendarId/acl",CAL,"items",{pageField:"maxResults"}),
  s("calendar","calendar_get_access_rule","/calendar/v3/calendars/:calendarId/acl/:ruleId",CAL),
  s("calendar","calendar_get_colors","/calendar/v3/colors",CAL),

  // Gmail: messages/threads/drafts, history and non-mutating mailbox settings.
  s("gmail","gmail_get_profile","/gmail/v1/users/me/profile",MAIL),
  s("gmail","gmail_get_message_full","/gmail/v1/users/me/messages/:messageId",MAIL,undefined,{
    fixed:{format:"full"}
  }),
  s("gmail","gmail_list_threads","/gmail/v1/users/me/threads",MAIL,"threads",{
    pageField:"maxResults",options:{q:queryText(512),labelIds:queryText(256)}
  }),
  s("gmail","gmail_get_thread","/gmail/v1/users/me/threads/:threadId",MAIL,undefined,{
    fixed:{format:"full"}
  }),
  s("gmail","gmail_list_drafts","/gmail/v1/users/me/drafts",DRAFT,"drafts",{pageField:"maxResults"}),
  s("gmail","gmail_get_draft","/gmail/v1/users/me/drafts/:draftId",DRAFT,undefined,{
    fixed:{format:"full"}
  }),
  s("gmail","gmail_get_label","/gmail/v1/users/me/labels/:labelId",MAIL),
  s("gmail","gmail_list_history","/gmail/v1/users/me/history",MAIL,"history",{
    pageField:"maxResults",options:{startHistoryId:z.string().min(1).max(80),labelId:queryText(128)}
  }),
  s("gmail","gmail_get_settings_vacation","/gmail/v1/users/me/settings/vacation",SETTINGS),
  s("gmail","gmail_get_settings_imap","/gmail/v1/users/me/settings/imap",SETTINGS),
  s("gmail","gmail_get_settings_pop","/gmail/v1/users/me/settings/pop",SETTINGS),
  s("gmail","gmail_get_settings_language","/gmail/v1/users/me/settings/language",SETTINGS),
  s("gmail","gmail_get_settings_auto_forwarding","/gmail/v1/users/me/settings/autoForwarding",SETTINGS),
  s("gmail","gmail_list_settings_filters","/gmail/v1/users/me/settings/filters",SETTINGS,"filter",{
    pageField:null
  }),
  s("gmail","gmail_get_settings_filter","/gmail/v1/users/me/settings/filters/:filterId",SETTINGS),
  s("gmail","gmail_list_forwarding_addresses","/gmail/v1/users/me/settings/forwardingAddresses",SETTINGS,"forwardingAddresses",{
    pageField:null
  }),
  s("gmail","gmail_list_send_as","/gmail/v1/users/me/settings/sendAs",SETTINGS,"sendAs",{
    pageField:null
  }),
  s("gmail","gmail_get_send_as","/gmail/v1/users/me/settings/sendAs/:sendAsEmail",SETTINGS),
  s("gmail","gmail_list_delegates","/gmail/v1/users/me/settings/delegates",SETTINGS,"delegates",{
    pageField:null
  }),

  // People: contact details, contact groups, named search and other contacts.
  s("people","contacts_get_person","/v1/people/:personId",CONTACTS,undefined,{
    fixed:{personFields:"names,emailAddresses,phoneNumbers,organizations,addresses,biographies,metadata"}
  }),
  s("people","contacts_search_contacts","/v1/people:searchContacts",CONTACTS,"results",{
    options:{query:z.string().min(1).max(256)},
    fixed:{readMask:"names,emailAddresses,phoneNumbers,organizations"}
  }),
  s("people","contacts_list_contact_groups","/v1/contactGroups",CONTACTS,"contactGroups",{
    fixed:{groupFields:"name,groupType,memberCount,metadata"}
  }),
  s("people","contacts_get_contact_group","/v1/contactGroups/:groupId",CONTACTS,undefined,{
    fixed:{maxMembers:50}
  }),
  s("people","contacts_list_other_contacts","/v1/otherContacts",OTHER,"otherContacts",{
    fixed:{readMask:"names,emailAddresses,phoneNumbers,metadata"}
  }),

  // Forms response details and project watches, read only.
  s("forms","forms_get_response","/v1/forms/:formId/responses/:responseId",FORM_RESPONSE),
  s("forms","forms_list_watches","/v1/forms/:formId/watches",FORM,"watches",{pageField:null}),

  // Meet conference evidence, participant sessions and transcript metadata.
  s("meet","meet_get_conference_record","/v2/conferenceRecords/:conferenceId",MEET),
  s("meet","meet_list_participants","/v2/conferenceRecords/:conferenceId/participants",MEET,"participants"),
  s("meet","meet_get_participant","/v2/conferenceRecords/:conferenceId/participants/:participantId",MEET),
  s("meet","meet_list_participant_sessions","/v2/conferenceRecords/:conferenceId/participants/:participantId/participantSessions",MEET,"participantSessions"),
  s("meet","meet_list_recordings","/v2/conferenceRecords/:conferenceId/recordings",MEET,"recordings"),
  s("meet","meet_get_recording","/v2/conferenceRecords/:conferenceId/recordings/:recordingId",MEET),
  s("meet","meet_list_transcripts","/v2/conferenceRecords/:conferenceId/transcripts",MEET,"transcripts"),
  s("meet","meet_get_transcript","/v2/conferenceRecords/:conferenceId/transcripts/:transcriptId",MEET),
  s("meet","meet_list_transcript_entries","/v2/conferenceRecords/:conferenceId/transcripts/:transcriptId/entries",MEET,"transcriptEntries"),
  s("meet","meet_list_smart_notes","/v2/conferenceRecords/:conferenceId/smartNotes",MEET,"smartNotes"),
  s("meet","meet_list_members","/v2/spaces/:spaceId/members",MEET,"members"),
  s("meet","meet_get_member","/v2/spaces/:spaceId/members/:memberId",MEET)
]);

function buildClients(overrides: Partial<ReadClientMap>): ReadClientMap {
  const google = "https://www.googleapis.com";
  return {
    tasks:overrides.tasks ?? new GoogleJsonClient("https://tasks.googleapis.com","/tasks/v1/"),
    script:overrides.script ?? new GoogleJsonClient("https://script.googleapis.com","/v1/"),
    drive:overrides.drive ?? new GoogleJsonClient(google,"/drive/v3/"),
    calendar:overrides.calendar ?? new GoogleJsonClient(google,"/calendar/v3/"),
    docs:overrides.docs ?? new GoogleJsonClient("https://docs.googleapis.com","/v1/"),
    sheets:overrides.sheets ?? new GoogleJsonClient("https://sheets.googleapis.com","/v4/"),
    slides:overrides.slides ?? new GoogleJsonClient("https://slides.googleapis.com","/v1/"),
    gmail:overrides.gmail ?? new GoogleJsonClient("https://gmail.googleapis.com","/gmail/v1/"),
    people:overrides.people ?? new GoogleJsonClient("https://people.googleapis.com","/v1/"),
    forms:overrides.forms ?? new GoogleJsonClient("https://forms.googleapis.com","/v1/"),
    meet:overrides.meet ?? new GoogleJsonClient("https://meet.googleapis.com","/v2/")
  };
}

/** Bound nested objects to prevent one provider page becoming an unbounded MCP message. */
function compact(value:unknown, meter:{remaining:number,truncated:boolean}, depth=0):unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const take=Math.min(value.length,32768,Math.max(0,meter.remaining));
    if(take<value.length)meter.truncated=true;
    meter.remaining-=take;
    return value.slice(0,take);
  }
  if (depth >= 10) {meter.truncated=true;return null;}
  if (Array.isArray(value)) {
    if(value.length>100)meter.truncated=true;
    return value.slice(0,100).map(item=>compact(item,meter,depth+1));
  }
  if (typeof value === "object" && value) {
    const entries=Object.entries(value as Record<string,unknown>);
    if(entries.length>100)meter.truncated=true;
    const out:Record<string,unknown>={};
    for(const [key,part] of entries.slice(0,100)){
      if(key==="__proto__" || key==="prototype" || key==="constructor") continue;
      out[key.slice(0,256)]=compact(part,meter,depth+1);
    }
    return out;
  }
  return null;
}
function safeRecord(raw:unknown,meter:{remaining:number,truncated:boolean}):Record<string,unknown> {
  const value=compact(raw,meter);
  return value && typeof value==="object" && !Array.isArray(value)
    ? value as Record<string,unknown> : {};
}
function asString(value:unknown):string|null {
  return typeof value==="string" ? value.slice(0,1024) || null : null;
}
function defineInputs(spec:ReadSpec) {
  const shape:Record<string,z.ZodTypeAny> = {};
  for(const token of spec.path.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g)) {
    shape[token[1]]=ident;
  }
  if(spec.listKey) {
    if(spec.pageField!==null) {
      shape.pageSize=page;
      shape.pageToken=cursor;
    }
  }
  for(const [key,val] of Object.entries(spec.options??{}))shape[key]=val;
  return z.object(shape).strict();
}
function substitutePath(template:string, input:Record<string,unknown>):string {
  return template.replace(/:([A-Za-z][A-Za-z0-9]*)/g,(_full,key:string)=>{
    const value=input[key];
    if(typeof value!=="string")throw new Error("Validated path parameter missing");
    return encodeURIComponent(value);
  });
}

export function registerGoogleReadCatalogue(
  registry:OperationRegistry, overrides:Partial<ReadClientMap>={}
):void {
  const clients=buildClients(overrides);
  for(const spec of READ_SPECS) {
    const schema=defineInputs(spec);
    registry.register(defineOperation({
      name:spec.name,description:spec.description,
      inputSchema:schema,
      outputSchema:spec.listKey ? listOutput : detailOutput,
      scopesAnyOf:spec.scopes,risk:"read",
      async run(parsed, {session}) {
        const input=parsed as Record<string,unknown>;
        const query:Record<string,QueryValue>={...spec.fixed};
        if(spec.listKey && spec.pageField!==null) {
          query[spec.pageField ?? "pageSize"]=input.pageSize as number;
          query.pageToken=input.pageToken as string|undefined;
        }
        for(const key of Object.keys(spec.options??{})){
          // A path parameter is not also a provider query option.
          if(spec.path.includes(":"+key)) continue;
          const v=input[key];
          if(typeof v==="string" || typeof v==="number" || typeof v==="boolean"){
            query[key]=v;
          }
        }
        const result=await clients[spec.service].json({
          path:substitutePath(spec.path,input),
          query,accessToken:session.accessToken
        });
        const meter={remaining:95000,truncated:false};
        if(spec.listKey){
          const items=Array.isArray(result[spec.listKey]) ?
            result[spec.listKey] as unknown[] : [];
          const limit=spec.pageField===null ? 50 : Number(input.pageSize ?? 20);
          if(items.length>limit)meter.truncated=true;
          const sanitized=items.slice(0,limit).map(item=>safeRecord(item,meter));
          const nextPageToken=asString(result.nextPageToken);
          return {
            items:sanitized,nextPageToken,
            partial:nextPageToken!==null || items.length>limit,
            truncated:meter.truncated,
            ...(result.nextSyncToken?{nextSyncToken:asString(result.nextSyncToken)}:{}),
            ...(result.historyId?{historyId:asString(result.historyId)}:{})
          };
        }
        return {item:safeRecord(result,meter),truncated:meter.truncated};
      }
    }));
  }

  // Google's Calendar freeBusy QUERY is a side-effect-free POST, never a
  // generic POST tool. The target and body fields are explicitly fixed.
  const freebusyInput=z.object({
    calendarIds:z.array(ident).min(1).max(10),
    timeMin:isoTime,timeMax:isoTime,
    timeZone:z.string().min(1).max(80).optional()
  }).strict();
  registry.register(defineOperation({
    name:"calendar_query_freebusy",
    description:"Query free/busy intervals for up to ten calendars in a bounded interval; read-only.",
    inputSchema:freebusyInput,outputSchema:detailOutput,
    scopesAnyOf:CAL,risk:"read",
    async run(input,{session}){
      if(Date.parse(input.timeMax)<=Date.parse(input.timeMin)) {
        throw new Error("Invalid time interval");
      }
      const response=await clients.calendar.json({
        path:"/calendar/v3/freeBusy",method:"POST",accessToken:session.accessToken,
        body:{timeMin:input.timeMin,timeMax:input.timeMax,timeZone:input.timeZone,
          items:input.calendarIds.map(id=>({id}))}
      });
      const meter={remaining:95000,truncated:false};
      return {item:safeRecord(response,meter),truncated:meter.truncated};
    }
  }));
}
