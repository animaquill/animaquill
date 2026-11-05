import { writeFileSync } from "node:fs";
import { loadFixture } from "./fixture.ts";
import { readProject, writeProject } from "../src/project.ts";

const name = process.argv[2] ?? "v1";
const { project, problems } = readProject(loadFixture(name));
for (const problem of problems)
  console.log(problem.severity, problem.file, problem.path, problem.message);
if (project) {
  for (const [path, text] of writeProject(project)) {
    writeFileSync(new URL(`../fixtures/${name}/${path}`, import.meta.url), text);
  }
}
