import { loadCleanBank } from "../web/bank.js";
import { richAssetIds } from "../../src/domain/index.js";
import { plainText } from "../ingest/normalize-shared.js";
import { mediaExtension } from "../../src/domain/cleanBank.js";
import { writeData } from "../review/data.js";

const bank = await loadCleanBank();
const current = bank.releases.find((release) => release.catalog.releaseId === bank.manifest.releaseId)!;
const rows = current.documents.map(({ question, answers }) => {
  const needed = new Set([
    ...richAssetIds(question.prompt), ...question.options.flatMap((option) => richAssetIds(option.content)),
  ]);
  return {
    id: question.id,
    number: Math.min(...question.sources.map((source) => source.questionNumber)),
    sourceNumbers: question.sources.map((source) => source.questionNumber),
    prompt: plainText(question.prompt),
    options: question.options.map((option) => plainText(option.content)),
    explanation: answers.originalAnswers.map((answer) => plainText(answer.explanation)).join("\n"),
    images: question.media.filter((image) => needed.has(image.id)).map((image) =>
      `.data/assets/${image.id}.${mediaExtension(image.contentType)}`),
  };
}).sort((a, b) => a.number - b.number);
if (rows.length !== 604) throw new Error("Unexpected question count.");
await writeData(".data/topics/corpus.json", { sourceRevision: bank.manifest.sourceRevision, questions: rows });
for (let offset = 0; offset < rows.length; offset += 151) {
  const questions = rows.slice(offset, offset + 151);
  const batch = offset / 151 + 1;
  await writeData(`.data/topics/batch-${batch}.input.json`, { batch, questions });
  console.log(JSON.stringify({ batch, count: questions.length, from: questions[0]?.number, through: questions.at(-1)?.number }));
}
