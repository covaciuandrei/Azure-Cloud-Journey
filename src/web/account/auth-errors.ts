import { FirebaseConfigurationError } from "./firebase-options.js";

export function accountErrorMessage(
  error: unknown,
  operation: "sign-in" | "sign-out" | "observe",
): string {
  if (error instanceof FirebaseConfigurationError) return error.message;
  const code = error !== null && typeof error === "object" && "code" in error
    ? error.code
    : undefined;
  switch (code) {
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
      return "Sign-in was cancelled. Choose Sign in to try again.";
    case "auth/popup-blocked":
      return "Your browser blocked the sign-in window. Allow pop-ups for this site and try again.";
    case "auth/network-request-failed":
      return "The account service could not be reached. Check your connection and try again.";
    case "auth/unauthorized-domain":
      return "Google sign-in is not configured for this website address.";
    case "auth/operation-not-allowed":
      return "Google sign-in is not enabled for this app.";
    case "auth/user-disabled":
      return "This account has been disabled. Contact the app administrator.";
    case "auth/account-exists-with-different-credential":
      return "This account uses another sign-in method. Contact the app administrator.";
    case "auth/web-storage-unsupported":
      return "Your browser is blocking the storage needed to keep you signed in.";
    default:
      return operation === "sign-in"
        ? "Google sign-in failed. Please try again."
        : operation === "sign-out"
          ? "Sign-out failed. Please try again."
          : "Your account could not be loaded. Reload the page to try again.";
  }
}
