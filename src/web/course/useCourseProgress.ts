import { useCallback, useRef, useState } from "react";
import type { Course } from "../../domain/course.js";
import {
  courseStorageKey, readCourseProgress, reduceCourseProgress, type CourseAction,
} from "./progress.js";

export function useCourseProgress(uid: string | null, course: Course | null) {
  const key = courseStorageKey(uid);
  const [initial] = useState(() => {
    try { return readCourseProgress(window.localStorage, key); }
    catch { return readCourseProgress({ getItem() { throw new Error("Storage unavailable"); } }, key); }
  });
  const [progress, setProgress] = useState(initial.progress);
  const ref = useRef(progress);
  const [warning, setWarning] = useState<string | null>(initial.warning);
  const dispatch = useCallback((action: CourseAction) => {
    if (!course) { setWarning("Wait for the course to load before saving learning progress."); return; }
    try {
      const next = reduceCourseProgress(ref.current, course, action);
      ref.current = next;
      setProgress(next);
      if (!initial.writable) return;
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
        setWarning(null);
      } catch {
        setWarning("Browser storage is full or unavailable. Learning changes remain in this tab but are not saved.");
      }
    } catch (error) {
      setWarning(error instanceof Error ? error.message : "Learning progress could not be updated.");
    }
  }, [course, key, initial.writable]);
  return { progress, warning, dispatch };
}
