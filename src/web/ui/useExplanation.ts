import { useEffect, useState } from "react";
import type { StudyDocument, StudyExplanation, StudyRepository } from "../types.js";

export function useExplanation(document: StudyDocument, repository: StudyRepository, enabled: boolean) {
  const [value, setValue] = useState<StudyExplanation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    setValue(null);
    setError(null);
    if (!enabled) return () => { current = false; };
    if (!repository.loadExplanation) {
      setError("Teaching explanations are not available in this app build. Update the app or offline download.");
      return () => { current = false; };
    }
    repository.loadExplanation(document).then((result) => {
      if (current) setValue(result);
    }).catch((reason: unknown) => {
      if (current) setError(reason instanceof Error ? reason.message : "The explanation could not be loaded.");
    });
    return () => { current = false; };
  }, [document, repository, enabled, retry]);
  return { value, error, retry: () => setRetry((count) => count + 1) };
}
