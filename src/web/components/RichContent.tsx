import { useState } from "react";
import type { Inline, RichContent as Content } from "../../domain/index.js";
import type { CleanQuestion as PreparedQuestion } from "../../domain/cleanBank.js";
import type { StudyRepository } from "../types.js";
import { Icon } from "./Icon.js";
import { Modal } from "./Modal.js";

function Inlines({ spans }: { spans: Inline[] }) {
  return <>{spans.map((span, index) => {
    let content = span.type === "code" ? <code>{span.text}</code> : <>{span.text}</>;
    if (span.marks.includes("bold")) content = <strong>{content}</strong>;
    if (span.marks.includes("italic")) content = <em>{content}</em>;
    if (span.marks.includes("underline")) content = <u>{content}</u>;
    if (span.marks.includes("strike")) content = <s>{content}</s>;
    if (span.marks.includes("subscript")) content = <sub>{content}</sub>;
    if (span.marks.includes("superscript")) content = <sup>{content}</sup>;
    return span.type === "link"
      ? <a key={index} href={span.href} target="_blank" rel="noopener noreferrer">{content}</a>
      : <span key={index}>{content}</span>;
  })}</>;
}

function Exhibit({ url, alt, width, height }: { url: string; alt: string; width: number; height: number }) {
  const [zoom, setZoom] = useState(false);
  const [failed, setFailed] = useState(false);
  return <figure className="exhibit">
    {failed ? <p className="error-text" role="alert">This exhibit could not be loaded.</p> :
      <button className="exhibit-open" onClick={() => setZoom(true)} aria-label={`Enlarge ${alt}`}>
        <img src={url} alt={alt} width={width} height={height}
          loading={typeof navigator !== "undefined" && navigator.onLine === false ? "eager" : "lazy"}
          decoding="async" onError={() => setFailed(true)} />
        <span className="exhibit-zoom"><Icon name="expand" size={15} /> Enlarge</span>
      </button>}
    {zoom && <Modal title={alt} wide onClose={() => setZoom(false)}>
      <div className="zoom-image"><img src={url} alt={alt} /></div>
    </Modal>}
  </figure>;
}

export function RichContent({
  blocks, question, repository, releaseId, omitImageAssetIds,
}: {
  blocks: Content; question: PreparedQuestion; repository: StudyRepository;
  releaseId?: string | undefined;
  omitImageAssetIds?: ReadonlySet<string> | undefined;
}) {
  const recurse = (content: Content) => <RichContent blocks={content} question={question}
    repository={repository} releaseId={releaseId} omitImageAssetIds={omitImageAssetIds} />;
  return <div className="rich-content">{blocks.map((block, index) => {
    switch (block.type) {
      case "text":
        return block.spans.some((span) => span.text.trim())
          ? <p key={index}><Inlines spans={block.spans} /></p> : null;
      case "heading":
        return <h4 key={index}><Inlines spans={block.spans} /></h4>;
      case "code":
        return <pre key={index}><code>{block.code}</code></pre>;
      case "image":
        return omitImageAssetIds?.has(block.assetId)
          ? <p key={index} className="image-shown-above">Source answer image shown in the comparison above.</p>
          : <Exhibit key={index} url={repository.mediaUrl(question, block.assetId, releaseId)}
          width={block.width} height={block.height}
          alt={block.alt && block.alt !== "Question" ? block.alt :
            `Exhibit for question ${question.sources[0]?.questionNumber ?? ""}`} />;
      case "quote":
        return <blockquote key={index}>{recurse(block.blocks)}</blockquote>;
      case "list":
        return block.ordered
          ? <ol key={index} start={block.start}>{block.items.map((item, itemIndex) =>
            <li key={itemIndex}>{recurse(item)}</li>)}</ol>
          : <ul key={index}>{block.items.map((item, itemIndex) =>
            <li key={itemIndex}>{recurse(item)}</li>)}</ul>;
      case "table":
        return <div className="table-scroll" key={index}><table>
          {block.caption.length > 0 && <caption><Inlines spans={block.caption} /></caption>}
          <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.cells.map((cell, cellIndex) =>
            cell.header
              ? <th key={cellIndex} rowSpan={cell.rowSpan} colSpan={cell.colSpan}>{recurse(cell.blocks)}</th>
              : <td key={cellIndex} rowSpan={cell.rowSpan} colSpan={cell.colSpan}>{recurse(cell.blocks)}</td>,
          )}</tr>)}</tbody>
        </table></div>;
      case "separator":
        return <hr key={index} />;
    }
  })}</div>;
}
