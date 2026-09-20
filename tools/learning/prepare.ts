import { loadCleanBank } from "../web/bank.js";
import { readTopicMap } from "../topics/data.js";
import { TOPIC_IDS } from "../../src/domain/topics.js";
import { richAssetIds } from "../../src/domain/index.js";
import { mediaExtension } from "../../src/domain/cleanBank.js";
import { digest, plainText } from "../ingest/normalize-shared.js";
import { writeData } from "../review/data.js";

const bank = await loadCleanBank();
const topics = await readTopicMap();
const current = bank.releases.find((release) => release.catalog.releaseId === bank.manifest.releaseId)!;
const discussions = new Map(current.discussions.map((discussion) => [discussion.questionId, discussion.comments]));
const imagePath = (id: string, media: typeof current.documents[number]["question"]["media"]) => {
  const image = media.find((item) => item.id === id);
  if (!image) throw new Error(`Missing research image ${id}`);
  return `.data/assets/${id}.${mediaExtension(image.contentType)}`;
};
const questions = current.documents.map(({ question, answers }) => {
  const promptImages = new Set([...richAssetIds(question.prompt), ...question.options.flatMap((option) => richAssetIds(option.content))]);
  const answerImages = new Set(answers.originalAnswers.flatMap((answer) => answer.answerAssetIds));
  return {
    questionId: question.id,
    questionSourceRevision: question.sourceRevision,
    originalKeyDigest: digest(answers.effectiveAnswer.value),
    number: Math.min(...question.sources.map((source) => source.questionNumber)),
    sourceNumbers: question.sources.map((source) => source.questionNumber),
    topicIds: topics.assignments[question.id]!,
    kind: question.kind,
    grading: question.readiness.grading,
    provisional: answers.provisional,
    prompt: plainText(question.prompt),
    options: question.options.map((option) => ({ optionId: option.id, text: plainText(option.content) })),
    storedKey: answers.effectiveAnswer.value,
    authorExplanation: answers.originalAnswers.map((answer) => plainText(answer.explanation)).filter(Boolean).join("\n\n"),
    questionImages: [...promptImages].map((id) => imagePath(id, question.media)),
    sourceAnswerImages: [...answerImages].map((id) => imagePath(id, question.media)),
    discussionPath: `.data/clean-bank/content/${bank.manifest.releaseId}/discussions/${question.id}.json`,
    discussionHints: [...(discussions.get(question.id) ?? [])].sort((a, b) => b.votes - a.votes).slice(0, 4)
      .map((comment) => ({ votes: comment.votes, text: comment.bodyText.slice(0, 1200) })),
  };
}).sort((a, b) => a.number - b.number);
await writeData(".data/learning/research/corpus.json", { baseReleaseId: bank.manifest.releaseId, questions });
const cases = questions.filter((question) => question.prompt.length > 3500 && /requirements|case study|planned changes/i.test(question.prompt))
  .map((question) => ({ number: question.number, prompt: question.prompt, questionImages: question.questionImages }));
await writeData(".data/learning/research/case-contexts.json", cases);
for (const topic of TOPIC_IDS) {
  const rows = questions.filter((question) => question.topicIds[0] === topic);
  await writeData(`.data/learning/research/${topic}.input.json`, { topic, questions: rows });
  console.log(JSON.stringify({ topic, count: rows.length, automatic: rows.filter((question) => question.grading === "automatic").length,
    manual: rows.filter((question) => question.grading === "manual").length }));
}
