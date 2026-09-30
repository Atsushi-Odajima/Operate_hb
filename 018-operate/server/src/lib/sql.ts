// Minimal composable, parameterized SQL builder. Values are ALWAYS sent as bind parameters.
export class SQL {
  constructor(readonly parts: string[], readonly values: unknown[]) {}
  toQuery(): { text: string; values: unknown[] } {
    let text = this.parts[0];
    for (let i = 0; i < this.values.length; i++) text += `$${i + 1}` + this.parts[i + 1];
    return { text, values: this.values };
  }
}

export function sql(strings: TemplateStringsArray, ...vals: unknown[]): SQL {
  const parts: string[] = [strings[0]];
  const values: unknown[] = [];
  vals.forEach((v, i) => {
    if (v instanceof SQL) {
      parts[parts.length - 1] += v.parts[0];
      for (let j = 0; j < v.values.length; j++) {
        values.push(v.values[j]);
        parts.push(v.parts[j + 1]);
      }
      parts[parts.length - 1] += strings[i + 1];
    } else {
      values.push(v);
      parts.push(strings[i + 1]);
    }
  });
  return new SQL(parts, values);
}

/** Trusted, static SQL text only (identifiers, keywords). Never pass user input. */
export function raw(text: string): SQL {
  return new SQL([text], []);
}

export function join(items: SQL[], sep = ', '): SQL {
  if (items.length === 0) return raw('');
  let acc = items[0];
  for (let i = 1; i < items.length; i++) acc = sql`${acc}${raw(sep)}${items[i]}`;
  return acc;
}

export function and(items: SQL[]): SQL {
  return items.length ? sql`(${join(items, ' AND ')})` : raw('TRUE');
}
