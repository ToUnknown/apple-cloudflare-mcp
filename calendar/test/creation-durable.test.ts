import { test, expect } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { mkdtempSync, rmSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSync } from "esbuild";
import type { CreationRecord } from "../src/creation";
test("real workerd Durable Object reserves atomically and retains completed receipts", async () => {
  const dir = mkdtempSync(join(tmpdir(),"mcp-creation-test-"));
  let mf: Miniflare | undefined;
  try {
    buildSync({ entryPoints: ["src/creation-durable.ts"], bundle: true, format: "esm", platform: "neutral", external: ["cloudflare:workers"], outfile: join(dir,"index.js") });
    appendFileSync(join(dir,"index.js"), `\nexport default {async fetch(request, env) { const {method, record} = await request.json(); const stub = env.CREATION_RECEIPTS.get(env.CREATION_RECEIPTS.idFromName("synthetic-operation")); return Response.json((await stub[method](record)) ?? null); }};`);
    // Miniflare5's module resolver fails for external temporary scriptPath files.
    // Inline the unchanged compiled class; real workerd storage and RPC stay active.
    const options = { ...convertV4MiniflareOptions({name:"creation-test",modules:true,script:readFileSync(join(dir,"index.js"),"utf8"),compatibilityDate:"2026-10-14",durableObjects:{CREATION_RECEIPTS:{className:"CreationReceipt",useSQLite:true}}}), resourcePersistencePath:join(dir,"persist") };
    mf = new Miniflare(options);
    const call = async (method:string, record?:CreationRecord) => (await mf!.dispatchFetch("https://example.invalid/receipt", {method:"POST",body:JSON.stringify({method,record})})).json() as Promise<CreationRecord|null>;
    const stub = { reserve: (record:CreationRecord) => call("reserve",record), complete: (record:CreationRecord) => call("complete",record), receipt: () => call("receipt") };
    const initial: CreationRecord = {fingerprint:"same",operationId:"synthetic-operation",status:"pending",startedAt:"2026-10-14T00:00:00Z"};
    const results = await Promise.all([stub.reserve(initial),stub.reserve(initial)]);
    expect(results.filter(r=>r===null)).toHaveLength(1);
    expect(results.filter(r=>r?.status==="pending")).toHaveLength(1);
    await stub.complete({...initial,fingerprint:"other",status:"created",id:"invalid"});
    expect((await stub.receipt())?.status).toBe("pending");
    await stub.complete({...initial,status:"created",id:"https://example.invalid/fixture",etag:'"v1"'});
    await stub.complete({...initial,status:"uncertain"});
    const saved = await stub.reserve(initial);
    expect(saved).toMatchObject({status:"created",id:"https://example.invalid/fixture"});
    expect(await stub.receipt()).toEqual(saved);
    await mf.dispose();
    mf = new Miniflare(options);
    expect(await stub.receipt()).toEqual(saved);
    expect(await stub.reserve(initial)).toEqual(saved);
  } finally { await mf?.dispose(); rmSync(dir,{recursive:true,force:true}); }
},30000);
