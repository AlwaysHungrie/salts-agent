/**
 * The Worker's `/openapi.json`, read into what the guide's API playground draws: one
 * entry per route, grouped by tag, with its parameters, body fields, responses and a
 * request a developer can copy. Nothing here names a route; every one comes from the
 * document.
 */

type Schema = {
  $ref?: string;
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  anyOf?: Schema[];
  oneOf?: Schema[];
  allOf?: Schema[];
  enum?: unknown[];
  format?: string;
  additionalProperties?: boolean | Schema;
  example?: unknown;
  description?: string;
};

type RawParam = {
  name: string;
  in: "path" | "query";
  required?: boolean;
  description?: string;
  schema?: Schema;
};

type RawOperation = {
  tags?: string[];
  summary?: string;
  description?: string;
  parameters?: RawParam[];
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: Schema }>;
  };
  responses?: Record<
    string,
    { description?: string; content?: Record<string, { schema?: Schema }> }
  >;
};

export type OpenApiDoc = {
  info?: { title?: string; version?: string; description?: string };
  paths: Record<string, Record<string, RawOperation>>;
  components?: { schemas?: Record<string, Schema> };
};

/** One input a route reads: from its path, its query string or its body. */
export type Field = {
  name: string;
  in: "path" | "query" | "body";
  type: string;
  required: boolean;
  description: string;
};

/** Kept for the inputs above the Send button. */
export type Param = { name: string; description: string; required: boolean };

export type Reply = {
  status: string;
  description: string;
  /** The content type, or "" for a reply with no body. */
  type: string;
  /** A sample body, from the schema's examples or its shape. */
  example: string;
};

export type Operation = {
  id: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  pathParams: string[];
  query: Param[];
  /** Every input, path first, then query, then body, for the parameter table. */
  fields: Field[];
  /** What the body is sent as, if the route takes one. */
  body: "json" | "file" | null;
  /** A starting body for a JSON route: its example, or `{}`. */
  example: string;
  responses: Reply[];
};

export type Group = { tag: string; operations: Operation[] };

const METHODS = ["get", "post", "patch", "put", "delete"];

/** A schema with any `$ref` followed to the component it names. */
function resolve(
  doc: OpenApiDoc,
  schema: Schema | undefined,
): Schema | undefined {
  if (!schema?.$ref) return schema;
  return doc.components?.schemas?.[refName(schema.$ref)];
}

function refName(ref: string): string {
  return ref.split("/").pop() ?? "";
}

/** A short type for the parameter table: `string`, `Session[]`, `"a" | "b"`, `number | null`. */
export function typeOf(doc: OpenApiDoc, schema: Schema | undefined): string {
  if (!schema) return "any";
  if (schema.$ref) return refName(schema.$ref);
  const union = schema.anyOf ?? schema.oneOf;
  if (union) return [...new Set(union.map((s) => typeOf(doc, s)))].join(" | ");
  if (schema.allOf) return schema.allOf.map((s) => typeOf(doc, s)).join(" & ");
  if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  const type = Array.isArray(schema.type)
    ? schema.type.join(" | ")
    : schema.type;
  if (type === "array") return `${typeOf(doc, schema.items)}[]`;
  if (schema.format === "binary") return "file";
  return type ?? "object";
}

/** A sample value of a schema: its example, else one built from its shape. */
function sample(
  doc: OpenApiDoc,
  schema: Schema | undefined,
  depth = 0,
): unknown {
  if (!schema || depth > 6) return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.$ref) return sample(doc, resolve(doc, schema), depth + 1);
  const union = schema.anyOf ?? schema.oneOf;
  if (union) {
    const first = union.find((s) => s.type !== "null") ?? union[0];
    return sample(doc, first, depth + 1);
  }
  if (schema.allOf) {
    return Object.assign(
      {},
      ...schema.allOf.map((s) => sample(doc, s, depth + 1) as object),
    );
  }
  if (schema.enum) return schema.enum[0];
  const type = Array.isArray(schema.type)
    ? schema.type.find((t) => t !== "null")
    : schema.type;
  switch (type) {
    case "string":
      return schema.format === "binary" ? "<file>" : "string";
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "null":
      return null;
    case "array":
      return [sample(doc, schema.items, depth + 1)];
  }
  const out: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    out[key] = sample(doc, prop, depth + 1);
  }
  return out;
}

/** The example a body schema carries, else its required fields blank, else `{}`. */
function exampleBody(schema: Schema | undefined): string {
  if (schema?.example !== undefined)
    return JSON.stringify(schema.example, null, 2);
  const blank: Record<string, unknown> = {};
  for (const key of schema?.required ?? []) {
    const type = schema?.properties?.[key]?.type;
    blank[key] =
      type === "number" || type === "integer"
        ? 0
        : type === "boolean"
          ? false
          : "";
  }
  return JSON.stringify(blank, null, 2);
}

function operation(
  doc: OpenApiDoc,
  method: string,
  path: string,
  raw: RawOperation,
): Operation {
  const params = raw.parameters ?? [];
  const content = raw.requestBody?.content ?? {};
  const json = content["application/json"];
  const form = content["multipart/form-data"];
  const bodySchema = resolve(doc, (json ?? form)?.schema);
  const describe = (p: RawParam) =>
    p.description ?? p.schema?.description ?? "";

  const fields: Field[] = [
    ...params.map((p) => ({
      name: p.name,
      in: p.in,
      type: typeOf(doc, p.schema),
      required: !!p.required,
      description: describe(p),
    })),
    ...Object.entries(bodySchema?.properties ?? {}).map(([name, prop]) => ({
      name,
      in: "body" as const,
      type: typeOf(doc, prop),
      required: bodySchema?.required?.includes(name) ?? false,
      description: resolve(doc, prop)?.description ?? prop.description ?? "",
    })),
  ];

  const responses = Object.entries(raw.responses ?? {}).map(
    ([status, reply]) => {
      const [type = "", body] = Object.entries(reply.content ?? {})[0] ?? [];
      const value = type.includes("json") ? sample(doc, body?.schema) : null;
      return {
        status,
        description: reply.description ?? "",
        type,
        example: value === null ? "" : JSON.stringify(value, null, 2),
      };
    },
  );

  return {
    id: `${method} ${path}`,
    method: method.toUpperCase(),
    path,
    summary: raw.summary ?? path,
    description: raw.description ?? "",
    pathParams: params.filter((p) => p.in === "path").map((p) => p.name),
    query: params
      .filter((p) => p.in === "query")
      .map((p) => ({
        name: p.name,
        description: describe(p),
        required: !!p.required,
      })),
    fields,
    body: form ? "file" : json ? "json" : null,
    example: json ? exampleBody(resolve(doc, json.schema)) : "",
    responses,
  };
}

/** Every route, grouped by its first tag, in the order the document lists them. */
export function groupOperations(doc: OpenApiDoc): Group[] {
  const groups: Group[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of METHODS) {
      const raw = item[method];
      if (!raw) continue;
      const tag = raw.tags?.[0] ?? "Other";
      let group = groups.find((g) => g.tag === tag);
      if (!group) groups.push((group = { tag, operations: [] }));
      group.operations.push(operation(doc, method, path, raw));
    }
  }
  return groups;
}

/** The agent an API key belongs to: `salt_<role>_<agentId>_<secret>`. */
export function agentOfKey(key: string): string {
  return /^salt_(?:admin|user)_([A-Za-z0-9-]+)_/.exec(key.trim())?.[1] ?? "";
}

/**
 * The route's URL with its path parameters filled in, and any query set. A parameter
 * with no value stays `{name}` when `keepBlank` is set, so a copied command shows what
 * is missing rather than a broken path.
 */
export function requestUrl(
  base: string,
  op: Operation,
  vars: Record<string, string>,
  query: Record<string, string>,
  keepBlank = false,
): string {
  const path = op.path.replace(/\{(\w+)\}/g, (whole, name: string) =>
    vars[name] ? encodeURIComponent(vars[name]) : keepBlank ? whole : "",
  );
  const search = new URLSearchParams(
    Object.entries(query).filter(([, v]) => v !== ""),
  );
  const qs = search.toString();
  return `${base}${path}${qs ? `?${qs}` : ""}`;
}

export type Snippet = "curl" | "javascript" | "python";

/** The body as one line of JSON, or the text as typed if it does not parse. */
function compact(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body || "{}"));
  } catch {
    return body;
  }
}

/** A ready-to-run request, reading the key from `$SALT_API_KEY`. */
export function snippet(
  kind: Snippet,
  url: string,
  op: Operation,
  body: string,
): string {
  const json = op.body === "json" ? compact(body) : "";
  if (kind === "curl") {
    const lines = [
      `curl -X ${op.method} '${url}'`,
      `  -H "Authorization: Bearer $SALT_API_KEY"`,
    ];
    if (json) {
      lines.push(`  -H 'Content-Type: application/json'`);
      lines.push(`  -d '${json.replace(/'/g, `'\\''`)}'`);
    }
    if (op.body === "file") lines.push(`  -F 'file=@./path/to/file'`);
    return lines.join(" \\\n");
  }
  if (kind === "javascript") {
    const lines = [
      `const res = await fetch("${url}", {`,
      `  method: "${op.method}",`,
      `  headers: {`,
      `    Authorization: \`Bearer \${process.env.SALT_API_KEY}\`,`,
    ];
    if (json) lines.push(`    "Content-Type": "application/json",`);
    lines.push(`  },`);
    if (json) lines.push(`  body: JSON.stringify(${json}),`);
    if (op.body === "file")
      lines.push(`  body: form, // a FormData with a "file" entry`);
    lines.push(`});`, `console.log(res.status, await res.json());`);
    return lines.join("\n");
  }
  const lines = [
    "import os, requests",
    "",
    `res = requests.${op.method.toLowerCase()}(`,
    `    "${url}",`,
    `    headers={"Authorization": f"Bearer {os.environ['SALT_API_KEY']}"},`,
  ];
  if (json) lines.push(`    json=${pythonLiteral(json)},`);
  if (op.body === "file")
    lines.push(`    files={"file": open("path/to/file", "rb")},`);
  lines.push(")", "print(res.status_code, res.json())");
  return lines.join("\n");
}

/** JSON written as a Python literal: `true`/`false`/`null` become `True`/`False`/`None`. */
function pythonLiteral(json: string): string {
  return json.replace(
    /("(?:[^"\\]|\\.)*")|\btrue\b|\bfalse\b|\bnull\b/g,
    (match, str: string | undefined) =>
      str ?? (match === "true" ? "True" : match === "false" ? "False" : "None"),
  );
}
