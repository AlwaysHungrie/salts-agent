/**
 * The Worker's `/openapi.json`, read into the few things the guide's API playground
 * draws: one entry per route, grouped by tag, with its parameters and an example body.
 * Nothing here names a route; every one comes from the document.
 */

type Schema = {
  $ref?: string;
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  example?: unknown;
  description?: string;
};

type RawParam = {
  name: string;
  in: "path" | "query";
  required?: boolean;
  schema?: Schema;
};

type RawOperation = {
  tags?: string[];
  summary?: string;
  description?: string;
  parameters?: RawParam[];
  requestBody?: { content?: Record<string, { schema?: Schema }> };
};

export type OpenApiDoc = {
  paths: Record<string, Record<string, RawOperation>>;
  components?: { schemas?: Record<string, Schema> };
};

export type Param = { name: string; description: string; required: boolean };

export type Operation = {
  id: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  pathParams: string[];
  query: Param[];
  /** What the body is sent as, if the route takes one. */
  body: "json" | "file" | null;
  /** A starting body for a JSON route: its example, or `{}`. */
  example: string;
};

export type Group = { tag: string; operations: Operation[] };

const METHODS = ["get", "post", "patch", "put", "delete"];

/** A schema with any `$ref` followed to the component it names. */
function resolve(
  doc: OpenApiDoc,
  schema: Schema | undefined,
): Schema | undefined {
  if (!schema?.$ref) return schema;
  const name = schema.$ref.split("/").pop() ?? "";
  return doc.components?.schemas?.[name];
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
        description: p.schema?.description ?? "",
        required: !!p.required,
      })),
    body: content["multipart/form-data"] ? "file" : json ? "json" : null,
    example: json ? exampleBody(resolve(doc, json.schema)) : "",
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

/** The route's URL with its path parameters filled in, and any query set. */
export function requestUrl(
  base: string,
  op: Operation,
  vars: Record<string, string>,
  query: Record<string, string>,
): string {
  const path = op.path.replace(/\{(\w+)\}/g, (_, name: string) =>
    encodeURIComponent(vars[name] ?? ""),
  );
  const search = new URLSearchParams(
    Object.entries(query).filter(([, v]) => v !== ""),
  );
  const qs = search.toString();
  return `${base}${path}${qs ? `?${qs}` : ""}`;
}
