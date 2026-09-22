import { useState } from "react";
import { Modal } from "../components/Modal.js";
import type { OfflineReferences } from "../../domain/offline.js";
import type { OfflineDownload } from "./useOfflineDownload.js";

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

export function OfflineControls({ offline, getReferences, discussionsUnavailable = false }: {
  offline: OfflineDownload; getReferences: () => { references: OfflineReferences; warning: string | null };
  discussionsUnavailable?: boolean;
}) {
  const [confirmRemove, setConfirmRemove] = useState<"exam" | "all" | null>(null);
  const [referenceWarning, setReferenceWarning] = useState<string | null>(null);
  const { state } = offline;
  const examLabel = offline.examId === "sc900" ? "SC-900" : "AZ-104";
  const busy = offline.preparing || state.status === "downloading";
  return <section className="offline-controls" aria-label={`${examLabel} offline download`}>
    <div className="offline-summary">
      <strong>{examLabel}: {state.ready ? "Available offline" : state.status === "paused" ? "Offline download interrupted" : "Offline study"}</strong>
      <span>{offline.preparing ? "Preparing download..." : busy ? `Saving ${megabytes(state.completedBytes)} / ${megabytes(state.totalBytes)}` :
        state.ready ? `${megabytes(state.totalBytes)} stored${state.updatedAt ? ` \u00b7 ${new Date(state.updatedAt).toLocaleDateString()}` : ""}` :
          offline.supported ? discussionsUnavailable ? "Download lessons, reviewed answers, questions and images. Source discussions are unavailable."
            : "Download lessons, questions, discussions and images, with progress and size shown while saving." :
            "Offline downloads are available in the hosted app or a production preview."}</span>
    </div>
    <div className="offline-actions">
      {busy ? <button className="button button-secondary button-small" disabled={offline.preparing}
        onClick={() => void offline.cancel()}>Cancel download</button> :
        <button className="button button-secondary button-small" disabled={!offline.supported || !offline.online}
          onClick={() => {
            const result = getReferences();
            setReferenceWarning(result.warning);
            void offline.download(result.references);
          }}>
          {state.status === "paused" || state.status === "error" ? "Retry offline download" : state.ready ? "Update download" : "Download for offline use"}
        </button>}
      {state.ready && !busy && <button className="button button-secondary button-small" disabled={!offline.online}
        onClick={offline.useDownload ? offline.useOnline : offline.useCopy}>
        {offline.useDownload ? "Go online" : "Use downloaded copy"}
      </button>}
      {(state.ready || state.status === "paused" || state.status === "error" || offline.hasWorker) && !busy &&
        <button className="text-button" onClick={() => setConfirmRemove("exam")}>Remove download</button>}
      {offline.hasWorker && !busy &&
        <button className="text-button" onClick={() => setConfirmRemove("all")}>Remove all exam downloads</button>}
    </div>
    {busy && <progress aria-label="Offline download progress"
      {...(state.totalBytes ? { max: state.totalBytes, value: state.completedBytes } : {})} />}
    {offline.issue && <p className="offline-message" role="alert">{offline.issue}</p>}
    {referenceWarning && <p className="offline-message" role="alert">{referenceWarning}</p>}
    {offline.storageNote && <p className="offline-message muted">{offline.storageNote} Removing downloads does not remove your progress.</p>}
    {confirmRemove && <Modal title={confirmRemove === "all" ? "Remove all exam downloads?" : `Remove ${examLabel} offline download?`}
      onClose={() => setConfirmRemove(null)}>
      <p>{confirmRemove === "all" ? "This removes downloaded files for every exam." :
        `This removes only the ${examLabel} download. Other exam downloads stay available.`} Your sign-in, account cache, saved answers and history will be kept.</p>
      <div className="modal-actions">
        <button className="button button-secondary" onClick={() => setConfirmRemove(null)}>Cancel</button>
        <button className="button button-primary" onClick={() => {
          const all = confirmRemove === "all";
          setConfirmRemove(null);
          void (all ? offline.removeAll() : offline.remove());
        }}>{confirmRemove === "all" ? "Remove all downloads" : "Remove download"}</button>
      </div>
    </Modal>}
  </section>;
}
