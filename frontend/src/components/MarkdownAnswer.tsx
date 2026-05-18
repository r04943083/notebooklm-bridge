import * as React from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CitationChip } from "@/components/CitationChip";
import { cn } from "@/lib/utils";
import type { Citation } from "@/types";

interface MarkdownAnswerProps {
  text: string;
  citations: Citation[];
  className?: string;
}

// Use Unicode double angle brackets (U+27E6 / U+27E7) as the sentinel because
// they essentially never appear in NotebookLM answers and conflict with no
// markdown syntax. The pre-processing step turns inline `[1]`, `[12]`, ... into
// `⟦cite:1⟧`, which our component renderer below detects and replaces with a
// React <CitationChip />. This keeps remark-gfm parsing untouched.
const CITE_TOKEN_LEFT = "⟦cite:";
const CITE_TOKEN_RIGHT = "⟧";
const CITE_TOKEN_REGEX = /⟦cite:(\d+)⟧/g;
const CITE_SPLIT_REGEX = /(⟦cite:\d+⟧)/g;

function preprocess(text: string): string {
  // [1] → ⟦cite:1⟧, [2,3] → ⟦cite:2⟧⟦cite:3⟧, [1, 2, 3] → three chips.
  // Strict digit-only inside the brackets so markdown link refs `[1]: https://…`
  // and bracketed text like `[some, text]` / `[2024-01]` aren't mangled.
  return text.replace(
    /\[(\d+(?:\s*,\s*\d+)*)\]/g,
    (_m, group: string) =>
      group
        .split(/\s*,\s*/)
        .map((n) => `${CITE_TOKEN_LEFT}${n}${CITE_TOKEN_RIGHT}`)
        .join(""),
  );
}

/** Walk children, splitting any string node on the citation sentinel and
 * replacing the token with <CitationChip />. Recurses into arrays. */
function injectChips(
  children: React.ReactNode,
  citations: Citation[]
): React.ReactNode {
  if (Array.isArray(children)) {
    return children.map((c, i) => (
      <React.Fragment key={i}>{injectChips(c, citations)}</React.Fragment>
    ));
  }
  if (typeof children !== "string") return children;
  if (!CITE_TOKEN_REGEX.test(children)) {
    CITE_TOKEN_REGEX.lastIndex = 0; // reset stateful regex
    return children;
  }
  CITE_TOKEN_REGEX.lastIndex = 0;

  const parts = children.split(CITE_SPLIT_REGEX);
  return parts.map((part, i) => {
    const m = part.match(/^⟦cite:(\d+)⟧$/);
    if (!m) return <React.Fragment key={i}>{part}</React.Fragment>;
    const n = parseInt(m[1], 10);
    return <CitationChip key={i} n={n} citations={citations} />;
  });
}

export function MarkdownAnswer({ text, citations, className }: MarkdownAnswerProps) {
  const processed = preprocess(text);

  const components: Components = {
    p: ({ children, ...rest }) => (
      <p className="leading-relaxed [&:not(:last-child)]:mb-3" {...rest}>
        {injectChips(children, citations)}
      </p>
    ),
    li: ({ children, ...rest }) => (
      <li className="my-1 leading-relaxed marker:text-muted-foreground" {...rest}>
        {injectChips(children, citations)}
      </li>
    ),
    ul: ({ children, ...rest }) => (
      <ul className="my-3 ml-6 list-disc space-y-1" {...rest}>
        {children}
      </ul>
    ),
    ol: ({ children, ...rest }) => (
      <ol className="my-3 ml-6 list-decimal space-y-1" {...rest}>
        {children}
      </ol>
    ),
    strong: ({ children, ...rest }) => (
      <strong className="font-semibold" {...rest}>
        {injectChips(children, citations)}
      </strong>
    ),
    em: ({ children, ...rest }) => (
      <em className="italic" {...rest}>
        {injectChips(children, citations)}
      </em>
    ),
    a: ({ href, children, ...rest }) => (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-accent underline underline-offset-2 hover:text-accent/80"
        {...rest}
      >
        {children}
      </a>
    ),
    code: ({ children, className: cls, ...rest }) => {
      // remark-gfm distinguishes inline (no language class) vs block via the
      // surrounding <pre>; we render the inline shape here, the `pre` override
      // below wraps multi-line blocks.
      const isBlock = typeof cls === "string" && cls.startsWith("language-");
      if (isBlock) {
        return (
          <code className={cn("font-mono text-sm", cls)} {...rest}>
            {children}
          </code>
        );
      }
      return (
        <code
          className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]"
          {...rest}
        >
          {children}
        </code>
      );
    },
    pre: ({ children, ...rest }) => (
      <pre
        className="my-3 overflow-x-auto rounded-md border border-border bg-muted/60 p-3 text-sm"
        {...rest}
      >
        {children}
      </pre>
    ),
    blockquote: ({ children, ...rest }) => (
      <blockquote
        className="my-3 border-l-4 border-border pl-3 italic text-muted-foreground"
        {...rest}
      >
        {children}
      </blockquote>
    ),
    table: ({ children, ...rest }) => (
      <div className="my-3 overflow-x-auto">
        <table className="w-full border-collapse text-sm" {...rest}>
          {children}
        </table>
      </div>
    ),
    th: ({ children, ...rest }) => (
      <th className="border border-border bg-muted px-2 py-1 text-left font-semibold" {...rest}>
        {children}
      </th>
    ),
    td: ({ children, ...rest }) => (
      <td className="border border-border px-2 py-1 align-top" {...rest}>
        {injectChips(children, citations)}
      </td>
    ),
    h1: ({ children, ...rest }) => (
      <h1 className="mb-2 mt-4 text-xl font-semibold tracking-tight" {...rest}>
        {children}
      </h1>
    ),
    h2: ({ children, ...rest }) => (
      <h2 className="mb-2 mt-4 text-lg font-semibold tracking-tight" {...rest}>
        {children}
      </h2>
    ),
    h3: ({ children, ...rest }) => (
      <h3 className="mb-2 mt-3 text-base font-semibold" {...rest}>
        {children}
      </h3>
    ),
  };

  return (
    <div className={cn("text-[15px] text-foreground", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {processed}
      </ReactMarkdown>
    </div>
  );
}
