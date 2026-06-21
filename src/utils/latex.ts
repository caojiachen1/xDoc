/**
 * Shared LaTeX → HTML rendering utilities.
 *
 * Used by App.tsx (reading panel) and GlobalSearchDialog (search results).
 */
import katex from "katex";

// ── Brace extraction ──────────────────────────────────────────────────────

function extractBraces(s: string, start: number): [string, number] | null {
  if (s[start] !== "{") return null;
  let depth = 0;
  let i = start;
  for (; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) return null;
  return [s.slice(start + 1, i), i + 1];
}

// ── Inline LaTeX → HTML ───────────────────────────────────────────────────

function inlineLatexToHtml(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\\" && i + 1 < s.length) {
      i++;
      if (/[a-zA-Z]/.test(s[i])) {
        let name = "";
        while (i < s.length && /[a-zA-Z]/.test(s[i])) {
          name += s[i];
          i++;
        }
        if (s[i] === "[") {
          while (i < s.length && s[i] !== "]") i++;
          if (i < s.length) i++;
        }
        if (s[i] === "{") {
          const brace = extractBraces(s, i);
          if (brace) {
            const [content, end] = brace;
            const inner = inlineLatexToHtml(content);
            i = end;
            switch (name) {
              case "textbf": out += `<b>${inner}</b>`; break;
              case "textit": out += `<i>${inner}</i>`; break;
              case "underline": out += `<u>${inner}</u>`; break;
              case "emph": out += `<em>${inner}</em>`; break;
              case "texttt": out += `<code>${inner}</code>`; break;
              case "textnormal": out += `<span>${inner}</span>`; break;
              case "textsc": out += `<span style="font-variant:small-caps">${inner}</span>`; break;
              case "textsuperscript": out += `<sup>${inner}</sup>`; break;
              case "textsubscript": out += `<sub>${inner}</sub>`; break;
              case "textcolor": {
                if (s[i] === "{") {
                  const brace2 = extractBraces(s, i);
                  if (brace2) {
                    const [txt, end2] = brace2;
                    out += `<span style="color:${inner}">${inlineLatexToHtml(txt)}</span>`;
                    i = end2;
                  } else {
                    out += inner;
                  }
                } else {
                  out += inner;
                }
                break;
              }
              case "mbox": out += inner; break;
              default: out += inner; break;
            }
            continue;
          }
        }
        out += "";
        continue;
      } else {
        const esc: Record<string, string> = {
          "\\": "\\", $: "$", "%": "%", "&": "&",
          _: "_", "{": "{", "}": "}", "#": "#", "~": "\u00A0",
        };
        if (esc[s[i]] !== undefined) {
          out += esc[s[i]];
          i++;
          continue;
        }
        out += "";
        i++;
        continue;
      }
    } else if (s[i] === "{") {
      const brace = extractBraces(s, i);
      if (brace) {
        out += inlineLatexToHtml(brace[0]);
        i = brace[1];
        continue;
      }
    } else if (s[i] === "}") {
      i++;
      continue;
    }
    out += s[i];
    i++;
  }
  return out;
}

// ── Display environments → intermediate HTML/KaTeX ────────────────────────

function latexToHtmlPreprocess(text: string): string {
  let result = text;

  // 1. Math environments → $$...$$
  const mathEnvs = [
    "equation", "equation*", "align", "align*",
    "gather", "gather*", "multline", "multline*",
  ];
  for (const env of mathEnvs) {
    const re = new RegExp(`\\\\begin\\{${env}\\}([\\s\\S]*?)\\\\end\\{${env}\\}`, "g");
    result = result.replace(re, (_, content: string) => `$$\n${content}\n$$`);
  }
  result = result.replace(/\\\[([\s\S]*?)\\\]/g, "$$\n$1\n$$");

  // 2. Tabular environments → <table>
  result = result.replace(
    /\\begin\{tabular\}\{[^}]*\}([\s\S]*?)\\end\{tabular\}/g,
    (_: string, content: string) => {
      content = content.replace(/^\}+/, "");
      const rows: string[] = [];
      let depth = 0;
      let cur = "";
      for (let j = 0; j < content.length; j++) {
        if (content[j] === "{") depth++;
        else if (content[j] === "}") depth--;
        else if (depth === 0 && content.startsWith("\\\\", j)) {
          rows.push(cur);
          cur = "";
          j++;
          continue;
        }
        cur += content[j];
      }
      const tail = cur.trim();
      if (tail) rows.push(tail);

      const rowHtml = rows
        .map((row) => {
          let cleaned = row.replace(/\\hline\s*/g, "");
          if (!cleaned.trim()) {
            return '<tr class="table-hline"><td colspan="10" style="border-top:2px solid rgba(255,255,255,0.3);padding:0"></td></tr>';
          }
          const cells: string[] = [];
          let cdepth = 0;
          let ccur = "";
          for (let j = 0; j < cleaned.length; j++) {
            if (cleaned[j] === "{") cdepth++;
            else if (cleaned[j] === "}") cdepth--;
            else if (cdepth === 0 && cleaned[j] === "&") {
              cells.push(ccur);
              ccur = "";
              continue;
            }
            ccur += cleaned[j];
          }
          const ctail = ccur.trim();
          if (ctail) cells.push(ctail);
          const cellHtml = cells
            .map((c) => `<td>${inlineLatexToHtml(c.trim())}</td>`)
            .join("");
          return `<tr>${cellHtml || "<td></td>"}</tr>`;
        })
        .join("");

      return `<table class="latex-table"><tbody>${rowHtml}</tbody></table>`;
    },
  );

  // 3. List environments → <ul>/<ol>
  const listEnvs: [RegExp, string][] = [
    [/\\begin\{itemize\}([\s\S]*?)\\end\{itemize\}/g, "ul"],
    [/\\begin\{enumerate\}([\s\S]*?)\\end\{enumerate\}/g, "ol"],
  ];
  for (const [re, tag] of listEnvs) {
    result = result.replace(re, (_: string, content: string) => {
      const items = content
        .split(/\\item/)
        .map((s: string) => s.trim())
        .filter(Boolean);
      const lis = items.map((i: string) => `<li>${inlineLatexToHtml(i)}</li>`).join("");
      return `<${tag}>${lis}</${tag}>`;
    });
  }

  // 4. Inline commands in the remaining text
  result = inlineLatexToHtml(result);
  return result;
}

// ── KaTeX rendering ───────────────────────────────────────────────────────

function renderKatex(html: string): string {
  let result = html;
  // Display math: $$...$$
  result = result.replace(/\$\$([\s\S]*?)\$\$/g, (_: string, math: string) => {
    try {
      return katex.renderToString(math, { displayMode: true, throwOnError: false });
    } catch {
      return `<span class="math-fallback">$$${math}$$</span>`;
    }
  });
  // Inline math: $...$ (not $$)
  result = result.replace(/\$(?!\$)([\s\S]*?[^\\])\$/g, (_: string, math: string) => {
    try {
      return katex.renderToString(math, { displayMode: false, throwOnError: false });
    } catch {
      return `<span class="math-fallback">$${math}$</span>`;
    }
  });
  return result;
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Full LaTeX preprocessing pipeline:
 * 1. Convert LaTeX environments / commands to intermediate HTML
 * 2. Render $…$ and $$…$$ with KaTeX
 *
 * @param text  Raw text that may contain LaTeX markup (and possibly
 *              already-HTML tags like `<mark>` from search highlighting).
 * @returns     HTML string ready for `dangerouslySetInnerHTML`.
 */
export function renderLatexToHtml(text: string): string {
  if (!text) return "";
  const preprocessed = latexToHtmlPreprocess(text);
  return renderKatex(preprocessed);
}

/**
 * Preprocess LaTeX environments and inline commands to intermediate HTML.
 * Does NOT render $…$ / $$…$$ with KaTeX — use `renderKatex` separately.
 */
export { latexToHtmlPreprocess };
