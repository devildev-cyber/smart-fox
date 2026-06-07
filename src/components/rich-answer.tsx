import * as React from "react";

/**
 * Renders an answer string, converting **bold** segments into <strong>. Used so
 * the optional "bold keywords" setting displays correctly without a markdown lib.
 */
export function RichAnswer({ text }: { text: string }) {
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
