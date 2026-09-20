import { useState } from "react";
import { Modal } from "../components/Modal.js";
import type { OfflineReferences } from "../../domain/offline.js";
import type { OfflineDownload } from "./useOfflineDownload.js";

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

export function OfflineControls({ offline, getReferences }: {
  offline: OfflineDownload; getReferences: () => { references: OfflineReferences; warning: string | null };
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [referenceWarning, setReferenceWarning] = useState<string | null>(null);
  const { state } = offline;
  const busy = offline.preparing || state.status === "downloading";
  return <section className="offline-controls" aria-label="Offline download">
    <div className="offline-summary">
      <strong>{state.ready ? "Available offline" : state.status === "paused" ? "Offline download interrupted" : "Offline study"}</strong>
      <span>{offline.preparing ? "Preparing download..." : busy ? `Saving ${megabytes(state.completedBytes)} / ${megabytes(state.totalBytes)}` :
        state.ready ? `${megabytes(state.totalBytes)} stored${state.updatedAt ? ` \u00b7 ${new Date(state.updatedAt).toLocaleDateString()}` : ""}` :
          offline.supported ? "Download lessons, questions, discussions and images, with progress and size shown while saving." :
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
        <button className="text-button" onClick={() => setConfirmRemove(true)}>Remove download</button>}
    </div>
    {busy && <progress aria-label="Offline download progress"
      {...(state.totalBytes ? { max: state.totalBytes, value: state.completedBytes } : {})} />}
    {offline.issue && <p className="offline-message" role="alert">{offline.issue}</p>}
    {referenceWarning && <p className="offline-message" role="alert">{referenceWarning}</p>}
    {offline.storageNote && <p className="offline-message muted">{offline.storageNote} Removing downloads does not remove your progress.</p>}
    {confirmRemove && <Modal title="Remove offline download?" onClose={() => setConfirmRemove(false)}>
      <p>This removes only downloaded app and question files from this browser. Your sign-in, account cache, saved answers and history will be kept.</p>
      <div className="modal-actions">
        <button className="button button-secondary" onClick={() => setConfirmRemove(false)}>Cancel</button>
        <button className="button button-primary" onClick={() => { setConfirmRemove(false); void offline.remove(); }}>Remove download</button>
      </div>
    </Modal>}
  </section>;
}
