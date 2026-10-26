import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const temp=await fs.mkdtemp(path.join(os.tmpdir(),"thrifty-app-protocol-"));
const env={...process.env,THRIFTYRELAY_TASK_DIR:path.join(temp,"tasks"),APPDATA:path.join(temp,"appdata"),THRIFTYRELAY_TEST_POLICY_FILE:path.join(temp,"missing-policy.json")};
const transport=new StdioClientTransport({command:process.execPath,args:["--import",pathToFileURL(path.join(import.meta.dirname,"policy-isolation.mjs")).href,path.join(root,"index.mjs")],cwd:root,env,stderr:"pipe"});
transport.stderr?.resume();
const client=new Client({name:"independent-settings-resource-probe",version:"1"},{capabilities:{}});
try{
  await client.connect(transport);
  const tools=(await client.listTools()).tools;
  const open=tools.find(t=>t.name==="open_settings");
  assert(open,"missing open_settings");
  console.log("tool names:",tools.map(x=>x.name).join(", "));
  console.log("ui tool metadata:",JSON.stringify(open._meta));
  const list=await client.listResources();
  console.log("resources:",JSON.stringify(list.resources.map(x=>({uri:x.uri,mimeType:x.mimeType,name:x.name}))));
  const got=await client.readResource({uri:"ui://thriftyrelay/settings-v2.html"});
  const item=got.contents.find(x=>x.uri==="ui://thriftyrelay/settings-v2.html");
  assert(item,"missing UI resource");
  console.log("read resource:",JSON.stringify({mimeType:item.mimeType,bytes:Buffer.byteLength(item.text||""),hasHtml:(item.text||"").startsWith("<!doctype html>"),hasBundle:(item.text||"").includes("settings-app-bundle"),meta:item._meta}));
  assert.equal(item.mimeType,"text/html;profile=mcp-app");
  for(const field of ["fiveHourLimitPercent","weeklyLimitPercent","fiveHourLimitAction","weeklyLimitAction"]) assert((item.text||"").includes(field),"missing rebuilt field "+field);
  const result=await client.callTool({name:"open_settings",arguments:{}});
  console.log("settings result:",JSON.stringify({isError:result.isError,ok:result.structuredContent?.ok,settingsKeys:Object.keys(result.structuredContent?.settings||{})}));
  assert(!result.isError);
  assert.equal(Object.keys(result.structuredContent?.settings||{}).length,9);
  console.log("PASS: Tool linked, resource readable, HTML returned, result valid in isolated local MCP session");
}finally{
  try{await client.close();}catch{}
  await fs.rm(temp,{recursive:true,force:true});
}
