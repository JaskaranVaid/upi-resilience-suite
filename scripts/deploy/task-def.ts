/**
 * Turn the current ECS task definition into the input for a new revision running another image.
 *
 *   aws ecs describe-task-definition --task-definition merchantflo-staging-api > current.json
 *   node scripts/deploy/task-def.ts <image> < current.json > next.json
 *   aws ecs register-task-definition --cli-input-json file://next.json
 *
 * Everything else (environment, secrets, sizes, roles) comes from the latest revision, which
 * Terraform owns. Plain type annotations only, so Node 24 runs it without a build step.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Fields describe-task-definition returns that register-task-definition rejects. */
const READ_ONLY = ['taskDefinitionArn', 'revision', 'status', 'requiresAttributes', 'compatibilities', 'registeredAt', 'registeredBy', 'deregisteredAt'];

/** The application container in every Merchantflo task definition (infra/modules/service). */
export const APP_CONTAINER = 'app';

interface ContainerDefinition {
  name: string;
  image: string;
  [key: string]: unknown;
}

export interface TaskDefinitionInput {
  family: string;
  containerDefinitions: ContainerDefinition[];
  [key: string]: unknown;
}

export function renderTaskDefinition(described: unknown, image: string): TaskDefinitionInput {
  if (!/[:@][^/]+$/.test(image)) throw new Error(`image ${image} has no tag or digest; deploy an exact build`);
  const raw = (described as { taskDefinition?: unknown }).taskDefinition ?? described;
  const current = raw as TaskDefinitionInput;
  if (!current.containerDefinitions?.some((c) => c.name === APP_CONTAINER)) {
    throw new Error(`task definition ${current.family} has no container named "${APP_CONTAINER}"`);
  }
  const next: TaskDefinitionInput = { ...current, containerDefinitions: current.containerDefinitions.map((c) => (c.name === APP_CONTAINER ? { ...c, image } : c)) };
  for (const field of READ_ONLY) delete next[field];
  return next;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const image = process.argv[2];
  if (!image) {
    console.error('usage: node scripts/deploy/task-def.ts <image> < described.json > next.json');
    process.exit(2);
  }
  process.stdout.write(JSON.stringify(renderTaskDefinition(JSON.parse(readFileSync(0, 'utf8')), image), null, 2));
}
