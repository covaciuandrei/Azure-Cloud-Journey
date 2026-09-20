import type { Comment, PreparedAnswer, PreparedQuestion, RichContent } from "./index.js";

export const COMMENT_QUALITY_VERSION = "supported-comments-v1";
export interface CommentQualityDecision {
  id: string;
  retained: boolean;
  reason: "technical-reference" | "explanation" | "technical-evidence" | "useful-question" |
    "unsupported-answer" | "irrelevant" | "no-support";
}

function textContent(blocks: RichContent): string {
  return blocks.map((block) => {
    switch (block.type) {
      case "text": case "heading": return block.spans.map((span) => span.text).join("");
      case "code": return block.code;
      case "quote": return textContent(block.blocks);
      case "list": return block.items.map(textContent).join("\n");
      case "table": return block.rows.map((row) => row.cells.map((cell) => textContent(cell.blocks)).join(" ")).join("\n");
      default: return "";
    }
  }).join("\n");
}

const normalize = (value: string) => value.normalize("NFKC").toLowerCase()
  .replace(/[’']/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const words = (value: string) => normalize(value).split(" ").filter(Boolean);
const technical = /\b(?:azure|entra|active directory|vm\d*|virtual|vnet\d*|subnet\d*|nsg\d*|icmp|tcp|udp|dns|ip|cidr|gateway|peering|vpn|tenant|subscription|resource|storage|blob|file|disk|backup|vault|replication|policy|policies|role|owner|reader|contributor|rbac|permission|user\d*|group\d*|server\d*|account\d*|container|registry|kubectl|kubernetes|aks|agent|certificate|encryption|key|sas|sku|premium|standard|zone|region|fault|domain|load balancer|app\d*|webapp\d*|rule|route|port|authentication|network|networking|tag|deployment|template|powershell|azcopy|lrs|zrs|grs|monitor|alert|metric|data collection|availability|scal(?:e|ing)|autoscale|instance|memory|cpu|cool.?down|retention|recovery point|rp|windows|linux|unix|os|python|script|query|kql|event|column|table|rg\d+|cost|endpoint|machine)(?:s)?\b/gi;
const reasoning = /\b(?:because|therefore|however|whereas|unlike|hence|since|which means|that means|in order to|so that|otherwise|due to|instead|requires?|supports?|does not|doesn't|cannot|can't|won't|will not|can only|must|only works|inherits?|inheritance|stateful|stateless|transitive|not transitive|isn't|aren't|doesn't|is not|are not|is already|are already|already exists|does|allows?|enables?|denies|blocks?|prevents?|increases?|reduces?|depends?|triggers?|replicates?|synchroni[sz]es?|applies|apply to|evaluat\w+|takes precedence|higher priority|lower priority|retired|deprecated|no longer)\b/i;
const opinionWords = new Set([
  "a", "b", "c", "d", "e", "f", "g", "h", "y", "n", "yes", "no", "true", "false",
  "the", "a", "an", "and", "or", "is", "are", "was", "were", "it", "its", "this", "that",
  "answer", "answers", "ans", "option", "options", "choice", "choices", "selected", "given",
  "provided", "correct", "incorrect", "right", "wrong", "valid", "invalid", "agree", "agreed",
  "disagree", "disagreed", "i", "we", "you", "think", "believe", "sure", "definitely",
  "absolutely", "obviously", "certainly", "indeed", "only", "all", "of", "them", "both",
  "should", "would", "be", "for", "vote", "voted", "voting", "with", "on", "go", "same",
  "sequence", "order", "looks", "seems", "to", "me", "as", "per", "above", "below",
  "most", "highly", "upvoted", "suggested", "confirmed", "tested", "test", "lab",
  "because", "thats", "100", "percent", "in", "my", "really",
]);

function withoutSelectedHeader(value: string): string {
  return value.replace(/^[ \t]*selected[ \t]+answers?:[ \t]*[A-Z,; &/+]+[ \t]*(?:\r?\n|$)/gim, "").trim();
}

function withoutAnswerWrapper(value: string): string {
  return value
    .replace(/^(?:\s*[A-H][.):\-]\s*)/i, "")
    .replace(/^(?:(?:the\s+)?(?:correct\s+)?(?:answer|ans|option|choice)\s*(?:is|should be|would be|:|-)?\s*)/i, "")
    .replace(/^\(?[A-H]\)?[.):\-]\s*/i, "")
    .replace(/\s+(?:is|are)\s+(?:the\s+)?(?:correct|right|wrong|incorrect)(?:\s+answer)?[.!]*$/i, "")
    .trim();
}

function hasRichEvidence(blocks: RichContent): boolean {
  return blocks.some((block) => {
    if (block.type === "image") return true;
    if (block.type === "code") return block.code.trim().length > 15;
    if (block.type === "quote") return hasRichEvidence(block.blocks);
    if (block.type === "list") return block.items.some(hasRichEvidence);
    if (block.type === "table") return block.rows.some((row) => row.cells.some((cell) => hasRichEvidence(cell.blocks)));
    return false;
  });
}

function technicalReference(comment: Comment): boolean {
  const urls: string[] = [...(comment.bodyText.match(/https?:\/\/[^\s<>"')]+/gi) ?? [])];
  const inspect = (blocks: RichContent) => {
    for (const block of blocks) {
      if (block.type === "text" || block.type === "heading") {
        block.spans.forEach((span) => { if (span.type === "link") urls.push(span.href); });
      } else if (block.type === "quote") inspect(block.blocks);
      else if (block.type === "list") block.items.forEach(inspect);
      else if (block.type === "table") block.rows.forEach((row) => row.cells.forEach((cell) => inspect(cell.blocks)));
    }
  };
  inspect(comment.body);
  return urls.some((url) => {
    if (!URL.canParse(url)) return false;
    const host = new URL(url).hostname.toLowerCase();
    return host === "microsoft.com" || host.endsWith(".microsoft.com") ||
      ["aka.ms", "github.com", "stackoverflow.com", "serverfault.com", "superuser.com",
        "kubernetes.io", "docs.docker.com", "learn.hashicorp.com", "developer.hashicorp.com"].includes(host);
  });
}

export function assessCommentSupport(
  comment: Comment,
  question: PreparedQuestion,
  answers: PreparedAnswer,
): CommentQualityDecision {
  const decision = (retained: boolean, reason: CommentQualityDecision["reason"]): CommentQualityDecision =>
    ({ id: comment.id, retained, reason });
  if (technicalReference(comment)) return decision(true, "technical-reference");
  if (hasRichEvidence(comment.body)) return decision(true, "technical-evidence");
  const body = withoutSelectedHeader(comment.bodyText);
  const tokens = words(body);
  if (!tokens.length) return decision(false, "unsupported-answer");
  const opinion = tokens.every((token) => opinionWords.has(token) || /^[a-h]{1,8}$/.test(token) || /^\d+$/.test(token));
  if (opinion) return decision(false, "unsupported-answer");

  const statement = withoutAnswerWrapper(body.replace(/^so[,\s]+/i, "")
    .replace(/^(?:this|that|the given answer|the answer)\s+is\s+(?:correct|right|wrong|incorrect)[.!]\s*/i, ""));
  const plainAnswer = normalize(statement);
  const options = question.options.map((option) => normalize(textContent(option.content)));
  const imageAnswers = [
    ...answers.assessment.originalImageAnswers.map((answer) => normalize(answer.summary)),
    ...(answers.assessment.effectiveImageAnswerSummary ? [normalize(answers.assessment.effectiveImageAnswerSummary)] : []),
  ];
  if (options.includes(plainAnswer) || (imageAnswers.includes(plainAnswer) && !reasoning.test(body))) {
    return decision(false, "unsupported-answer");
  }
  const techWords = body.match(technical) ?? [];
  if (/\b(?:backup|retention|recovery)\b/i.test(textContent(question.prompt)) &&
      (body.match(/^\s*\d{1,2}[- /](?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/gim)?.length ?? 0) >= 4 &&
      /\b(?:weekly|monthly|yearly)\b/i.test(body)) {
    return decision(true, "technical-evidence");
  }
  if (/\b(?:icmp_seq|packets transmitted|packet loss|rtt min|datatable\(|os\.getuid\(|errorcode|statuscode)\b/i.test(body) ||
      (/\b(?:sample code|steps i took|steps to reproduce)\b/i.test(body) && techWords.length > 0) ||
      /\bresource\s+"[^"]+"\s+"[^"]+"\s*\{/i.test(body)) {
    return decision(true, "technical-evidence");
  }
  if (techWords.length > 0 && /\d/.test(body) &&
      (/[+*=]/.test(body) || /\b(?:daily|weekly|monthly|yearly)\s+backup/i.test(body)) &&
      /\b(?:minute|mins?|hour|days?|weeks?|months?|instances?|recovery points?|rps?|backups?)\b/i.test(body) &&
      tokens.length >= 12) {
    return decision(true, "technical-evidence");
  }
  if (techWords.length > 0 && tokens.length >= 12 &&
      /\b(?:porque|permite|necesario|parce que|donc|pour|utiliser|permet|weil|deoarece|necesar)\b/i.test(body)) {
    return decision(true, "explanation");
  }
  if (/\b(?:examforsure|skillcertexams|exam dumps?|braindumps?|whatsapp|telegram|download.*pdf|send.*pdf|share.*pdf)\b/i.test(body) &&
      !reasoning.test(body)) return decision(false, "irrelevant");
  if (/\b(?:thanks?|congratulations|well done|good luck|hahaha|lol)\b/i.test(body) &&
      techWords.length === 0 && tokens.length <= 25) {
    return decision(false, "irrelevant");
  }
  if (/\b(?:exam|passed|scored|score|cleared|exame|exm)\b/i.test(body) &&
      techWords.length < 2 && !reasoning.test(body)) return decision(false, "irrelevant");
  if (/^(?:in|on|come|came|cum|got this|received this|estava)\b/i.test(body) &&
      /\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}/.test(body) && techWords.length === 0) {
    return decision(false, "irrelevant");
  }
  if (/\b(?:what|which|correct)\s+(?:is\s+)?(?:the\s+)?(?:answer|option)\b/i.test(body) &&
      tokens.length < 12 && techWords.length === 0) return decision(false, "unsupported-answer");
  if ((body.match(/\bsolution\s*:/gi)?.length ?? 0) > 1 &&
      !/\b(?:because|therefore|however|requires|cannot|does not|doesn't)\b/i.test(body)) {
    return decision(false, "unsupported-answer");
  }
  if (techWords.length > 0 && reasoning.test(body) && tokens.length >= 3) return decision(true, "explanation");
  if (/\b(?:nsgs?|peering|roles?|tags?|rules?|traffic)\b/i.test(body) &&
      /\b(?:stateful|stateless|transitive|inherit\w*|priority)\b/i.test(body)) return decision(true, "explanation");
  if (body.includes("?") && /\b(?:why|how|what if|does|would|shouldn't|isn't)\b/i.test(body) &&
      techWords.length > 0 && tokens.length >= 9) return decision(true, "useful-question");
  if (/\b(?:tested|testing|tried|reproduced|verified)\b/i.test(body) && techWords.length > 0 &&
      tokens.length >= 10 && /\b(?:created|enabled|disabled|deployed|ran|stopped|started|configured|result|failed|worked)\b/i.test(body)) {
    return decision(true, "technical-evidence");
  }
  if (techWords.length >= 2 && tokens.length >= 15 &&
      /\b(?:is|are|has|have|can|will|stores?|uses?|provides?|defines?|contains?|limits?|means?|must|only|before|after)\b/i.test(statement)) {
    return decision(true, "explanation");
  }
  if (techWords.length > 0 && tokens.length >= 7 &&
      /\b(?:can|will|is|are|only|sends?|syncs?|stores?|depends?|needs?|runs?|assigned|inherited)\b/i.test(statement)) {
    return decision(true, "explanation");
  }
  if (techWords.length >= 2 && tokens.length >= 25 &&
      /\b(?:providing|protecting|running|when|during|from|against|with)\b/i.test(body)) {
    return decision(true, "explanation");
  }
  return decision(false, /^\s*(?:(?:the|correct)\s+)?(?:answer|option|ans)\b/i.test(body) || /^[A-H][.):]/.test(body)
    ? "unsupported-answer" : "no-support");
}

export function retainSupportedComments(
  comments: Comment[],
  question: PreparedQuestion,
  answers: PreparedAnswer,
): { comments: Comment[]; decisions: CommentQualityDecision[]; promoted: number } {
  const originals = new Map(comments.map((comment) => [comment.id, comment]));
  if (originals.size !== comments.length) throw new Error(`${question.id}: duplicate discussion IDs.`);
  const decisions = comments.map((comment) => assessCommentSupport(comment, question, answers));
  const retained = new Set(decisions.filter((decision) => decision.retained).map((decision) => decision.id));
  const parents = new Map<string, string | null>();
  let promoted = 0;
  for (const comment of comments) {
    if (!retained.has(comment.id)) continue;
    let parent = comment.parentId;
    const seen = new Set<string>([comment.id]);
    while (parent && !retained.has(parent)) {
      if (seen.has(parent)) throw new Error(`${comment.id}: cyclic original discussion.`);
      seen.add(parent);
      const original = originals.get(parent);
      if (!original) throw new Error(`${comment.id}: missing original parent.`);
      parent = original.parentId;
    }
    if (parent !== comment.parentId) promoted++;
    parents.set(comment.id, parent);
  }
  const children = new Map<string, string[]>();
  for (const [id, parent] of parents) {
    if (parent) children.set(parent, [...(children.get(parent) ?? []), id]);
  }
  const result = comments.filter((comment) => retained.has(comment.id)).map((comment) => {
    let root = comment.id;
    const seen = new Set<string>();
    while (parents.get(root)) {
      if (seen.has(root)) throw new Error(`${comment.id}: cyclic retained discussion.`);
      seen.add(root);
      root = parents.get(root)!;
    }
    return { ...comment, parentId: parents.get(comment.id) ?? null, rootId: root, childIds: children.get(comment.id) ?? [] };
  });
  return { comments: result, decisions, promoted };
}
