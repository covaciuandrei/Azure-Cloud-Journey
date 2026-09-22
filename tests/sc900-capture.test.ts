import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const captureScript = fileURLToPath(new URL("../tools/ingest/sc900-capture.mjs", import.meta.url));
const driver = `
import {writeFileSync} from "node:fs";
let revealed=false, interception, requests=0, aborted=0, removed=false;
const imageUrl="https://example.test/source.gif";
const imageBase64="R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const hasImage=process.env.CAPTURE_TEST_IMAGE==="1";
if(process.env.CAPTURE_TEST_RESOURCE_STALL==="1"){
  const originalSetTimeout=globalThis.setTimeout;
  globalThis.setTimeout=(callback,delay,...args)=>originalSetTimeout(callback,delay===30000?5:delay,...args);
}
const handlers={};
const proof=()=>writeFileSync("browser-proof.json",JSON.stringify({requests,aborted,removed}));
const request={url:()=>"https://www.examprepper.co/api/discussion?examId=128&questionId=1"};
const button=name=>({
  count:async()=>name==="Next"?0:name==="Hide Answer"?Number(revealed):Number(!revealed),
  isEnabled:async()=>true,
  waitFor:async()=>{},
  click:async()=>{
    if(name==="Hide Answer"){revealed=false;return;}
    if(process.env.CAPTURE_TEST_FAIL==="1")throw Error("Synthetic answer rendering failed");
    revealed=true;
    handlers.request?.(request);
    if(interception){
      await interception({abort:async()=>{aborted++;proof();}});
    }else{
      requests++;proof();
      const status=Number(process.env.CAPTURE_TEST_STATUS??200);
      handlers.response?.({request:()=>request,ok:()=>status===200,status:()=>status,headers:()=>status===429?{"x-vercel-mitigated":"challenge"}:{}});
      handlers.requestfinished?.(request);
    }
  },
});
const question={
  locator:selector=>selector===".chakra-accordion__button"?{innerText:async()=>"Question 1"}:
    selector==="img"?{all:async()=>hasImage?[{scrollIntoViewIfNeeded:async()=>{},evaluate:async()=>false}]:[]}:
      {filter:()=>({first:()=>({count:async()=>0})})},
  getByRole:(_,options)=>typeof options.name==="string"?button(options.name):{count:async()=>0},
};
const page={
  url:()=>"https://www.examprepper.co/exam/128/1",
  title:async()=>"SC-900 synthetic fixture",
  on:(name,callback)=>{handlers[name]=callback;},
  route:async(match,callback)=>{
    if(!match(new URL(request.url()))||match(new URL("https://www.examprepper.co/api/discussion?examId=45&questionId=1"))||
      match(new URL("https://www.examprepper.co/exam/128/2")))throw Error("Unexpected interception scope");
    interception=callback;
  },
  unroute:async(_,callback)=>{if(interception!==callback)throw Error("Wrong interception removed");interception=undefined;removed=true;proof();},
  bringToFront:async()=>{},
  waitForTimeout:async()=>{},
  getByRole:(_,options)=>button(options.name),
  locator:()=>({count:async()=>1,nth:()=>question}),
  context:()=>({newCDPSession:async()=>({
    send:async(method,parameters)=>{
      if(method==="Page.enable")return {};
      if(method==="Page.getResourceTree"&&process.env.CAPTURE_TEST_RESOURCE_STALL==="1")return new Promise(()=>{});
      if(method==="Page.getResourceTree")return {frameTree:{frame:{id:"synthetic-frame"},resources:hasImage?[
        {url:imageUrl,type:"Image",mimeType:"image/gif"},
        {url:"https://example.test/unrelated-avatar.png",type:"Image",mimeType:"image/png"},
      ]:[]}};
      if(method==="Page.getResourceContent"&&parameters.frameId==="synthetic-frame"&&parameters.url===imageUrl){
        return {content:imageBase64,base64Encoded:true};
      }
      throw Error("Unexpected browser resource access");
    },
    detach:async()=>{},
  })}),
  evaluate:async()=>({
    captureVersion:1,method:"rendered-browser-ui",examId:128,
    url:process.env.CAPTURE_TEST_CHANGED_URL==="1"?"https://www.examprepper.co/exam/128/2":"https://www.examprepper.co/exam/128/1",
    title:"Synthetic fixture",capturedAt:new Date().toISOString(),
    questions:[{heading:"Question 1",html:"<p>Original synthetic fixture</p>",renderedText:"Original synthetic fixture",
      answerRevealed:revealed,choiceStyles:[],commentCount:0,remainingControls:revealed?[]:["Show Answer"],loadingIndicators:0,
      images:hasImage?[{src:imageUrl,currentSrc:imageUrl,alt:"Original synthetic pixel",loaded:true,width:1,height:1}]:[]}],
  }),
};
export const chromium={connectOverCDP:async()=>({contexts:()=>[{pages:()=>[page]}]})};
`;

async function runCapture(questionsOnly: boolean, environment: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "sc900-capture-"));
  try {
    const driverPath = join(directory, "driver.mjs");
    await writeFile(driverPath, driver);
    const execution = spawnSync(process.execPath, [
      captureScript, "--max-pages", "1", ...(questionsOnly ? ["--questions-only"] : []),
    ], {
      cwd: directory, encoding: "utf8", timeout: 30_000,
      env: {
        ...process.env, PLAYWRIGHT_MODULE: driverPath,
        CAPTURE_TEST_STATUS: "200", CAPTURE_TEST_FAIL: "0", CAPTURE_TEST_CHANGED_URL: "0",
        CAPTURE_TEST_IMAGE: "0", CAPTURE_TEST_RESOURCE_STALL: "0", ...environment,
      },
    });
    if (execution.error) throw execution.error;
    const root = join(directory, ".data/sc900", questionsOnly ? "question-content" : "");
    return {
      status: execution.status,
      stderr: execution.stderr,
      checkpoint: JSON.parse(await readFile(join(root, "capture-run.json"), "utf8")),
      page: existsSync(join(root, "raw/pages/page-001.json"))
        ? JSON.parse(await readFile(join(root, "raw/pages/page-001.json"), "utf8")) : undefined,
      browser: JSON.parse(await readFile(join(directory, "browser-proof.json"), "utf8")),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("questions-only capture preserves answers without requesting or certifying discussions", async () => {
  const result = await runCapture(true);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.checkpoint.scope, "questions-answers-images-only");
  assert.equal(result.checkpoint.completed, false);
  assert.equal(result.checkpoint.questionContentCompleted, true);
  assert.equal(result.checkpoint.questionContentOccurrences, 1);
  assert.equal(result.checkpoint.verifiedOccurrences, undefined);
  assert.equal(result.page.completion.status, "incomplete");
  assert.equal(result.page.questions[0].answerRevealed, true);
  assert.equal(result.page.questions[0].discussionLoad.status, "not-requested");
  assert.deepEqual(result.browser, { requests: 0, aborted: 1, removed: true });
});

test("full capture still requires a loaded discussion and accepts a verified empty one", async () => {
  const result = await runCapture(false);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.checkpoint.completed, true);
  assert.equal(result.checkpoint.verifiedOccurrences, 1);
  assert.equal(result.page.completion.status, "complete");
  assert.equal(result.page.questions[0].discussionLoad.status, "loaded");
  assert.equal(result.page.questions[0].discussionLoad.httpStatus, 200);
  assert.deepEqual(result.browser, { requests: 1, aborted: 0, removed: false });
});

test("full capture stops on a challenged discussion rather than silently changing scope", async () => {
  const result = await runCapture(false, { CAPTURE_TEST_STATUS: "429" });
  assert.equal(result.status, 2);
  assert.equal(result.checkpoint.completed, false);
  assert.equal(result.checkpoint.scope, "full-with-discussions");
  assert.equal(result.checkpoint.status, "blocked");
  assert.equal(result.page.questions[0].discussionLoad.status, "failed");
  assert.match(result.stderr, /429/);
  assert.deepEqual(result.browser, { requests: 1, aborted: 0, removed: false });
});

test("questions-only failure saves incomplete content and restores normal browser requests", async () => {
  const result = await runCapture(true, { CAPTURE_TEST_FAIL: "1" });
  assert.equal(result.status, 2);
  assert.equal(result.checkpoint.completed, false);
  assert.equal(result.checkpoint.questionContentCompleted, false);
  assert.equal(result.checkpoint.pages[0].questionContentStatus, "incomplete");
  assert.match(result.stderr, /Synthetic answer rendering failed/);
  assert.deepEqual(result.browser, { requests: 0, aborted: 0, removed: true });
});

test("a concurrent browser navigation cannot be persisted under the previous page number", async () => {
  const result = await runCapture(true, { CAPTURE_TEST_CHANGED_URL: "1" });
  assert.equal(result.status, 2);
  assert.equal(result.checkpoint.completed, false);
  assert.equal(result.checkpoint.questionContentCompleted, false);
  assert.equal(result.page, undefined);
  assert.match(result.stderr, /Navigation changed during capture/);
  assert.deepEqual(result.browser, { requests: 0, aborted: 1, removed: true });
});

test("capture reads exact displayed image bytes from cache without exporting unrelated browser resources", async () => {
  const result = await runCapture(true, { CAPTURE_TEST_IMAGE: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.page.assets.length, 1);
  assert.equal(result.page.assets[0].url, "https://example.test/source.gif");
  assert.equal(result.page.assets[0].contentType, "image/gif");
  assert.equal(result.page.assets[0].base64, "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7");
  assert.equal(result.page.assets[0].byteLength, Buffer.from(result.page.assets[0].base64, "base64").length);
  assert.deepEqual(result.page.missingAssetUrls, []);
});

test("a stalled browser resource operation saves a blocked checkpoint and restores request handling", async () => {
  const result = await runCapture(true, { CAPTURE_TEST_RESOURCE_STALL: "1" });
  assert.equal(result.status, 2);
  assert.equal(result.checkpoint.status, "blocked");
  assert.equal(result.checkpoint.questionContentCompleted, false);
  assert.equal(result.page, undefined);
  assert.match(result.stderr, /Browser resource operation timed out: Page.getResourceTree/);
  assert.deepEqual(result.browser, { requests: 0, aborted: 1, removed: true });
});
