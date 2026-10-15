import { tokenizeWith } from "@speed-highlight/core/tokenize";
import * as languages from "@speed-highlight/core/languages";

export type SyntaxRequest = { id: number; language: string; source: string };
export type SyntaxResponse = { id: number; tokens: { text: string; kind: string }[] };

export function tokenize(requests: SyntaxRequest[]): SyntaxResponse[] {
  return requests.map(({ id, language, source }) => {
    const tokens: SyntaxResponse["tokens"] = [];
    tokenizeWith(source, language, (text, kind) => tokens.push({ text, kind: kind ?? "" }), {
      languages,
    });
    return { id, tokens };
  });
}
