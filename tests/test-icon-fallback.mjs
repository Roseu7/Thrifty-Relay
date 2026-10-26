import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const tmp=await fs.mkdtemp(path.join(os.tmpdir(),"tr-png-icons-"));
const transport=new StdioClientTransport({
  command:process.execPath,args:["--import",pathToFileURL(path.join(import.meta.dirname,"policy-isolation.mjs")).href,path.join(project,"index.mjs")],cwd:project,
  env:{...process.env,THRIFTYRELAY_TASK_DIR:path.join(tmp,"tasks"),APPDATA:path.join(tmp,"appdata"),
    THRIFTYRELAY_TEST_POLICY_FILE:path.join(tmp,"missing-policy.json")},
  stderr:"pipe"
});
transport.stderr?.resume();
const client=new Client({name:"independent-icon-fallback-probe",version:"1"},{capabilities:{}});
try{
  await client.connect(transport);
  const version=client.getServerVersion();
  const defs=(await client.listTools()).tools;
  const required=["health","remote_task","remote_inspect","open_settings"];
  for(const entry of [{name:"server",icons:version?.icons},...defs.filter(t=>required.includes(t.name))]){
    assert.equal(entry.icons?.length,2,entry.name+" should provide PNG and SVG");
    const [png,svg]=entry.icons;
    assert.equal(png.mimeType,"image/png");
    assert(png.src.startsWith("data:image/png;base64,"));
    const bytes=Buffer.from(png.src.split(",")[1],"base64");
    assert.equal(bytes.subarray(0,8).toString("hex"),"89504e470d0a1a0a");
    assert.equal(bytes.readUInt32BE(16),64);
    assert.equal(bytes.readUInt32BE(20),64);
    assert.equal(svg.mimeType,"image/svg+xml");
    assert(svg.src.startsWith("data:image/svg+xml;base64,"));
  }
  console.log("PASS: server and 4 tools expose PNG 64x64 first, SVG fallback second; isolated MCP negotiation");
}finally{
  try{await client.close();}catch{}
  await fs.rm(tmp,{recursive:true,force:true});
}
