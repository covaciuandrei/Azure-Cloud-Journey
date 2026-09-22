import { useEffect, useMemo, useState } from "react";
import type { Comment } from "../../domain/index.js";
import type { StudyQuestion as PreparedQuestion } from "../types.js";
import { SC900_UNAVAILABLE_DISCUSSIONS_NOTICE } from "../../domain/sc900Scope.js";
import type { StudyRepository } from "../types.js";
import { RichContent } from "./RichContent.js";
import { Icon } from "./Icon.js";

function CommentThread({ comment, byId, question, repository, releaseId, depth = 0 }: {
  comment: Comment; byId: Map<string, Comment>; question: PreparedQuestion;
  repository: StudyRepository; releaseId?: string | undefined; depth?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const replies = comment.childIds.flatMap((id) => {
    const reply = byId.get(id);
    return reply ? [reply] : [];
  });
  return <article className={`comment ${depth ? "comment-reply" : ""}`}>
    <header className="comment-header">
      <span className="comment-avatar" aria-hidden="true">{comment.author.slice(0, 1).toUpperCase()}</span>
      <div><strong>{comment.author}</strong><span>{comment.displayedTimestamp} &middot; as captured</span>
        {question.sources.length > 1 && <span>Source question {Number(comment.sourceOccurrenceId.slice(-6))}</span>}
      </div>
      <span className="comment-votes">{comment.votes} {comment.votes === 1 ? "point" : "points"}</span>
    </header>
    <RichContent blocks={comment.body} question={question} repository={repository}
      releaseId={releaseId} />
    {replies.length > 0 && <button className="text-button comment-replies-toggle"
      aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      <Icon name="message" size={15} /> {expanded ? "Hide" : "Show"} {replies.length} {replies.length === 1 ? "reply" : "replies"}
    </button>}
    {expanded && <div className={depth < 3 ? "comment-nested" : ""}>{replies.map((reply) =>
      <CommentThread key={reply.id} comment={reply} byId={byId} question={question}
        repository={repository} releaseId={releaseId} depth={depth + 1} />)}</div>}
  </article>;
}

export function Discussion({ question, repository, releaseId }: {
  question: PreparedQuestion; repository: StudyRepository; releaseId?: string | undefined;
}) {
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [visible, setVisible] = useState(5);
  useEffect(() => {
    if (question.discussionScope) return;
    let active = true;
    setComments(null);
    setError(null);
    repository.loadDiscussion(question.id, releaseId).then((data) => {
      if (active) setComments(data.comments);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "The discussion could not be loaded.");
    });
    return () => { active = false; };
  }, [repository, question.id, question.discussionScope, releaseId, retry]);
  const byId = useMemo(() => new Map(comments?.map((comment) => [comment.id, comment]) ?? []), [comments]);
  const roots = useMemo(() => comments?.filter((comment) => comment.parentId === null)
    .sort((a, b) => b.votes - a.votes || a.treePath[0]! - b.treePath[0]!) ?? [], [comments]);
  if (question.discussionScope) return <p className="notice" role="note">{SC900_UNAVAILABLE_DISCUSSIONS_NOTICE}</p>;
  if (error) return <div className="inline-error" role="alert"><p>{error}</p>
    <button className="button button-secondary" onClick={() => setRetry(retry + 1)}>Retry discussion</button></div>;
  if (!comments) return <div className="loading-inline" role="status"><span className="spinner" /> Loading discussion</div>;
  return <div className="discussion">
    <p className="muted small">Imported community discussion. Votes are not proof of correctness.</p>
    {roots.length === 0 ? <div className="empty-small"><Icon name="message" /><p>No additional useful discussion for this question.</p></div> :
      roots.slice(0, visible).map((comment) => <CommentThread key={comment.id} comment={comment}
        byId={byId} question={question} repository={repository} releaseId={releaseId} />)}
    {visible < roots.length && <button className="button button-secondary" onClick={() => setVisible(visible + 5)}>
      Show more comments <span className="muted">({roots.length - visible} more threads)</span>
    </button>}
  </div>;
}
