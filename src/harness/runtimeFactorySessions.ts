import { runModeSession } from './modeSessionExecutor';
import { executeDecomposedSubAgents } from './subAgentExecutor';
import {
  runWorkflowPlanReviewSelection,
  runWorkflowSessionStart,
  runWorkflowSpecReviewSelection,
} from './workflowSessionExecutor';
import { executeTodoTask } from './todoExecutor';
import { prepareDirectResponseContext } from './middleware';
import type { HarnessRuntime, HarnessRuntimeFactoryOptions } from './runtimeFactoryTypes';

export function createHarnessSessionRuntime(params: {
  options: HarnessRuntimeFactoryOptions;
  learningProviderRegistry: HarnessRuntime['selfImproving']['providerRegistry'];
}): HarnessRuntime['sessions'] {
  const { options, learningProviderRegistry } = params;
  const directResponseAssembly = options.directResponse;

  return {
    runModeSession: (sessionParams) => runModeSession({
      ...sessionParams,
      responseLanguage: options.responseLanguage,
      providersOrRegistry: learningProviderRegistry,
      middlewareAssembly: directResponseAssembly,
      prepareDirectResponseContext,
    }),
    runWorkflowSessionStart: (sessionParams) => runWorkflowSessionStart({
      ...sessionParams,
      providersOrRegistry: learningProviderRegistry,
    }),
    runWorkflowSpecReviewSelection: (sessionParams) => runWorkflowSpecReviewSelection({
      ...sessionParams,
      providersOrRegistry: learningProviderRegistry,
    }),
    runWorkflowPlanReviewSelection: (sessionParams) => runWorkflowPlanReviewSelection({
      ...sessionParams,
      providersOrRegistry: learningProviderRegistry,
    }),
    executeTodoTask,
    executeDecomposedSubAgents: (sessionParams) => executeDecomposedSubAgents({
      ...sessionParams,
      providersOrRegistry: learningProviderRegistry,
    }),
  };
}
