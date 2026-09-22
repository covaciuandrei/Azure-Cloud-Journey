import assert from "node:assert/strict";
import { test } from "node:test";
import { Sc900CaptureLedgerSchema } from "../src/domain/sc900Capture.js";
import { Sc900AnswerSchema, Sc900DocumentSchema, Sc900QuestionSchema } from "../src/domain/sc900Bank.js";
import { sc900BankFixture } from "./sc900-bank-fixture.js";

test("SC900 ledger domain rejects foreign exam paths and mismatched or unbounded page URLs", () => {
  const { ledger } = sc900BankFixture();
  for (const url of [
    "https://www.examprepper.co/exam/45/1",
    "https://www.examprepper.co/exam/128/99999999",
    "https://www.examprepper.co/exam/128/2",
  ]) {
    assert.equal(Sc900CaptureLedgerSchema.safeParse({ ...ledger, sourceUrl: url }).success, false);
    const changed = structuredClone(ledger);
    changed.pages[0]!.url = url;
    assert.equal(Sc900CaptureLedgerSchema.safeParse(changed).success, false);
  }
});

test("SC900 question and answer domains bind every occurrence to its exact five-question source page", () => {
  const document = sc900BankFixture().documents[0]!;
  for (const source of [
    { ...document.question.sources[0]!, url: "https://www.examprepper.co/exam/45/1" },
    { ...document.question.sources[0]!, pageNumber: 99_999_999, url: "https://www.examprepper.co/exam/128/99999999" },
    { ...document.question.sources[0]!, pageNumber: 2, url: "https://www.examprepper.co/exam/128/2" },
  ]) {
    assert.equal(Sc900QuestionSchema.safeParse({ ...document.question, sources: [source] }).success, false);
  }
  const wrongAnswer = structuredClone(document);
  wrongAnswer.answers.originalAnswers[0]!.provenance.url = "https://www.examprepper.co/exam/128/2";
  assert.equal(Sc900AnswerSchema.safeParse(wrongAnswer.answers).success, false);
  assert.equal(Sc900DocumentSchema.safeParse(wrongAnswer).success, false);

  const sixth = structuredClone(document);
  sixth.question.sourceOccurrenceIds = ["examprepper-128-q000006"];
  sixth.question.sources = [{ questionNumber: 6, pageNumber: 2, url: "https://www.examprepper.co/exam/128/2" }];
  sixth.answers.originalAnswers[0]!.sourceOccurrenceId = "examprepper-128-q000006";
  sixth.answers.originalAnswers[0]!.provenance.url = "https://www.examprepper.co/exam/128/2";
  assert.equal(Sc900DocumentSchema.safeParse(sixth).success, true);
});
