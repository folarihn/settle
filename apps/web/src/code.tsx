import { useState, type ReactNode } from "react";
import { Icon } from "./ui";

export type Lang = "bash" | "ts" | "json" | "http";

const RULES: Record<Lang, [RegExp, string][]> = {
  bash: [
    [/^#.*/, "c-com"],
    [/^"(?:[^"\\]|\\.)*"|^'[^']*'/, "c-str"],
    [/^--?[A-Za-z][\w-]*/, "c-flag"],
    [/^[A-Z][A-Z0-9_]+(?==)/, "c-var"],
    [/^<[^>\n]+>/, "c-ph"],
  ],
  ts: [
    [/^\/\/.*/, "c-com"],
    [/^"(?:[^"\\]|\\.)*"|^'(?:[^'\\]|\\.)*'|^`[^`]*`/, "c-str"],
    [/^\b(?:import|from|const|let|await|async|new|return|export|function|if|else)\b/, "c-kw"],
    [/^\b\d+(?:\.\d+)?\b/, "c-num"],
    [/^[A-Za-z_]\w*(?=\()/, "c-fn"],
  ],
  json: [
    [/^"(?:[^"\\]|\\.)*"(?=\s*:)/, "c-key"],
    [/^"(?:[^"\\]|\\.)*"/, "c-str"],
    [/^-?\b\d+(?:\.\d+)?\b|^\b(?:true|false|null)\b/, "c-num"],
  ],
  http: [
    [/^\b(?:GET|POST|PUT|DELETE)\b/, "c-kw"],
    [/^\/v1\/[\w/:.?=-]*/, "c-fn"],
    [/^[A-Za-z-]+(?=:)/, "c-key"],
    [/^"(?:[^"\\]|\\.)*"/, "c-str"],
    [/^<[^>\n]+>/, "c-ph"],
  ],
};

/** A tiny tokenizer: enough colour to read code at a glance, no runtime dependency. */
export function highlight(code: string, lang: Lang): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = code;
  let plain = "";
  let k = 0;
  let prev = "";
  const flush = () => {
    if (plain) out.push(plain);
    plain = "";
  };
  while (rest.length) {
    let hit: [string, string] | null = null;
    for (const [re, cls] of RULES[lang]) {
      // Flags, keywords and names only start a token at a word boundary (not "mcp-server").
      if (/[\w-]/.test(prev) &&(cls === "c-flag" || cls === "c-kw" || cls === "c-var")) continue;
      const m = rest.match(re);
      if (m && m[0].length) {
        hit = [m[0], cls];
        break;
      }
    }
    if (hit) {
      flush();
      out.push(
        <span key={k++} className={hit[1]}>
          {hit[0]}
        </span>,
      );
      prev = hit[0].slice(-1);
      rest = rest.slice(hit[0].length);
    } else {
      prev = rest[0]!;
      plain += rest[0];
      rest = rest.slice(1);
    }
  }
  flush();
  return out;
}

export function Code({ code, lang, label }: { code: string; lang: Lang; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard blocked: the text can still be selected by hand.
    }
  };
  return (
    <div className="codeblock">
      <div className="cb-bar">
        <span className="mono">{label ?? lang}</span>
        <button className="cb-copy" onClick={copy} aria-label={copied ? "Copied" : "Copy to clipboard"}>
          <Icon name={copied ? "check" : "copy"} /> {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code>{highlight(code, lang)}</code>
      </pre>
    </div>
  );
}
