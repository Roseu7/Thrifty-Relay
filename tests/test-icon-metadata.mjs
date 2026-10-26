import assert from "node:assert/strict";
import fs from "node:fs/promises"; import os from "node:os"; import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const temp=await fs.mkdtemp(path.join(os.tmpdir(),"tr-icon-check-"));
const transport=new StdioClientTransport({command:process.execPath,args:["--import",pathToFileURL(path.join(import.meta.dirname,"policy-isolation.mjs")).href,path.join(root,"index.mjs")],cwd:root,env:{...process.env,THRIFTYRELAY_TASK_DIR:path.join(temp,"tasks"),APPDATA:path.join(temp,"appdata"),THRIFTYRELAY_TEST_POLICY_FILE:path.join(temp,"missing-policy.json")},stderr:"pipe"});
transport.stderr?.resume();
const c=new Client({name:"icon-protocol-probe",version:"1"},{capabilities:{}});
try{
 await c.connect(transport);
 const tools=(await c.listTools()).tools;
 const summary=tools.map(tool=>({name:tool.name,icons:(tool.icons||[]).map(icon=>({mimeType:icon.mimeType,sizes:icon.sizes,srcType:icon.src?.slice(0,35),srcLength:icon.src?.length,svg:icon.src?.startsWith("data:image/svg+xml;base64,")?Buffer.from(icon.src.split(",")[1],"base64").toString("utf8").slice(0,100):null}))}));
 console.log(JSON.stringify({server:c.getServerVersion?.(),tools:summary},null,2));
 for(const t of tools) { assert.equal(t.icons?.length,2,"missing icon "+t.name); assert.equal(t.icons[0].mimeType,"image/png","png first "+t.name); assert.equal(t.icons[1].mimeType,"image/svg+xml","svg fallback "+t.name); }
 console.log("PASS: tool icons reach tools/list in local MCP client");
}finally{try{await c.close();}catch{} await fs.rm(temp,{recursive:true,force:true});}