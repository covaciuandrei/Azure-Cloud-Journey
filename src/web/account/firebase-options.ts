export class FirebaseConfigurationError extends Error {
  readonly code = "account/invalid-configuration";

  constructor(message: string) {
    super(message);
    this.name = "FirebaseConfigurationError";
  }
}

export function useFirebaseEmulators(
  environment: { DEV?: boolean; VITE_FIREBASE_EMULATORS?: string } | undefined,
  hostname: string | undefined,
): boolean {
  if (environment?.VITE_FIREBASE_EMULATORS !== "true") return false;
  if (environment.DEV !== true || (hostname !== "localhost" && hostname !== "127.0.0.1")) {
    throw new FirebaseConfigurationError(
      "Firebase emulators require a development build on localhost or 127.0.0.1.",
    );
  }
  return true;
}
