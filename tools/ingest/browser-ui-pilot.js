async (page) => {
  const captureDirectory = page.az104CaptureDirectory;
  if (typeof captureDirectory !== "string" || !captureDirectory.startsWith("/") ||
      captureDirectory.split("/").includes("..") || !captureDirectory.endsWith("/.data/raw/pages")) {
    throw new Error("Set page.az104CaptureDirectory to the approved absolute .data/raw/pages directory before installing the capture helper.");
  }
  if (!page.az104ImageResponses) {
    page.az104ImageResponses = new Map();
    page.on("response", (response) => {
      if (response.request().resourceType() === "image") {
        page.az104ImageResponses.set(response.url(), response);
      }
    });
  }
  if (!page.az104DiscussionStatus) {
    page.az104DiscussionStatus = new Map();
    const questionNumber = (url) => {
      if (!url.startsWith("https://www.examprepper.co/api/discussion?") ||
          !/[?&]examId=45(?:&|$)/.test(url)) return null;
      const match = url.match(/[?&]questionId=(\d+)(?:&|$)/);
      return match ? Number(match[1]) : null;
    };
    page.on("request", (request) => {
      const number = questionNumber(request.url());
      if (number !== null) page.az104DiscussionStatus.set(number, { status: "loading" });
    });
    page.on("response", (response) => {
      const number = questionNumber(response.url());
      if (number !== null) {
        page.az104DiscussionStatus.set(number, {
          status: response.ok() ? "receiving" : "failed",
          httpStatus: response.status(),
        });
      }
    });
    page.on("requestfinished", (request) => {
      const number = questionNumber(request.url());
      const current = number === null ? undefined : page.az104DiscussionStatus.get(number);
      if (current?.status === "receiving") {
        page.az104DiscussionStatus.set(number, { ...current, status: "loaded" });
      }
    });
    page.on("requestfailed", (request) => {
      const number = questionNumber(request.url());
      if (number !== null) {
        page.az104DiscussionStatus.set(number, {
          status: "failed",
          error: request.failure()?.errorText ?? "The discussion request failed.",
        });
      }
    });
  }

  page.az104LastNavigationAt = Date.now();
  page.az104NavigatePage = async (direction, number) => {
    if (!["Next", "Previous"].includes(direction) || number < 1 || number > 122) {
      throw new Error("Invalid page navigation.");
    }
    const delay = Math.max(0, 8000 - (Date.now() - page.az104LastNavigationAt));
    if (delay > 0) await page.waitForTimeout(delay);
    await page.getByRole("button", { name: direction, exact: true }).click();
    await page.waitForURL(`https://www.examprepper.co/exam/45/${number}`);
    await page.getByRole("button", { name: `Question ${(number - 1) * 5 + 1}`, exact: true })
      .waitFor({ state: "visible", timeout: 30000 });
    page.az104LastNavigationAt = Date.now();
  };

  page.az104CaptureRenderedPage = async () => {
    const match = page.url().match(/^https:\/\/www\.examprepper\.co\/exam\/45\/(\d+)$/);
    if (!match) throw new Error("The browser is not on an AZ-104 question page.");
    const pageNumber = Number(match[1]);
    const expectedCount = pageNumber === 122 ? 1 : 5;
    const items = page.locator(".chakra-accordion__item");
    await items.first().waitFor({ state: "visible", timeout: 30000 });
    const count = await items.count();
    if (count !== expectedCount) {
      throw new Error(`Page ${pageNumber}: expected ${expectedCount} questions, found ${count}.`);
    }

    for (let index = 0; index < count; index += 1) {
      const item = items.nth(index);
      const heading = await item.locator(".chakra-accordion__button").innerText();
      const expectedNumber = (pageNumber - 1) * 5 + index + 1;
      if (heading.trim() !== `Question ${expectedNumber}`) {
        throw new Error(`Unexpected question heading: ${heading.trim()}.`);
      }
      const show = item.getByRole("button", { name: "Show Answer", exact: true });
      if (await show.count()) {
        await show.click();
        await page.waitForTimeout(1000);
      }
      await item.getByRole("button", { name: "Hide Answer", exact: true }).waitFor();

      for (let expansion = 0; expansion < 500; expansion += 1) {
        const more = item.getByRole("button", {
          name: /^(load more|show more|more comments|load more comments|show more comments|show replies)$/i,
        });
        const collapsed = item.locator("a:not([href])").filter({ hasText: /^\s*\[\+\]\s*$/ });
        const control = (await more.count()) > 0 ? more.first() : collapsed.first();
        if ((await control.count()) === 0) break;
        if (expansion === 499) throw new Error(`${heading.trim()}: expansion did not finish.`);
        await control.click();
        await page.waitForTimeout(800);
      }
      for (let imageIndex = 0; imageIndex < await item.locator("img").count(); imageIndex += 1) {
        const image = item.locator("img").nth(imageIndex);
        await image.scrollIntoViewIfNeeded();
        await image.evaluate(async (element) => {
          if (!element.complete) {
            await new Promise((resolve, reject) => {
              const timeout = setTimeout(() => reject(new Error("Image did not load.")), 20000);
              element.addEventListener("load", () => { clearTimeout(timeout); resolve(); }, { once: true });
              element.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("Image failed to load.")); }, { once: true });
            });
          }
          if (!element.naturalWidth) throw new Error(`Unreadable image: ${element.currentSrc}`);
        });
      }
      for (let pass = 0; pass < 80; pass += 1) {
        const state = page.az104DiscussionStatus.get(expectedNumber);
        if (!state || state.status === "loaded" || state.status === "failed") break;
        await page.waitForTimeout(250);
      }
      const discussionState = page.az104DiscussionStatus.get(expectedNumber);
      if (discussionState && discussionState.status !== "loaded") {
        throw new Error(`${heading.trim()}: discussion loading failed: ${JSON.stringify(discussionState)}`);
      }
      if (!discussionState && await item.locator("ul.chakra-wrap__list").count() === 0) {
        throw new Error(`${heading.trim()}: an empty discussion has no successful loading evidence.`);
      }
    }

    let previousText = "";
    let stablePasses = 0;
    for (let pass = 0; pass < 20 && stablePasses < 2; pass += 1) {
      const currentText = (await items.allInnerTexts()).join("\n");
      stablePasses = currentText === previousText ? stablePasses + 1 : 0;
      previousText = currentText;
      await page.waitForTimeout(700);
    }
    if (stablePasses < 2) throw new Error(`Page ${pageNumber}: content is still changing.`);

    const capture = await page.evaluate(() => {
      const elements = [...document.querySelectorAll(".chakra-accordion__item")];
      return {
        captureVersion: 1,
        method: "rendered-browser-ui",
        url: location.href,
        title: document.title,
        capturedAt: new Date().toISOString(),
        questions: elements.map((item) => ({
          heading: item.querySelector(".chakra-accordion__button").textContent.trim(),
          html: item.outerHTML,
          renderedText: item.innerText,
          answerRevealed: [...item.querySelectorAll("button")].some(
            (button) => button.textContent.trim() === "Hide Answer",
          ),
          choiceStyles: [...item.querySelectorAll(".chakra-stack")]
            .filter((row) => row.children.length === 2 && /^[A-Z]\.$/.test(row.children[0].textContent.trim()))
            .map((row) => ({
              label: row.children[0].textContent.trim().slice(0, -1),
              text: row.children[1].innerText,
              borderColor: getComputedStyle(row).borderColor,
              borderWidth: getComputedStyle(row).borderWidth,
            })),
          commentCount: item.querySelectorAll("ul.chakra-wrap__list").length,
          remainingControls: [...item.querySelectorAll("button,a")]
            .filter((element) => /^(show answer|load more|show more|more comments|load more comments|show more comments|show replies|\[\+\])$/i.test(element.textContent.trim()))
            .map((element) => element.textContent.trim()),
          loadingIndicators: [...item.querySelectorAll(".chakra-spinner,[role=progressbar]")]
            .filter((element) => element.getClientRects().length > 0).length,
          images: [...item.querySelectorAll("img")].map((image) => ({
            src: image.getAttribute("src"),
            currentSrc: image.currentSrc,
            alt: image.alt,
            width: image.naturalWidth,
            height: image.naturalHeight,
            loaded: image.complete && image.naturalWidth > 0,
          })),
        })),
      };
    });
    for (const question of capture.questions) {
      if (!question.answerRevealed || question.remainingControls.length || question.loadingIndicators) {
        throw new Error(`${question.heading}: the displayed content is not complete.`);
      }
      const number = Number(question.heading.replace("Question ", ""));
      question.discussionLoad = page.az104DiscussionStatus.get(number) ?? { status: "rendered-only" };
    }

    const urls = [...new Set(capture.questions.flatMap((question) => question.images.map((image) => image.currentSrc)))];
    capture.assets = [];
    for (const url of urls) {
      const response = page.az104ImageResponses.get(url);
      if (!response) throw new Error(`No browser-loaded image response is available for ${url}.`);
      if (!response.ok()) throw new Error(`Image returned HTTP ${response.status()}: ${url}.`);
      const bytes = await response.body();
      const contentType = response.headers()["content-type"];
      if (!contentType?.startsWith("image/")) {
        throw new Error(`Unexpected image content type: ${contentType}.`);
      }
      capture.assets.push({ url, contentType, byteLength: bytes.length, base64: bytes.toString("base64") });
    }
    await page.evaluate((value) => { window.az104RenderedPageExport = value; }, capture);
    const filename = `page-${String(pageNumber).padStart(3, "0")}.json`;
    const destination = `${captureDirectory}/${filename}`;
    const downloadEvent = page.waitForEvent("download", { timeout: 15000 });
    await page.evaluate((name) => {
      const blob = new Blob([JSON.stringify(window.az104RenderedPageExport, null, 2)], {
        type: "application/json",
      });
      window.az104LocalExportUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = window.az104LocalExportUrl;
      link.download = name;
      document.body.append(link);
      link.click();
      link.remove();
    }, filename);
    const download = await downloadEvent;
    await download.saveAs(destination);
    const downloadFailure = await download.failure();
    if (downloadFailure) throw new Error(`${filename}: ${downloadFailure}`);
    await page.evaluate(() => {
      URL.revokeObjectURL(window.az104LocalExportUrl);
      delete window.az104LocalExportUrl;
    });
    page.az104LastSavedPage = pageNumber;
    return {
      page: pageNumber,
      questions: capture.questions.length,
      comments: capture.questions.reduce((total, question) => total + question.commentCount, 0),
      images: capture.assets.length,
      imageBytes: capture.assets.reduce((total, asset) => total + asset.byteLength, 0),
      sourceAnswers: capture.questions.map((question) => ({
        question: question.heading,
        labels: question.choiceStyles.filter((choice) => choice.borderColor === "rgb(104, 211, 145)").map((choice) => choice.label),
      })),
      savedFile: destination,
      status: "saved",
    };
  };

  return { installed: true, navigationReady: typeof page.az104NavigatePage === "function", url: page.url() };
}
