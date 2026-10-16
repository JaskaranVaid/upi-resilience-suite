import { describe, expect, it } from 'vitest';
import { renderTaskDefinition } from '../../scripts/deploy/task-def.js';

// Trimmed `aws ecs describe-task-definition` output, as the deploy script receives it.
const described = () => ({
  taskDefinition: {
    taskDefinitionArn: 'arn:aws:ecs:ap-south-1:111122223333:task-definition/merchantflo-staging-api:7',
    family: 'merchantflo-staging-api',
    revision: 7,
    status: 'ACTIVE',
    taskRoleArn: 'arn:aws:iam::111122223333:role/merchantflo-staging-task',
    executionRoleArn: 'arn:aws:iam::111122223333:role/merchantflo-staging-task-execution',
    networkMode: 'awsvpc',
    requiresCompatibilities: ['FARGATE'],
    compatibilities: ['EC2', 'FARGATE'],
    requiresAttributes: [{ name: 'com.amazonaws.ecs.capability.logging-driver.awslogs' }],
    cpu: '512',
    memory: '1024',
    runtimePlatform: { operatingSystemFamily: 'LINUX', cpuArchitecture: 'X86_64' },
    volumes: [{ name: 'tmp' }],
    registeredAt: '2026-10-15T10:00:00.000Z',
    registeredBy: 'arn:aws:sts::111122223333:assumed-role/deployer',
    containerDefinitions: [
      {
        name: 'app',
        image: '111122223333.dkr.ecr.ap-south-1.amazonaws.com/merchantflo:aaaaaaa',
        environment: [{ name: 'ROLE', value: 'api' }],
        secrets: [{ name: 'DATABASE_URL', valueFrom: 'arn:aws:secretsmanager:ap-south-1:111122223333:secret:merchantflo-staging/DATABASE_URL' }],
      },
      { name: 'log-router', image: 'public.ecr.aws/aws-observability/aws-for-fluent-bit:2.32.0' },
    ],
  },
  tags: [],
});

const NEW = '111122223333.dkr.ecr.ap-south-1.amazonaws.com/merchantflo:bbbbbbb';

describe('rendering a task definition for a new image', () => {
  it('drops the fields register-task-definition refuses', () => {
    const out = renderTaskDefinition(described(), NEW);
    for (const field of ['taskDefinitionArn', 'revision', 'status', 'requiresAttributes', 'compatibilities', 'registeredAt', 'registeredBy']) {
      expect(out, field).not.toHaveProperty(field);
    }
  });

  it("changes only the app container's image and keeps everything else", () => {
    const before = described().taskDefinition;
    const out = renderTaskDefinition(described(), NEW);
    expect(out.containerDefinitions[0]).toEqual({ ...before.containerDefinitions[0], image: NEW });
    expect(out.containerDefinitions[1]).toEqual(before.containerDefinitions[1]);
    expect(out).toMatchObject({ family: before.family, cpu: '512', memory: '1024', executionRoleArn: before.executionRoleArn, volumes: [{ name: 'tmp' }] });
  });

  it('accepts the bare task definition as well as the describe output', () => {
    expect(renderTaskDefinition(described().taskDefinition, NEW).containerDefinitions[0]!.image).toBe(NEW);
  });

  it('refuses a task definition without an app container', () => {
    const d = described();
    d.taskDefinition.containerDefinitions = d.taskDefinition.containerDefinitions.filter((c) => c.name !== 'app');
    expect(() => renderTaskDefinition(d, NEW)).toThrow('no container named "app"');
  });

  it('refuses an image without a tag or digest (no silent "latest")', () => {
    expect(() => renderTaskDefinition(described(), '111122223333.dkr.ecr.ap-south-1.amazonaws.com/merchantflo')).toThrow('tag or digest');
  });
});
