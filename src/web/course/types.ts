import type { Course } from "../../domain/course.js";
import type { CoursePracticeTopic } from "../../domain/courseCatalog.js";
import type { CourseProgress } from "./progress.js";

export interface CoursePageProps {
  course: Course;
  progress: CourseProgress;
  activeLessonId: string | null;
  warning: string | null;
  onOpenLesson: (lessonId: string) => void;
  onOverview: () => void;
  onCheck: (lessonId: string, checkpointId: string, selectedIds: string[]) => void;
  onStudy: (lessonId: string, studied: boolean) => void;
  onBookmark: (lessonId: string) => void;
  onPractice: (topicIds: CoursePracticeTopic[]) => void;
}
