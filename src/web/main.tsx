import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./ui/App.js";
import { DemoNotice } from "./components/DemoNotice.js";
import "./ui/styles.css";
import "./ui/coursebook-shell.css";
import "./ui/practice-redesign.css";

class AppErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  public override state: { error: string | null } = { error: null };
  public static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  public override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Study interface rendering failed.", error, info.componentStack);
  }
  public override render() {
    if (this.state.error) return <main className="fatal-error">
      <h1>The question could not be displayed</h1><p>{this.state.error}</p>
      <p>Your source files and saved practice history have not been deleted.</p>
      <button onClick={() => window.location.reload()}>Reload the local app</button>
    </main>;
    return this.props.children;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("The application root element is missing.");
createRoot(root).render(<StrictMode><AppErrorBoundary>
  {import.meta.env.VITE_STUDY_DEMO === "true" && <DemoNotice />}
  <App />
</AppErrorBoundary></StrictMode>);
