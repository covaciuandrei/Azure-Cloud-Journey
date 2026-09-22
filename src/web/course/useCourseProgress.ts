import { useCallback, useEffect, useRef, useState } from "react";
import type { Course } from "../../domain/course.js";
import type { ExamId } from "../../domain/exams.js";
import {
  courseStorageKey, emptyCourseProgress, readCourseProgress, reduceCourseProgress, type CourseAction,
} from "./progress.js";

function readKey(key: string) {
  try { return { key, ...readCourseProgress(window.localStorage, key) }; }
  catch { return { key, ...readCourseProgress({ getItem() { throw new Error("Storage unavailable"); } }, key) }; }
}

export function useCourseProgress(uid: string | null, course: Course | null, examId: ExamId = course?.id === "sc900" ? "sc900" : "az104") {
  const key = courseStorageKey(uid, examId);
  const [state, setState] = useState(() => readKey(key));
  const ref = useRef(state);
  useEffect(() => {
    if (ref.current.key === key) return;
    const next = readKey(key);
    ref.current = next;
    setState(next);
  }, [key]);
  const updateWarning = (warning: string) => {
    const next = { ...(ref.current.key === key ? ref.current : readKey(key)), warning };
    ref.current = next;
    setState(next);
  };
  const dispatch = useCallback((action: CourseAction) => {
    if (!course || (course.id === "sc900" ? "sc900" : "az104") !== examId) {
      updateWarning("Wait for the selected exam's course to load before saving learning progress."); return;
    }
    try {
      const current = ref.current.key === key ? ref.current : readKey(key);
      const progress = reduceCourseProgress(current.progress, course, action);
      const next = { ...current, progress };
      ref.current = next;
      setState(next);
      if (!current.writable) return;
      try {
        window.localStorage.setItem(key, JSON.stringify(progress));
        ref.current = { ...next, warning: null };
        setState(ref.current);
      } catch {
        updateWarning("Browser storage is full or unavailable. Learning changes remain in this tab but are not saved.");
      }
    } catch (error) {
      updateWarning(error instanceof Error ? error.message : "Learning progress could not be updated.");
    }
  }, [course, key, examId]);
  return { progress: state.key === key ? state.progress : emptyCourseProgress(), warning: state.key === key ? state.warning : null, dispatch };
}
