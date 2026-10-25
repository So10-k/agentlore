/*
 * Does this prompt correct the agent, or state a standing preference? It only
 * has to be good enough to decide whether to *ask the agent* to save a lesson:
 * the agent makes the final call, and a false positive costs ~80 tokens.
 */
const CORRECTION = [
  /^\s*(no|nope|nah|wrong|stop|wait|ugh)\b[\s,.!]/i,
  /\b(don'?t|do not|dont|never|stop|quit|avoid) (use|using|do|doing|add|adding|make|put|call|change|touch|create|write|run|delete|remove|commit|push|install|include|ask)\b/i,
  /\b(i (said|told you|asked( you)?|already said)|as i said|like i said)\b/i,
  /\b(that'?s|this is|it'?s) (not|wrong|incorrect|broken|backwards)\b/i,
  /\b(you (forgot|missed|broke|ignored|didn'?t|keep|always)|why did you|why are you|why would you)\b/i,
  /\b(instead of|rather than|not what i (asked|wanted|meant))\b/i,
  /\b(revert|undo|roll ?back) (that|this|it|the|your)\b/i,
];
const PREFERENCE = /\b(always|from now on|going forward|in (the )?future|every time|by default|(i|we) (prefer|like|want|hate|never|always))\b/i;

// Ignore pasted code and quotes: corrections are in the person's own words, and
// they come first. Long messages are task specs and pastes, full of "never" and
// "always" that are instructions for this task, not reactions to a mistake.
const MAX_LENGTH = 1500;
const ownWords = (text) =>
  String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^>.*$/gm, ' ')
    .slice(0, 300);

export function detectCorrection(text) {
  if (String(text).length > MAX_LENGTH) return { correction: false, preference: false, matched: false };
  const t = ownWords(text);
  const correction = CORRECTION.some((re) => re.test(t));
  const preference = PREFERENCE.test(t);
  return { correction, preference, matched: correction || preference };
}

// "Continue X. Read CLAUDE.md, then the handoff doc…": re-explaining earlier work by hand.
const CONTINUATION = /\b(continue|resume|pick(ing)? up|carry on|where (we|you|i) left off|hand ?(this|ths|it)? ?off|handoff|hand-off|last session|previous session)\b/i;
export const isContinuation = (text) => CONTINUATION.test(String(text).slice(0, 400));
