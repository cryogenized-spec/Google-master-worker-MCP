import * as z from "zod/v4";
import { defineOperation, OperationRegistry } from "../../core/src/index.js";
import { GoogleJsonClient } from "../../google-http/src/index.js";

/**
 * M19: broad, fixed-endpoint Google Workspace registry.
 * Existing operator OAuth has already granted the personal 23-scope bundle.
 * Each operation is typed; no generic Google API/URL proxy exists.
 * Mutation operations may be registered, but the remote MCP is READ-ONLY
 * until an independent host-issued one-use approval service is deployed.
 */
const ROOT = "https://www.googleapis.com/auth/";
const scope = (s: string) => ROOT + s;
const id = z.string().min(1).max(512)
  .refine(s => !/[\u0000-\u001f]/.test(s) && s !== "." && s !== "..");
const text = (max = 512) => z.string().max(max);
const page = z.number().int().min(1).max(100).default(25);
const token = z.string().max(1024).optional();
const enc = (s: string) => encodeURIComponent(s);
const str = (value: unknown, n = 512): string =>
  typeof value === "string" ? value.slice(0, n) : "";
const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ?
    value as Record<string, unknown> : {};
const arr = (value: unknown, max: number): Record<string, unknown>[] =>
  (Array.isArray(value) ? value : []).slice(0, max).map(obj);
const next = (value: Record<string, unknown>) => str(value.nextPageToken,1024) || null;
const listOutput = z.object({
  items:z.array(z.record(z.string(),z.unknown())).max(100),
  nextPageToken:z.string().nullable()
}).strict();
const itemOutput = z.object({
  item:z.record(z.string(),z.unknown())
}).strict();
const mutationOutput = z.object({
  result:z.record(z.string(),z.unknown())
}).strict();
const pageInput = z.object({pageSize:page,pageToken:token}).strict();

/* Each GoogleJsonClient has a pinned HTTPS origin and path prefix.
   Google returns dynamic resource fields; item metadata is projected into
   safe bounded shapes without mirroring credentials/provider errors. */
export function registerWorkspaceServices(registry: OperationRegistry, transports: {
  drive?:GoogleJsonClient, driveActivity?:GoogleJsonClient, docs?:GoogleJsonClient,
  sheets?:GoogleJsonClient, slides?:GoogleJsonClient, calendar?:GoogleJsonClient,
  gmail?:GoogleJsonClient, people?:GoogleJsonClient, forms?:GoogleJsonClient,
  meet?:GoogleJsonClient
} = {}): void {
  const drive=transports.drive ?? new GoogleJsonClient("https://www.googleapis.com","/drive/v3/");
  const activity=transports.driveActivity ?? new GoogleJsonClient("https://driveactivity.googleapis.com","/v2/");
  const docs=transports.docs ?? new GoogleJsonClient("https://docs.googleapis.com","/v1/");
  const sheets=transports.sheets ?? new GoogleJsonClient("https://sheets.googleapis.com","/v4/");
  const slides=transports.slides ?? new GoogleJsonClient("https://slides.googleapis.com","/v1/");
  const calendar=transports.calendar ?? new GoogleJsonClient("https://www.googleapis.com","/calendar/v3/");
  const gmail=transports.gmail ?? new GoogleJsonClient("https://gmail.googleapis.com","/gmail/v1/");
  const people=transports.people ?? new GoogleJsonClient("https://people.googleapis.com","/v1/");
  const forms=transports.forms ?? new GoogleJsonClient("https://forms.googleapis.com","/v1/");
  const meet=transports.meet ?? new GoogleJsonClient("https://meet.googleapis.com","/v2/");

  registry.register(defineOperation({
    name:"drive_list_files", description:"Search a bounded page of Drive files, including folders and documents; no file contents.",
    inputSchema:z.object({pageSize:page,pageToken:token,query:text(500).optional()}).strict(),
    outputSchema:listOutput,scopesAnyOf:[scope("drive")],risk:"read",
    async run(input,{session}){
      const data=await drive.json({path:"/drive/v3/files",accessToken:session.accessToken,
        query:{pageSize:input.pageSize,pageToken:input.pageToken,q:input.query,
          fields:"nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink,parents,description),incompleteSearch"}});
      return {items:arr(data.files,input.pageSize).map(f=>({
        id:str(f.id),name:str(f.name,1024),mimeType:str(f.mimeType),
        modifiedTime:str(f.modifiedTime,64),webViewLink:str(f.webViewLink,2048),
        description:str(f.description,1024),parents:Array.isArray(f.parents)?f.parents.slice(0,20):[]
      })),nextPageToken:next(data)};
    }
  }));
  registry.register(defineOperation({
    name:"drive_get_file", description:"Read Drive file metadata by ID; does not download private file content.",
    inputSchema:z.object({fileId:id}).strict(),outputSchema:itemOutput,
    scopesAnyOf:[scope("drive")],risk:"read",
    async run(input,{session}){
      const f=await drive.json({path:"/drive/v3/files/"+enc(input.fileId),accessToken:session.accessToken,
        query:{fields:"id,name,mimeType,modifiedTime,size,description,webViewLink,parents,owners,permissions"}});
      return {item:{id:str(f.id),name:str(f.name,1024),mimeType:str(f.mimeType),
        modifiedTime:str(f.modifiedTime,64),size:str(f.size,32),
        description:str(f.description,2048),webViewLink:str(f.webViewLink,2048),
        parents:Array.isArray(f.parents)?f.parents.slice(0,20):[],
        owners:Array.isArray(f.owners)?f.owners.slice(0,20).map(o=>({
          displayName:str(obj(o).displayName),emailAddress:str(obj(o).emailAddress)
        })):[]}};
    }
  }));
  registry.register(defineOperation({
    name:"drive_query_activity",description:"Read recent Drive Activity records for a specified Drive item.",
    inputSchema:z.object({itemName:text(600),pageSize:page,pageToken:token}).strict(),
    outputSchema:listOutput,scopesAnyOf:[scope("drive.activity.readonly")],risk:"read",
    async run(input,{session}){
      const data=await activity.json({path:"/v2/activity:query",method:"POST",
        accessToken:session.accessToken,body:{
          itemName:input.itemName,pageSize:input.pageSize,pageToken:input.pageToken
        }});
      return {items:arr(data.activities,input.pageSize).map(a=>({
        primaryActionDetail:obj(a.primaryActionDetail),
        timestamp:str(a.timestamp,64),timeRange:obj(a.timeRange),
        targets:arr(a.targets,20).map(t=>({driveItem:obj(t.driveItem)}))
      })),nextPageToken:next(data)};
    }
  }));
  registry.register(defineOperation({
    name:"docs_get_document",description:"Read the title, revision and bounded plain-text paragraphs of a Google Doc by ID.",
    inputSchema:z.object({documentId:id}).strict(),outputSchema:itemOutput,
    scopesAnyOf:[scope("documents"),scope("drive")],risk:"read",
    async run(input,{session}){
      const d=await docs.json({path:"/v1/documents/"+enc(input.documentId),
        accessToken:session.accessToken,
        query:{fields:"documentId,title,revisionId,body(content(paragraph(elements(textRun(content)))))"}});
      let remaining=32000; const paragraphs:string[]=[];
      for(const node of arr(obj(d.body).content,2000)){
        const elements=arr(obj(node.paragraph).elements,1000);
        const contents=elements.map(e=>str(obj(e.textRun).content,8192)).join("");
        if(contents && remaining>0){
          paragraphs.push(contents.slice(0,remaining));
          remaining-=contents.length;
        }
        if(remaining<=0 || paragraphs.length>=400) break;
      }
      return {item:{documentId:str(d.documentId),title:str(d.title,1024),
        revisionId:str(d.revisionId,256),paragraphs,truncated:remaining<=0}};
    }
  }));
  registry.register(defineOperation({
    name:"sheets_get_spreadsheet",description:"Get Sheets workbook title and tab metadata without downloading cell values.",
    inputSchema:z.object({spreadsheetId:id}).strict(),outputSchema:itemOutput,
    scopesAnyOf:[scope("spreadsheets"),scope("drive")],risk:"read",
    async run(input,{session}){
      const d=await sheets.json({path:"/v4/spreadsheets/"+enc(input.spreadsheetId),
        accessToken:session.accessToken,query:{
          fields:"spreadsheetId,spreadsheetUrl,properties(title),sheets(properties(sheetId,title,gridProperties))"}});
      return {item:{spreadsheetId:str(d.spreadsheetId),
        spreadsheetUrl:str(d.spreadsheetUrl,2048),title:str(obj(d.properties).title,1024),
        sheets:arr(d.sheets,100).map(s=>({sheetId:obj(s.properties).sheetId,
          title:str(obj(s.properties).title),gridProperties:obj(obj(s.properties).gridProperties)}))}};
    }
  }));
  registry.register(defineOperation({
    name:"sheets_get_values",description:"Read a bounded A1 range of cell values from one Google Sheets workbook.",
    inputSchema:z.object({spreadsheetId:id,range:z.string().min(1).max(128),
      valueRenderOption:z.enum(["FORMATTED_VALUE","UNFORMATTED_VALUE"]).default("FORMATTED_VALUE")}).strict(),
    outputSchema:itemOutput,scopesAnyOf:[scope("spreadsheets"),scope("drive")],risk:"read",
    async run(input,{session}){
      const d=await sheets.json({path:"/v4/spreadsheets/"+enc(input.spreadsheetId)+
        "/values/"+enc(input.range),accessToken:session.accessToken,
        query:{valueRenderOption:input.valueRenderOption,majorDimension:"ROWS"}});
      return {item:{range:str(d.range,256),majorDimension:str(d.majorDimension),
        values:Array.isArray(d.values)?d.values.slice(0,500).map(row=>
          Array.isArray(row)?row.slice(0,60):[]):[]}};
    }
  }));
  registry.register(defineOperation({
    name:"slides_get_presentation",description:"Read presentation title, slide IDs and bounded slide text.",
    inputSchema:z.object({presentationId:id}).strict(),outputSchema:itemOutput,
    scopesAnyOf:[scope("presentations"),scope("drive")],risk:"read",
    async run(input,{session}){
      const d=await slides.json({path:"/v1/presentations/"+enc(input.presentationId),
        accessToken:session.accessToken,query:{fields:
          "presentationId,title,slides(objectId,pageElements(shape(text(textElements(textRun(content))))))"}});
      return {item:{presentationId:str(d.presentationId),title:str(d.title,1024),
        slides:arr(d.slides,100).map(slide=>({
          objectId:str(slide.objectId),
          text:arr(slide.pageElements,200).flatMap(el=>
            arr(obj(obj(el.shape).text).textElements,300)
              .map(t=>str(obj(t.textRun).content,4000)))
              .join("").slice(0,8000)
        }))}};
    }
  }));
  registry.register(defineOperation({
    name:"calendar_list_calendars",description:"List accessible Google calendars with time zone and access role.",
    inputSchema:pageInput,outputSchema:listOutput,
    scopesAnyOf:[scope("calendar")],risk:"read",
    async run(input,{session}){
      const d=await calendar.json({path:"/calendar/v3/users/me/calendarList",
        accessToken:session.accessToken,
        query:{maxResults:input.pageSize,pageToken:input.pageToken}});
      return {items:arr(d.items,input.pageSize).map(c=>({
        id:str(c.id),summary:str(c.summary,1024),timeZone:str(c.timeZone),
        accessRole:str(c.accessRole),primary:c.primary===true
      })),nextPageToken:next(d)};
    }
  }));
  registry.register(defineOperation({
    name:"calendar_list_events",description:"List events from one calendar in a bounded window; no modifications.",
    inputSchema:z.object({calendarId:id,pageSize:page,pageToken:token,
      timeMin:z.iso.datetime({offset:true}).optional(),
      timeMax:z.iso.datetime({offset:true}).optional(),
      query:text(500).optional()}).strict(),outputSchema:listOutput,
    scopesAnyOf:[scope("calendar")],risk:"read",
    async run(input,{session}){
      const d=await calendar.json({path:"/calendar/v3/calendars/"+enc(input.calendarId)+"/events",
        accessToken:session.accessToken,
        query:{maxResults:input.pageSize,pageToken:input.pageToken,
          timeMin:input.timeMin,timeMax:input.timeMax,q:input.query,
          singleEvents:true,orderBy:"startTime"}});
      return {items:arr(d.items,input.pageSize).map(e=>({
        id:str(e.id),summary:str(e.summary,1024),description:str(e.description,8192),
        location:str(e.location,1024),start:obj(e.start),end:obj(e.end),
        status:str(e.status),htmlLink:str(e.htmlLink,2048)
      })),nextPageToken:next(d)};
    }
  }));
  registry.register(defineOperation({
    name:"gmail_list_messages",description:"Search a bounded page of Gmail message IDs by Gmail query.",
    inputSchema:z.object({query:text(512).optional(),pageSize:page,pageToken:token}).strict(),
    outputSchema:listOutput,scopesAnyOf:[scope("gmail.modify")],risk:"read",
    async run(input,{session}){
      const d=await gmail.json({path:"/gmail/v1/users/me/messages",accessToken:session.accessToken,
        query:{maxResults:input.pageSize,pageToken:input.pageToken,q:input.query}});
      return {items:arr(d.messages,input.pageSize).map(m=>({
        id:str(m.id),threadId:str(m.threadId)
      })),nextPageToken:next(d)};
    }
  }));
  registry.register(defineOperation({
    name:"gmail_get_message",description:"Get one Gmail message's snippet, labels and selected headers; no attachments.",
    inputSchema:z.object({messageId:id}).strict(),outputSchema:itemOutput,
    scopesAnyOf:[scope("gmail.modify")],risk:"read",
    async run(input,{session}){
      const m=await gmail.json({path:"/gmail/v1/users/me/messages/"+enc(input.messageId),
        accessToken:session.accessToken,query:{format:"METADATA"}});
      const headers=arr(obj(m.payload).headers,150).filter(h=>
        ["subject","from","to","date","reply-to","cc"].includes(str(h.name).toLowerCase()));
      return {item:{id:str(m.id),threadId:str(m.threadId),
        snippet:str(m.snippet,8192),internalDate:str(m.internalDate,48),
        labelIds:Array.isArray(m.labelIds)?m.labelIds.slice(0,100):[],
        headers:headers.map(h=>({name:str(h.name),value:str(h.value,2048)}))}};
    }
  }));
  registry.register(defineOperation({
    name:"gmail_list_labels",description:"List Gmail labels without reading email content.",
    inputSchema:z.object({}).strict(),outputSchema:listOutput,
    scopesAnyOf:[scope("gmail.labels"),scope("gmail.modify")],risk:"read",
    async run(_input,{session}){
      const d=await gmail.json({path:"/gmail/v1/users/me/labels",accessToken:session.accessToken});
      return {items:arr(d.labels,100).map(l=>({
        id:str(l.id),name:str(l.name,1024),type:str(l.type),
        messagesTotal:l.messagesTotal??null,messagesUnread:l.messagesUnread??null
      })),nextPageToken:null};
    }
  }));
  registry.register(defineOperation({
    name:"contacts_list_connections",description:"List a bounded page of the signed-in user's Google Contacts.",
    inputSchema:pageInput,outputSchema:listOutput,
    scopesAnyOf:[scope("contacts")],risk:"read",
    async run(input,{session}){
      const d=await people.json({path:"/v1/people/me/connections",
        accessToken:session.accessToken,
        query:{pageSize:input.pageSize,pageToken:input.pageToken,
          personFields:"names,emailAddresses,phoneNumbers"}});
      return {items:arr(d.connections,input.pageSize).map(p=>({
        resourceName:str(p.resourceName),
        names:arr(p.names,10).map(n=>str(n.displayName,1024)),
        emailAddresses:arr(p.emailAddresses,15).map(e=>str(e.value,512)),
        phoneNumbers:arr(p.phoneNumbers,15).map(n=>str(n.value,128))
      })),nextPageToken:next(d)};
    }
  }));
  registry.register(defineOperation({
    name:"forms_get_form",description:"Read form title, ID and question metadata for a known Google Form.",
    inputSchema:z.object({formId:id}).strict(),outputSchema:itemOutput,
    scopesAnyOf:[scope("forms.body")],risk:"read",
    async run(input,{session}){
      const d=await forms.json({path:"/v1/forms/"+enc(input.formId),
        accessToken:session.accessToken});
      return {item:{formId:str(d.formId),title:str(obj(d.info).title,1024),
        description:str(obj(d.info).description,2048),
        items:arr(d.items,100).map(i=>({itemId:str(i.itemId),
          title:str(i.title,1024),description:str(i.description,1024),
          questionItem:obj(i.questionItem)}))}};
    }
  }));
  registry.register(defineOperation({
    name:"forms_list_responses",description:"Read one bounded page of Form response IDs and their answers.",
    inputSchema:z.object({formId:id,pageSize:page,pageToken:token}).strict(),
    outputSchema:listOutput,scopesAnyOf:[scope("forms.responses.readonly")],risk:"read",
    async run(input,{session}){
      const d=await forms.json({path:"/v1/forms/"+enc(input.formId)+"/responses",
        accessToken:session.accessToken,
        query:{pageSize:input.pageSize,pageToken:input.pageToken}});
      return {items:arr(d.responses,input.pageSize).map(r=>({
        responseId:str(r.responseId),createTime:str(r.createTime,64),
        lastSubmittedTime:str(r.lastSubmittedTime,64),answers:obj(r.answers)
      })),nextPageToken:next(d)};
    }
  }));
  registry.register(defineOperation({
    name:"meet_list_conferences",description:"List bounded Google Meet conference records.",
    inputSchema:pageInput,outputSchema:listOutput,
    scopesAnyOf:[scope("meetings.space.readonly")],risk:"read",
    async run(input,{session}){
      const d=await meet.json({path:"/v2/conferenceRecords",accessToken:session.accessToken,
        query:{pageSize:input.pageSize,pageToken:input.pageToken}});
      return {items:arr(d.conferenceRecords,input.pageSize).map(r=>({
        name:str(r.name),startTime:str(r.startTime,64),endTime:str(r.endTime,64),
        space:str(r.space)
      })),nextPageToken:next(d)};
    }
  }));
  registry.register(defineOperation({
    name:"meet_get_space",description:"Read Google Meet space settings and meeting URI by exact space ID.",
    inputSchema:z.object({spaceName:z.string().regex(/^spaces\/[A-Za-z0-9_-]{1,256}$/)}).strict(),
    outputSchema:itemOutput,scopesAnyOf:[
      scope("meetings.space.created"),scope("meetings.space.settings"),
      scope("meetings.space.readonly")],risk:"read",
    async run(input,{session}){
      const d=await meet.json({path:"/v2/"+input.spaceName,accessToken:session.accessToken});
      return {item:{name:str(d.name),meetingUri:str(d.meetingUri,2048),
        meetingCode:str(d.meetingCode,64),config:obj(d.config)}};
    }
  }));

  // Mutations are built into the core from the outset, but NEVER surfaced
  // remotely without independent, exact-action, one-use trusted approval.
  registry.register(defineOperation({
    name:"drive_create_folder", description:"Create a Drive folder only with independent write approval.",
    inputSchema:z.object({name:z.string().trim().min(1).max(256),
      parentId:id.optional()}).strict(),outputSchema:mutationOutput,
    scopesAnyOf:[scope("drive")],risk:"write",
    async run(input,{session}){
      const d=await drive.json({path:"/drive/v3/files",method:"POST",
        accessToken:session.accessToken,query:{fields:"id,name,mimeType,webViewLink"},
        body:{name:input.name,mimeType:"application/vnd.google-apps.folder",
          ...(input.parentId?{parents:[input.parentId]}:{})}});
      return {result:{id:str(d.id),name:str(d.name),mimeType:str(d.mimeType)}};
    }
  }));
  registry.register(defineOperation({
    name:"calendar_create_event",description:"Create a Google Calendar event only with independent write approval.",
    inputSchema:z.object({calendarId:id,summary:z.string().trim().min(1).max(256),
      start:z.iso.datetime({offset:true}),end:z.iso.datetime({offset:true}),
      description:text(4000).optional(),location:text(1024).optional()}).strict(),
    outputSchema:mutationOutput,scopesAnyOf:[scope("calendar")],risk:"write",
    async run(input,{session}){
      const d=await calendar.json({path:"/calendar/v3/calendars/"+enc(input.calendarId)+"/events",
        method:"POST",accessToken:session.accessToken,
        body:{summary:input.summary,description:input.description,
          location:input.location,start:{dateTime:input.start},end:{dateTime:input.end}}});
      return {result:{id:str(d.id),summary:str(d.summary),htmlLink:str(d.htmlLink,2048)}};
    }
  }));
  registry.register(defineOperation({
    name:"sheets_update_values",description:"Replace one bounded Sheets range after exact-action write approval.",
    inputSchema:z.object({spreadsheetId:id,range:z.string().min(1).max(128),
      values:z.array(z.array(z.union([z.string().max(4096),z.number(),z.boolean()])).max(30))
        .min(1).max(100)}).strict(),outputSchema:mutationOutput,
    scopesAnyOf:[scope("spreadsheets")],risk:"write",
    async run(input,{session}){
      const d=await sheets.json({path:"/v4/spreadsheets/"+enc(input.spreadsheetId)+
        "/values/"+enc(input.range),method:"PUT",accessToken:session.accessToken,
        query:{valueInputOption:"USER_ENTERED"},
        body:{range:input.range,majorDimension:"ROWS",values:input.values}});
      return {result:{updatedRange:str(d.updatedRange),updatedCells:d.updatedCells??0}};
    }
  }));
  registry.register(defineOperation({
    name:"gmail_create_draft",description:"Create an unsent Gmail draft using encoded RFC 5322 mail, only with trusted approval.",
    inputSchema:z.object({rawBase64Url:z.string().regex(/^[A-Za-z0-9_-]{16,100000}$/)}).strict(),
    outputSchema:mutationOutput,scopesAnyOf:[scope("gmail.compose")],risk:"write",
    async run(input,{session}){
      const d=await gmail.json({path:"/gmail/v1/users/me/drafts",method:"POST",
        accessToken:session.accessToken,body:{message:{raw:input.rawBase64Url}}});
      return {result:{id:str(d.id),messageId:str(obj(d.message).id)}};
    }
  }));
  registry.register(defineOperation({
    name:"gmail_send_message",description:"Send an email externally; requires independently approved exact RFC 5322 message.",
    inputSchema:z.object({rawBase64Url:z.string().regex(/^[A-Za-z0-9_-]{16,100000}$/)}).strict(),
    outputSchema:mutationOutput,scopesAnyOf:[scope("gmail.send")],risk:"external",
    async run(input,{session}){
      const d=await gmail.json({path:"/gmail/v1/users/me/messages/send",method:"POST",
        accessToken:session.accessToken,body:{raw:input.rawBase64Url}});
      return {result:{id:str(d.id),threadId:str(d.threadId)}};
    }
  }));
}
