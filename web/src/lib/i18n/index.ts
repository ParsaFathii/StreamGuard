// StreamGuard Console — i18n runtime (dot-path lookup, {var} interpolation)
import { en, type Dict } from "./en";
import { fa } from "./fa";

export type Lang = "en" | "fa";

const dictionaries: Record<Lang, Dict> = { en, fa };

type Join<K, P> = K extends string ? (P extends string ? `${K}.${P}` : never) : never;

type Prev = [never, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

type Paths<T, D extends number = 8> = [D] extends [never]
  ? never
  : T extends object
    ? { [K in keyof T & string]: K | Join<K, Paths<T[K], Prev[D]>> }[keyof T & string]
    : never;

export type TKey = Paths<Dict>;

/** Resolve a dot-path key against a dictionary, falling back to English then the key itself. */
function lookup(dict: Record<string, unknown>, key: string): string | undefined {
  let cur: unknown = dict;
  const parts = key.split(".");
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return typeof cur === "string" ? cur : undefined;
}

export function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
}

/** Translate `key` in `lang` with optional `{var}` substitutions. */
export function translate(lang: Lang, key: TKey | string, vars?: Record<string, string | number>): string {
  const raw = lookup(dictionaries[lang] as unknown as Record<string, unknown>, key)
    ?? lookup(dictionaries.en as unknown as Record<string, unknown>, key)
    ?? String(key);
  return interpolate(raw, vars);
}

export { en, fa };
