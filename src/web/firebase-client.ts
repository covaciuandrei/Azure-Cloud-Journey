import { getApp, getApps, initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth, type Auth } from "firebase/auth";
import { connectFirestoreEmulator, getFirestore, type Firestore } from "firebase/firestore";
import { FirebaseConfigurationError, useFirebaseEmulators } from "./account/firebase-options.js";
import { DEMO_AUTH_ERROR } from "../domain/demo.js";

export interface FirebaseClients {
  auth: Auth;
  firestore: Firestore;
}

let clients: FirebaseClients | undefined;
let initializationError: unknown;

export function getFirebaseClients(): FirebaseClients {
  if (import.meta.env.VITE_STUDY_DEMO === "true") throw new FirebaseConfigurationError(DEMO_AUTH_ERROR);
  if (clients) return clients;
  if (initializationError) throw initializationError;

  try {
    const emulators = useFirebaseEmulators(import.meta.env, globalThis.location?.hostname);
    const apiKey = import.meta.env.VITE_FIREBASE_API_KEY || (emulators ? "local-emulator-only" : "");
    if (!apiKey) {
      throw new FirebaseConfigurationError("Firebase web configuration is missing. Set VITE_FIREBASE_API_KEY in .env.local, or use the source demo.");
    }
    // Firebase web configuration is public; authorization is enforced by Firebase rules.
    const app = getApps().some((candidate) => candidate.name === "[DEFAULT]")
      ? getApp()
      : initializeApp({
        apiKey,
        authDomain: "study-az104.firebaseapp.com",
        projectId: "study-az104",
        storageBucket: "study-az104.firebasestorage.app",
        messagingSenderId: "237261733668",
      });
    if (app.options.projectId !== "study-az104") {
      throw new FirebaseConfigurationError("Firebase is already initialized for a different project.");
    }
    const auth = getAuth(app);
    const firestore = getFirestore(app);
    if (emulators) {
      connectAuthEmulator(auth, "http://127.0.0.1:9099");
      connectFirestoreEmulator(firestore, "127.0.0.1", 8080);
    }
    clients = { auth, firestore };
    return clients;
  } catch (error) {
    // Never retry a partially connected emulator initialization against production.
    initializationError = error;
    throw error;
  }
}
