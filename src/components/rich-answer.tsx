import * as React from "react";

/**
 * Minimal Markdown renderer for streamed teleprompter answers. Supports the
 * subset the answer prompt emits: **bold**, "- " bullet lists, and short bold
 * question headers. Intentionally tiny (no markdown dependency).
 */
export function RichAnswer({ text }: { text: string }) {
  const blocks = React.useMemo(() => parseBlocks(text), [text]);

  return (
    <div className="space-y-2">
      {blocks.map((block, i) =>
        block.type === "list" ? (
          <ul key={i} className="ml-1 list-disc space-y-1 pl-4 marker:text-muted-foreground">
            {block.items.map((item, j) => (
              <li key={j}>
                <Inline text={item} />
              </li>
            ))}
          </ul>
        ) : (
          <p key={i} className="leading-relaxed">
            <Inline text={block.text} />
          </p>
        )
      )}
    </div>
  );
}

type Block = { type: "p"; text: string } | { type: "list"; items: string[] };

function parseBlocks(text: string): Block[] {
  const lines = (text ?? "").replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let listItems: string[] = [];
  let paragraph: string[] = [];

  const flushList = () => {
    if (listItems.length) {
      blocks.push({ type: "list", items: listItems });
      listItems = [];
    }
  };
  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ type: "p", text: paragraph.join(" ") });
      paragraph = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);

    if (bullet) {
      flushParagraph();
      listItems.push(bullet[1]);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();
  return blocks;
}

function Inline({ text }: { text: string }) {
  const parts = React.useMemo(() => splitBold(text), [text]);
  return (
    <>
      {parts.map((part, i) =>
        part.bold ? (
          <strong key={i} className="font-semibold text-foreground">
            {part.text}
          </strong>
        ) : (
          <React.Fragment key={i}>{part.text}</React.Fragment>
        )
      )}
    </>
  );
}

function splitBold(text: string): Array<{ text: string; bold: boolean }> {
  const result: Array<{ text: string; bold: boolean }> = [];
  const regex = /\*\*(.+?)\*\*/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      result.push({ text: text.slice(lastIndex, match.index), bold: false });
    }
    result.push({ text: match[1], bold: true });
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    result.push({ text: text.slice(lastIndex), bold: false });
  }
  return result.length ? result : [{ text, bold: false }];
}
