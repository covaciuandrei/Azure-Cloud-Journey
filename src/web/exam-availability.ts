import { Sc900AvailabilitySchema, SC900_UNAVAILABLE_NOTICE } from "../domain/examAvailability.js";
import { examBaseUrl } from "../domain/exams.js";
import type { Course } from "../domain/course.js";
import type { StudyCatalog } from "./types.js";
import { SC900_UNAVAILABLE_DISCUSSIONS_NOTICE } from "../domain/sc900Scope.js";

export type ExamAvailability =
  | { status: "loading"; notice: string }
  | { status: "unavailable"; notice: string }
  | { status: "available"; notice: string };

export async function checkSc900Availability(
  appBase: string,
  loadCourse: () => Promise<Course>,
  loadCatalog: () => Promise<StudyCatalog>,
  demo = false,
  fetcher: typeof fetch = fetch,
): Promise<ExamAvailability> {
  const response = await fetcher(new URL("availability.json", examBaseUrl(appBase, "sc900")).href, {
    cache: "no-store", credentials: "same-origin", redirect: "error",
  });
  if (response.status === 404) return { status: "unavailable", notice: SC900_UNAVAILABLE_NOTICE };
  if (!response.ok) throw new Error(`SC-900 availability could not be checked (HTTP ${response.status}).`);
  const raw = await response.text();
  if (new TextEncoder().encode(raw).length > 8_000) throw new Error("SC-900 activation record exceeds its size limit.");
  const availability = Sc900AvailabilitySchema.parse(JSON.parse(raw));
  if (!availability.activated) return { status: "unavailable", notice: SC900_UNAVAILABLE_NOTICE };
  if ((availability.kind === "original-synthetic-demo") !== demo) {
    throw new Error("The SC-900 activation record belongs to a different application mode.");
  }
  const [course, catalog] = await Promise.all([loadCourse(), loadCatalog()]);
  if (course.id !== "sc900" || course.releaseId !== availability.courseReleaseId ||
      catalog.examId !== "sc900" || catalog.releaseId !== availability.bankReleaseId ||
      catalog.counts.questions < 1 || catalog.questions.length !== catalog.counts.questions ||
      JSON.stringify(catalog.discussionScope) !== JSON.stringify(availability.discussionScope) ||
      (demo && catalog.counts.questions !== 10)) {
    throw new Error("SC-900 activation does not match its approved course and question bank.");
  }
  return {
    status: "available",
    notice: demo ? "10 original synthetic SC-900 sample questions. Not the production bank." :
      catalog.discussionScope ? SC900_UNAVAILABLE_DISCUSSIONS_NOTICE : "Available to study",
  };
}
