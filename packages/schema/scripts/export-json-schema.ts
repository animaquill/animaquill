import { mkdirSync, writeFileSync } from "node:fs";
import { jsonSchemas } from "../src/json-schema.ts";
import { stringifyDocument } from "../src/json.ts";

const folder = new URL("../json-schema/", import.meta.url);
mkdirSync(folder, { recursive: true });
for (const [name, schema] of Object.entries(jsonSchemas())) {
  writeFileSync(new URL(`${name}.schema.json`, folder), stringifyDocument(schema));
}
