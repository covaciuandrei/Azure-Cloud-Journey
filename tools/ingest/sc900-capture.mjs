import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, statfs } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(".data/sc900");
const endpoint = "http://127.0.0.1:9224";
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--max-pages" || !/^\d+$/.test(args[1])) {
  throw new Error("Usage: PLAYWRIGHT_MODULE=<installed driver> node tools/ingest/sc900-capture.mjs --max-pages <1-100>");
}
const maximum = Number(args[1]);
assert.ok(maximum >= 1 && maximum <= 100);
assert.ok(process.env.PLAYWRIGHT_MODULE, "Point PLAYWRIGHT_MODULE at an already installed Playwright driver.");
await mkdir(resolve(root, "raw/pages"), { recursive: true });

async function diskGuard() {
  const disk = await statfs(root);
  if (disk.bavail * disk.bsize <= 2_500_000_000) throw new Error("Disk-space threshold reached. Save and pause.");
}
async function save(path, value) {
  const temporary = `${path}.tmp`;
  const file = await open(temporary, "w", 0o600);
  try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
}
const checkpointPath = resolve(root, "capture-run.json");
let checkpoint = { schemaVersion: 1, examId: 128, pages: [], completed: false };
try { checkpoint = JSON.parse(await readFile(checkpointPath, "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
assert.equal(checkpoint.examId, 128);
await diskGuard();

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts().flatMap(context => context.pages())
  .find(page => /^https:\/\/www\.examprepper\.co\/exam\/128\/\d+$/.test(page.url()));
assert.ok(page, "Open the SC-900 question page in the user-authenticated dedicated Chrome window.");
const discussions = new Map();
const questionNumber = request => {
  const url = new URL(request.url());
  if (url.origin !== "https://www.examprepper.co" || url.pathname !== "/api/discussion" ||
      url.searchParams.get("examId") !== "128") return null;
  const value = url.searchParams.get("questionId");
  return /^\d+$/.test(value ?? "") ? Number(value) : null;
};
page.on("request", request => {
  const number = questionNumber(request);
  if (number !== null) discussions.set(number, { status: "loading" });
});
page.on("response", response => {
  const number = questionNumber(response.request());
  if (number !== null) discussions.set(number, {
    status: response.ok() ? "receiving" : "failed",
    httpStatus: response.status(),
    retryAfter: response.headers()["retry-after"] ?? null,
    verification: response.headers()["x-vercel-mitigated"] ?? null,
  });
});
page.on("requestfinished", request => {
  const number = questionNumber(request);
  if (number !== null && discussions.get(number)?.status === "receiving") {
    discussions.set(number, { ...discussions.get(number), status: "loaded" });
  }
});
page.on("requestfailed", request => {
  const number = questionNumber(request);
  if (number !== null) discussions.set(number, { status: "failed", error: request.failure()?.errorText ?? "Discussion request failed." });
});

async function renderedCapture() {
  const capture = await page.evaluate(() => ({
    captureVersion: 1, method: "rendered-browser-ui", examId: 128,
    url: location.href, title: document.title, capturedAt: new Date().toISOString(),
    questions: [...document.querySelectorAll(".chakra-accordion__item")].map(item => ({
      heading: item.querySelector(".chakra-accordion__button").textContent.trim(),
      html: item.outerHTML, renderedText: item.innerText,
      answerRevealed: [...item.querySelectorAll("button")].some(button => button.textContent.trim() === "Hide Answer"),
      choiceStyles: [...item.querySelectorAll(".chakra-stack")]
        .filter(row => row.children.length === 2 && /^[A-Z]\.$/.test(row.children[0].textContent.trim()))
        .map(row => ({
          label: row.children[0].textContent.trim().slice(0, -1), text: row.children[1].innerText,
          borderColor: getComputedStyle(row).borderColor, borderWidth: getComputedStyle(row).borderWidth,
        })),
      commentCount: item.querySelectorAll("ul.chakra-wrap__list").length,
      remainingControls: [...item.querySelectorAll("button,a")]
        .filter(element => /^(show answer|load more|show more|more comments|load more comments|show more comments|show replies|\[\+\])$/i.test(element.textContent.trim()))
        .map(element => element.textContent.trim()),
      loadingIndicators: [...item.querySelectorAll(".chakra-spinner,[role=progressbar]")]
        .filter(element => element.getClientRects().length > 0).length,
      images: [...item.querySelectorAll("img")].filter(image => !image.closest(".chakra-avatar")).map(image => ({
        src: image.getAttribute("src"), currentSrc: image.currentSrc, alt: image.alt,
        width: image.naturalWidth, height: image.naturalHeight, loaded: image.complete && image.naturalWidth > 0,
      })),
    })),
  }));
  for (const question of capture.questions) {
    question.discussionLoad = discussions.get(Number(question.heading.replace("Question ", ""))) ?? { status: "not-requested" };
  }
  const urls = [...new Set(capture.questions.flatMap(question => question.images.map(image => image.currentSrc)))];
  const cdp = await page.context().newCDPSession(page);
  let snapshot;
  try { snapshot = await cdp.send("Page.captureSnapshot", { format: "mhtml" }); }
  finally { await cdp.detach(); }
  const extraction = spawnSync("python3", ["-c", `
import base64,email,json,sys
request=json.load(sys.stdin)
allowed=set(request["urls"])
message=email.message_from_bytes(request["mhtml"].encode())
assets=[]
for part in message.walk():
    url=part.get("Content-Location","")
    if url in allowed and part.get_content_type().startswith("image/"):
        raw=part.get_payload(decode=True)
        assets.append({"url":url,"contentType":part.get_content_type(),"byteLength":len(raw),"base64":base64.b64encode(raw).decode()})
print(json.dumps(assets))
`], { input: JSON.stringify({ urls, mhtml: snapshot.data }), encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (extraction.status !== 0) throw new Error("Could not preserve browser-loaded question image bytes.");
  capture.assets = JSON.parse(extraction.stdout);
  capture.missingAssetUrls = urls.filter(url => !capture.assets.some(asset => asset.url === url));
  return capture;
}

async function persistPage(number, error) {
  const capture = await renderedCapture();
  const complete = !error && capture.questions.every(question => question.answerRevealed &&
    question.discussionLoad.status === "loaded" && !question.remainingControls.length &&
    !question.loadingIndicators && question.images.every(image => image.loaded)) && !capture.missingAssetUrls.length;
  capture.completion = { status: complete ? "complete" : "incomplete", reason: error?.message ?? (complete ? null : "Missing capture evidence or media.") };
  const path = resolve(root, `raw/pages/page-${String(number).padStart(3, "0")}.json`);
  await save(path, capture);
  const bytes = await readFile(path);
  const record = {
    page: number, status: capture.completion.status, capturedAt: capture.capturedAt,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    path: `.data/sc900/raw/pages/page-${String(number).padStart(3, "0")}.json`,
    questions: capture.questions.length,
    numbers: capture.questions.map(question => Number(question.heading.replace("Question ", ""))),
    verifiedDiscussions: capture.questions.filter(question => question.discussionLoad.status === "loaded").length,
    comments: capture.questions.reduce((sum, question) => sum + question.commentCount, 0),
    assets: capture.assets.length, missingAssets: capture.missingAssetUrls.length,
  };
  checkpoint.pages = [...checkpoint.pages.filter(item => item.page !== number), record].sort((a, b) => a.page - b.page);
  checkpoint.updatedAt = new Date().toISOString();
  checkpoint.status = complete ? "capturing" : "blocked";
  checkpoint.failure = capture.completion.reason;
  await save(checkpointPath, checkpoint);
  console.log(JSON.stringify(record));
  if (!complete) throw error ?? new Error(capture.completion.reason);
}

async function revealPage(number) {
  const questions = page.locator(".chakra-accordion__item");
  const count = await questions.count();
  assert.ok(count >= 1 && count <= 5, `Unexpected page size: ${count}`);
  for (let index = 0; index < count; index++) {
    await diskGuard();
    const question = questions.nth(index);
    const n = (number - 1) * 5 + index + 1;
    assert.equal((await question.locator(".chakra-accordion__button").innerText()).trim(), `Question ${n}`);
    if (await question.getByRole("button", { name: "Hide Answer", exact: true }).count()) {
      await question.getByRole("button", { name: "Hide Answer", exact: true }).click();
      await page.waitForTimeout(500);
    }
    await question.getByRole("button", { name: "Show Answer", exact: true }).click();
    await question.getByRole("button", { name: "Hide Answer", exact: true }).waitFor();
    const until = Date.now() + 30000;
    while (Date.now() < until && !["loaded", "failed"].includes(discussions.get(n)?.status)) await page.waitForTimeout(250);
    if (discussions.get(n)?.status !== "loaded") {
      throw new Error(`Question ${n}: discussion access is ${JSON.stringify(discussions.get(n) ?? { status: "no-completion-evidence" })}. Pause; do not call this an empty discussion.`);
    }
    for (let expansion = 0; expansion < 500; expansion++) {
      const more = question.getByRole("button", { name: /^(load more|show more|more comments|load more comments|show more comments|show replies)$/i });
      const collapsed = question.locator("a:not([href])").filter({ hasText: /^\s*\[\+\]\s*$/ });
      const control = await more.count() ? more.first() : collapsed.first();
      if (!(await control.count())) break;
      if (expansion === 499) throw new Error(`Question ${n}: comment expansion did not finish.`);
      await control.click();
      await page.waitForTimeout(1000);
      if (discussions.get(n)?.status === "failed") throw new Error(`Question ${n}: comment expansion request failed.`);
    }
    for (const image of await question.locator("img").all()) {
      if (await image.evaluate(element => Boolean(element.closest(".chakra-avatar")))) continue;
      await image.scrollIntoViewIfNeeded();
      await image.evaluate(async element => {
        await element.decode();
        if (!element.naturalWidth || !element.naturalHeight) throw new Error("A question image failed to load.");
      });
    }
    await page.waitForTimeout(1200);
  }
}

try {
  await page.bringToFront();
  for (let visited = 0; visited < maximum; visited++) {
    await diskGuard();
    const match = /^https:\/\/www\.examprepper\.co\/exam\/128\/(\d+)$/.exec(page.url());
    assert.ok(match, "Navigation left the authorized SC-900 pages.");
    const number = Number(match[1]);
    if ((await page.title()).includes("Security Checkpoint")) throw new Error("Access verification is required. Stop capture.");
    try { await revealPage(number); }
    catch (error) { await persistPage(number, error); }
    await persistPage(number);
    const next = page.getByRole("button", { name: "Next", exact: true });
    if (!(await next.count()) || !(await next.isEnabled())) {
      const ordered = checkpoint.pages;
      const numbers = ordered.flatMap(item => item.numbers);
      assert.ok(ordered.length === number && ordered.every((item, index) => item.page === index + 1 && item.status === "complete"),
        "The last page does not prove missing earlier pages were captured.");
      assert.ok(numbers.every((value, index) => value === index + 1), "Source occurrences have gaps or repeats.");
      checkpoint.completed = true;
      checkpoint.status = "captured";
      checkpoint.verifiedPages = number;
      checkpoint.verifiedOccurrences = numbers.length;
      await save(checkpointPath, checkpoint);
      break;
    }
    if (visited + 1 === maximum) break;
    await page.waitForTimeout(8000);
    await next.click();
    await page.waitForURL(`https://www.examprepper.co/exam/128/${number + 1}`, { timeout: 30000 });
    await page.getByRole("button", { name: `Question ${number * 5 + 1}`, exact: true }).waitFor();
  }
  console.log(JSON.stringify({ status: checkpoint.status, completed: checkpoint.completed, pages: checkpoint.pages.length }));
  process.exit(0);
} catch (error) {
  checkpoint.status = "blocked";
  checkpoint.failure = error.message;
  checkpoint.updatedAt = new Date().toISOString();
  await save(checkpointPath, checkpoint);
  console.error(error.message);
  process.exit(2);
}
