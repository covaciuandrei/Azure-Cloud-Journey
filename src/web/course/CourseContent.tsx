import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { CourseBlock, CourseLesson } from "../../domain/course.js";
import { CourseInteractive } from "./InteractiveTools.js";

function inlineCode(text: string): ReactNode[] {
  return text.split(/(`[^`\n]+`)/g).map((part, index) =>
    /^`[^`\n]+`$/.test(part)
      ? <code key={index}>{part.slice(1, -1)}</code>
      : part);
}

export function CourseInline({ text }: { text: string }) {
  return <>{text.split(/(`[^`\n]+`|\*\*(?:[^*]|\*(?!\*))+?\*\*)/g).map((part, index) => {
    if (/^`[^`\n]+`$/.test(part)) return <code key={index}>{part.slice(1, -1)}</code>;
    if (/^\*\*(?:[^*]|\*(?!\*))+?\*\*$/.test(part)) return <strong key={index}>{inlineCode(part.slice(2, -2))}</strong>;
    return <Fragment key={index}>{part}</Fragment>;
  })}</>;
}

export function lessonSectionId(lessonId: string, sectionId: string) {
  return `course-section-${lessonId}-${sectionId}`;
}

function blockSearchText(block: CourseBlock): string {
  switch (block.type) {
    case "paragraph": return block.text;
    case "list": return block.items.join(" ");
    case "table": return [block.caption, ...block.headers, ...block.rows.flat()].join(" ");
    case "callout": return `${block.title} ${block.text}`;
    case "example": return [block.title, block.scenario, ...block.steps.flatMap((step) => [step.action, step.why]), block.result].join(" ");
    case "prediction": return `${block.prompt} ${block.answer} ${block.explanation}`;
    case "diagram": return [block.title, block.description, ...block.nodes.flatMap((node) => [node.label, node.detail]),
      ...block.edges.map((edge) => edge.label)].join(" ");
    case "code": return `${block.code} ${block.explanation}`;
    case "interactive": return block.introduction;
  }
}

export function lessonSearchText(lesson: CourseLesson) {
  return [lesson.title, lesson.summary, ...lesson.objectives, ...lesson.takeaways,
    ...lesson.sections.flatMap((section) => [section.title, ...section.blocks.map(blockSearchText)]),
    ...lesson.checkpoints.flatMap((checkpoint) => [checkpoint.prompt, checkpoint.explanation,
      ...checkpoint.choices.flatMap((choice) => [choice.text, choice.explanation])]),
  ].join(" ").replace(/[`*]/g, "").toLocaleLowerCase();
}

type DiagramBlock = Extract<CourseBlock, { type: "diagram" }>;
interface NodeBox { left: number; top: number; width: number; height: number }
interface DiagramLayout { width: number; height: number; boxes: Record<string, NodeBox> }
type DiagramPoint = [number, number];

function reciprocalEdgePath(block: DiagramBlock, layout: DiagramLayout, index: number) {
  const edge = block.edges[index]!;
  const fromNode = block.nodes.find((node) => node.id === edge.from)!;
  const toNode = block.nodes.find((node) => node.id === edge.to)!;
  const forward = fromNode.row < toNode.row || (fromNode.row === toNode.row && fromNode.column < toNode.column);
  const startNode = forward ? fromNode : toNode;
  const endNode = forward ? toNode : fromNode;
  const start = layout.boxes[startNode.id]!;
  const end = layout.boxes[endNode.id]!;
  const startX = start.left + start.width / 2;
  const endX = end.left + end.width / 2;
  const startBottom = start.top + start.height;
  const offset = forward ? -16 : 16;
  let points: DiagramPoint[];
  let label: DiagramPoint;

  // Choose paired 32px lanes by spatial direction, never by the edge's list index.
  if (startNode.row === endNode.row) {
    if (endNode.column - startNode.column === 1) {
      const y1 = start.top + start.height / 2 + offset;
      const y2 = end.top + end.height / 2 + offset;
      points = [[start.left + start.width, y1], [end.left, y2]];
      label = [(start.left + start.width + end.left) / 2, (y1 + y2) / 2];
    } else {
      const row = block.nodes.filter((node) => node.row === startNode.row).map((node) => layout.boxes[node.id]!);
      const y = forward ? Math.min(...row.map((box) => box.top)) - 20
        : Math.max(...row.map((box) => box.top + box.height)) + 20;
      points = [[startX, forward ? start.top : startBottom], [startX, y], [endX, y],
        [endX, forward ? end.top : end.top + end.height]];
      label = [(startX + endX) / 2, y];
    }
  } else if (startNode.column === endNode.column) {
    const interveningNode = block.nodes.some((node) => node.column === startNode.column &&
      node.row > startNode.row && node.row < endNode.row);
    if (interveningNode) {
      const gutter = forward ? Math.min(start.left, end.left) - 20
        : Math.max(start.left + start.width, end.left + end.width) + 20;
      points = [[startX + offset, startBottom], [startX + offset, startBottom + 20],
        [gutter, startBottom + 20], [gutter, end.top - 20], [endX + offset, end.top - 20], [endX + offset, end.top]];
      label = [gutter, (startBottom + end.top) / 2];
    } else {
      points = [[startX + offset, startBottom], [endX + offset, end.top]];
      label = [(startX + endX) / 2 + offset, (startBottom + end.top) / 2];
    }
  } else {
    const right = startNode.column < endNode.column;
    const portOffset = (right ? -1 : 1) * offset;
    if (endNode.row - startNode.row === 1) {
      const y = (startBottom + end.top) / 2 + offset;
      points = [[startX + portOffset, startBottom], [startX + portOffset, y],
        [endX + portOffset, y], [endX + portOffset, end.top]];
      label = [(startX + endX) / 2 + portOffset, y];
    } else {
      const rowStart = startBottom + (forward ? 20 : 52);
      const rowEnd = end.top - (forward ? 52 : 20);
      const gutter = right ? end.left - (forward ? 16 : 48) : end.left + end.width + (forward ? 16 : 48);
      points = [[startX + portOffset, startBottom], [startX + portOffset, rowStart],
        [gutter, rowStart], [gutter, rowEnd], [endX + portOffset, rowEnd], [endX + portOffset, end.top]];
      label = [(startX + portOffset + gutter) / 2, rowStart];
    }
  }
  if (!forward) points.reverse();
  return { d: points.map(([x, y], point) => `${point === 0 ? "M" : "L"} ${x} ${y}`).join(" "), x: label[0], y: label[1] };
}

function edgePath(block: DiagramBlock, layout: DiagramLayout, index: number) {
  const edge = block.edges[index]!;
  if (block.edges.some((other) => other.from === edge.to && other.to === edge.from)) {
    return reciprocalEdgePath(block, layout, index);
  }
  const from = layout.boxes[edge.from]!;
  const to = layout.boxes[edge.to]!;
  const fromNode = block.nodes.find((node) => node.id === edge.from)!;
  const toNode = block.nodes.find((node) => node.id === edge.to)!;
  const offset = (index % 3 - 1) * 10;
  if (fromNode.row === toNode.row && Math.abs(fromNode.column - toNode.column) === 1) {
    const right = fromNode.column < toNode.column;
    const x1 = from.left + (right ? from.width : 0);
    const x2 = to.left + (right ? 0 : to.width);
    const y1 = from.top + from.height / 2 + offset;
    const y2 = to.top + to.height / 2 + offset;
    return { d: `M ${x1} ${y1} L ${x2} ${y2}`, x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
  }
  const x1 = from.left + from.width / 2 + offset;
  const x2 = to.left + to.width / 2 + offset;
  const lane = 14 + index * 2;
  if (fromNode.row === toNode.row) {
    const y = Math.min(...block.nodes.filter((node) => node.row === fromNode.row)
      .map((node) => layout.boxes[node.id]!.top)) - lane;
    return { d: `M ${x1} ${from.top} V ${y} H ${x2} V ${to.top}`, x: (x1 + x2) / 2, y };
  }
  const down = fromNode.row < toNode.row;
  const y1 = from.top + (down ? from.height : 0);
  const y2 = to.top + (down ? 0 : to.height);
  const rowStart = y1 + (down ? lane : -lane);
  const rowEnd = y2 + (down ? -lane : lane);
  const gutter = to.left - lane;
  // Route long connections in the row and column gutters, not through intervening nodes.
  return {
    d: `M ${x1} ${y1} V ${rowStart} H ${gutter} V ${rowEnd} H ${x2} V ${y2}`,
    x: x1, y: rowStart,
  };
}

function CourseDiagram({ block }: { block: DiagramBlock }) {
  const id = useId();
  const canvas = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const [layout, setLayout] = useState<DiagramLayout | null>(null);
  const columns = Math.max(...block.nodes.map((node) => node.column)) + 1;
  const rows = Math.max(...block.nodes.map((node) => node.row)) + 1;

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const measure = () => {
      const bounds = element.getBoundingClientRect();
      const boxes: Record<string, NodeBox> = {};
      for (const node of block.nodes) {
        const target = nodes.current.get(node.id);
        if (!target) return;
        const rect = target.getBoundingClientRect();
        boxes[node.id] = { left: rect.left - bounds.left, top: rect.top - bounds.top, width: rect.width, height: rect.height };
      }
      setLayout({ width: bounds.width, height: bounds.height, boxes });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [block]);

  return <figure className="course-diagram">
    <figcaption>
      <h3 id={`${id}-title`}><CourseInline text={block.title} /></h3>
      <p id={`${id}-description`}><CourseInline text={block.description} /></p>
    </figcaption>
    <div className="course-diagram-scroll" role="region" aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description ${id}-key`} tabIndex={0}>
      <div className="course-diagram-canvas" ref={canvas} style={{
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${rows}, auto)`,
        minWidth: columns * 140 + (columns - 1) * 64 + 80,
      }}>
        {layout && layout.width > 0 && <svg className="course-diagram-edges" aria-hidden="true"
          viewBox={`0 0 ${layout.width} ${layout.height}`} preserveAspectRatio="none">
          <defs><marker id={`${id}-arrow`} viewBox="0 0 10 10" refX="9" refY="5"
            markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
          </marker></defs>
          {block.edges.map((edge, index) => {
            const path = edgePath(block, layout, index);
            return <g key={`${edge.from}-${edge.to}-${index}`}>
              <path d={path.d} fill="none" stroke="currentColor" strokeWidth="1.7" markerEnd={`url(#${id}-arrow)`} />
              <circle cx={path.x} cy={path.y} r="10" fill="white" stroke="currentColor" />
              <text x={path.x} y={path.y} textAnchor="middle" dominantBaseline="central">{index + 1}</text>
            </g>;
          })}
        </svg>}
        {block.nodes.map((node) => <div key={node.id} className="course-diagram-node"
          ref={(element) => { if (element) nodes.current.set(node.id, element); else nodes.current.delete(node.id); }}
          style={{ gridColumn: node.column + 1, gridRow: node.row + 1 }}>
          <strong><CourseInline text={node.label} /></strong>
          <span><CourseInline text={node.detail} /></span>
        </div>)}
      </div>
    </div>
    <p className="course-meta" id={`${id}-key`}>Arrow numbers match these directed connections. Scroll the diagram horizontally if needed.</p>
    <ol className="course-diagram-key">{block.edges.map((edge, index) => <li key={`${edge.from}-${edge.to}-${index}`}>
      <strong><CourseInline text={block.nodes.find((node) => node.id === edge.from)!.label} /></strong>
      {" to "}<strong><CourseInline text={block.nodes.find((node) => node.id === edge.to)!.label} /></strong>
      {": "}<CourseInline text={edge.label} />
    </li>)}</ol>
  </figure>;
}

function ContentBlock({ block }: { block: CourseBlock }) {
  const id = useId();
  switch (block.type) {
    case "paragraph": return <p className="course-prose"><CourseInline text={block.text} /></p>;
    case "list": {
      const List = block.ordered ? "ol" : "ul";
      return <List>{block.items.map((item, index) => <li key={index}><CourseInline text={item} /></li>)}</List>;
    }
    case "table": return <div className="course-table-scroll" tabIndex={0} role="region" aria-labelledby={`${id}-caption`}>
      <table><caption id={`${id}-caption`}><CourseInline text={block.caption} /></caption>
        <thead><tr>{block.headers.map((header, index) => <th scope="col" key={index}><CourseInline text={header} /></th>)}</tr></thead>
        <tbody>{block.rows.map((row, index) => <tr key={index}>{row.map((cell, column) =>
          <td key={column}><CourseInline text={cell} /></td>)}</tr>)}</tbody>
      </table>
    </div>;
    case "callout": return <aside className={`course-callout course-callout-${block.tone}`} aria-labelledby={`${id}-title`}>
      <p className="course-meta">{block.tone === "caution" ? "Caution" : block.tone === "exam" ? "Exam context" : "Remember"}</p>
      <h3 id={`${id}-title`}><CourseInline text={block.title} /></h3>
      <p><CourseInline text={block.text} /></p>
    </aside>;
    case "example": return <section className="course-example" aria-labelledby={`${id}-title`}>
      <p className="course-eyebrow">Worked example</p>
      <h3 id={`${id}-title`}><CourseInline text={block.title} /></h3>
      <p><CourseInline text={block.scenario} /></p>
      <ol>{block.steps.map((step, index) => <li key={index}>
        <p><strong>Action: </strong><CourseInline text={step.action} /></p>
        <p><strong>Why: </strong><CourseInline text={step.why} /></p>
      </li>)}</ol>
      <p className="course-example-result"><strong>Result: </strong><CourseInline text={block.result} /></p>
    </section>;
    case "prediction": return <section className="course-prediction" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>Pause and predict</h3>
      <p><CourseInline text={block.prompt} /></p>
      <details><summary>Reveal answer and explanation</summary>
        <div><p><strong>Answer: </strong><CourseInline text={block.answer} /></p>
          <p><CourseInline text={block.explanation} /></p></div>
      </details>
    </section>;
    case "diagram": return <CourseDiagram block={block} />;
    case "code": return <figure className="course-code">
      <figcaption id={`${id}-caption`}>{block.language} example</figcaption>
      <pre tabIndex={0} aria-labelledby={`${id}-caption`}><code>{block.code}</code></pre>
      <p><CourseInline text={block.explanation} /></p>
    </figure>;
    case "interactive": return <div className="course-interactive-block">
      <p><CourseInline text={block.introduction} /></p><CourseInteractive tool={block.tool} />
    </div>;
  }
}

export function CourseContent({ lesson }: { lesson: CourseLesson }) {
  return <div className="course-content" key={`${lesson.id}-${lesson.revision}`}>{lesson.sections.map((section) =>
    <section key={section.id} className="course-section" aria-labelledby={lessonSectionId(lesson.id, section.id)}>
      <h2 id={lessonSectionId(lesson.id, section.id)} tabIndex={-1}><CourseInline text={section.title} /></h2>
      {section.blocks.map((block, index) => <ContentBlock
        key={`${lesson.id}:${section.id}:${block.type}:${block.type === "prediction" ? block.id : index}`} block={block} />)}
    </section>)}</div>;
}
