import { createHarnessAgentLoopRuntime } from './runtimeFactoryAgentLoop';
import { createHarnessFoundationRuntime } from './runtimeFactoryFoundation';
import { createHarnessLearningRuntime } from './runtimeFactoryLearning';
import { createHarnessSessionRuntime } from './runtimeFactorySessions';
import type { HarnessRuntime, HarnessRuntimeFactoryOptions } from './runtimeFactoryTypes';

export type {
  HarnessLearningRuntimeAssembly,
  HarnessRuntime,
  HarnessRuntimeFactoryOptions,
  StripHarnessRuntime,
  StripHarnessRuntimeOutcome,
} from './runtimeFactoryTypes';

export function createHarnessRuntime(options: HarnessRuntimeFactoryOptions): HarnessRuntime {
  const foundation = createHarnessFoundationRuntime(options);
  const learning = options.learningAssembly || createHarnessLearningRuntime();

  const runtime = {
    ...foundation,
    selfImproving: learning.selfImproving,
    sessions: createHarnessSessionRuntime({
      options,
      learningProviderRegistry: learning.learningProviderRegistry,
    }),
  } as HarnessRuntime;

  runtime.agentLoop = createHarnessAgentLoopRuntime(runtime);

  return runtime;
}
