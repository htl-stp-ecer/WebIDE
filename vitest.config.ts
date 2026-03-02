import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: [
      'src/app/project-view/flowchart/table/models/pose2d.spec.ts',
      'src/app/project-view/flowchart/table/planning/line-utils.spec.ts',
      'src/app/project-view/flowchart/table/planning/path-to-steps.spec.ts',
      'src/app/project-view/flowchart/table/planning/path-optimizer.spec.ts',
    ],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html'],
      reportsDirectory: 'coverage/vitest',
      include: [
        'src/app/project-view/flowchart/table/models/pose2d.ts',
        'src/app/project-view/flowchart/table/planning/line-utils.ts',
        'src/app/project-view/flowchart/table/planning/path-to-steps.ts',
      ],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90,
      },
    },
  },
});
