import type { Element } from "hast";
import ReactMarkdown, { type Components } from "react-markdown";
import { ANSWERS_FENCE } from "@/lib/schemas/dailyContent";

/**
 * A lesson's markdown. A fenced block with the info string `answers` (`ANSWERS_FENCE`) holds a recall task's answers as markdown, and
 * shows collapsed under "Answers" so the learner answers from memory first. Raw HTML stays text.
 */
export function LessonMarkdown({ children }: { children: string }) {
  return <ReactMarkdown components={COMPONENTS}>{children}</ReactMarkdown>;
}

const COMPONENTS: Components = {
  p: ({ children }) => <p className="text-[15px] leading-[1.7] last:mb-0">{children}</p>,
  pre: ({ node, ...props }) => {
    const answers = answersOf(node);
    if (answers === null) return <pre {...props} />;
    return (
      <details className="rounded-2xl bg-secondary px-4 py-3">
        <summary className="cursor-pointer text-[13px] font-semibold select-none">Answers</summary>
        <div className="mt-3 space-y-4">
          <LessonMarkdown>{answers}</LessonMarkdown>
        </div>
      </details>
    );
  },
};

/** The markdown inside an `answers` fence, or null for any other `pre`. */
function answersOf(pre: Element | undefined): string | null {
  const code = pre?.children[0];
  if (code?.type !== "element" || code.tagName !== "code") return null;
  const classes = code.properties.className;
  if (!Array.isArray(classes) || !classes.some((c) => String(c).toLowerCase() === `language-${ANSWERS_FENCE}`)) return null;
  return code.children.map((c) => (c.type === "text" ? c.value : "")).join("");
}
