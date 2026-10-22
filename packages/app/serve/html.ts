const markup = Symbol("SafeHtml");

/** Construct with html; serialize only at the HTTP/SSE boundary. */
export type SafeHtml = {
  readonly [markup]: string;
  readonly length: number;
};
type Value = SafeHtml | string | number | boolean | null | undefined | readonly Value[];

function safe(value: string): SafeHtml {
  return Object.freeze({ [markup]: value, length: value.length });
}

function interpolate(value: Value): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    if (markup in value) return value[markup];
    return value.map(interpolate).join("");
  }
  return String(value).replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
}

export function html(strings: TemplateStringsArray, ...values: Value[]): SafeHtml {
  let result = strings[0];
  for (let i = 0; i < values.length; i++) result += interpolate(values[i]) + strings[i + 1];
  return safe(result);
}

/** Audited SVG constants only. The argument must retain its literal type. */
export function raw<const T extends string>(value: string extends T ? never : T): SafeHtml {
  return safe(value);
}

export function renderHTML(value: SafeHtml): string {
  return value[markup];
}
