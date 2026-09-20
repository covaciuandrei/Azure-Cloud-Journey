import { useCallback, useEffect, useRef, useState } from "react";
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut as firebaseSignOut,
  type User,
} from "firebase/auth";
import { getFirebaseClients } from "./firebase-client.js";
import { accountErrorMessage } from "./account/auth-errors.js";
import { DEMO_AUTH_ERROR } from "../domain/demo.js";

export interface Account {
  user: User | null;
  ready: boolean;
  error: string | null;
  pending: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  clearError: () => void;
}

export function useAccount(): Account {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const mounted = useRef(false);
  const busy = useRef(false);

  useEffect(() => {
    mounted.current = true;
    let unsubscribe: (() => void) | undefined;
    if (import.meta.env.VITE_STUDY_DEMO === "true") {
      setReady(true);
      return () => { mounted.current = false; };
    }
    try {
      // getAuth uses local persistence by default, including across browser restarts.
      unsubscribe = onAuthStateChanged(getFirebaseClients().auth, (account) => {
        if (!mounted.current) return;
        setUser(account);
        setReady(true);
      }, (failure) => {
        if (!mounted.current) return;
        setUser(null);
        setError(accountErrorMessage(failure, "observe"));
        setReady(true);
      });
    } catch (failure) {
      setError(accountErrorMessage(failure, "observe"));
      setReady(true);
    }
    return () => {
      mounted.current = false;
      unsubscribe?.();
    };
  }, []);

  const perform = useCallback(async (operation: "sign-in" | "sign-out"): Promise<void> => {
    if (!mounted.current || busy.current) return;
    if (import.meta.env.VITE_STUDY_DEMO === "true") {
      setError(DEMO_AUTH_ERROR);
      return;
    }
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const { auth } = getFirebaseClients();
      if (operation === "sign-in") {
        const provider = new GoogleAuthProvider();
        provider.setCustomParameters({ prompt: "select_account" });
        await signInWithPopup(auth, provider);
      } else {
        await firebaseSignOut(auth);
      }
    } catch (failure) {
      if (mounted.current) setError(accountErrorMessage(failure, operation));
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }, []);

  const signIn = useCallback(() => perform("sign-in"), [perform]);
  const signOut = useCallback(() => perform("sign-out"), [perform]);
  const clearError = useCallback(() => setError(null), []);
  return { user, ready, error, pending, signIn, signOut, clearError };
}
