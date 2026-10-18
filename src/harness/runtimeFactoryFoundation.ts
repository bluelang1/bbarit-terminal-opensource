import { generateFollowupsAi } from './contentRuntime';
import {
  buildHarnessStorageKeys,
  parsePersistedValue,
  snapshotMemoriesForPersistence,
  snapshotThreadsForPersistence,
} from './threadRuntime';
import { getRunnableSelectedTodos, toggleSelectionId } from './panelState';
import { buildHarnessPanelViewModel } from './panelViewModel';
import {
  beginHarnessSubmission,
  createNewCodingThread,
  insertThreadAtTop,
  removeThreadById,
  updateThreadById,
} from './panelSessionRuntime';
import { buildWorkflowStartSeed, toConversationMessages } from './submissionRuntime';
import { determineSubmissionRoute } from './submissionCoordinator';
import { getDirectResponseMiddlewareNames, prepareDirectResponseContext } from './middleware';
import { getModeFeatureProfile, resolveEffectiveCliProvider } from './runtimeFeatures';
import { appendAssistantMessageToThread } from './threadSessionRuntime';
import {
  DEFAULT_WORKFLOW,
  WORKFLOW_PRESETS,
  applyProviderToWorkflow,
  cloneWorkflowConfig,
  getWorkflowExecutionProfile,
} from './workflow';
import type { HarnessRuntime, HarnessRuntimeFactoryOptions } from './runtimeFactoryTypes';

export function createHarnessFoundationRuntime(
  options: HarnessRuntimeFactoryOptions,
): Pick<
  HarnessRuntime,
  | 'featureProfile'
  | 'features'
  | 'backgroundProvider'
  | 'providers'
  | 'content'
  | 'middleware'
  | 'storage'
  | 'panel'
  | 'selection'
  | 'submission'
  | 'thread'
  | 'workflow'
> {
  const featureProfile = getModeFeatureProfile(options.mode);
  const directResponseAssembly = options.directResponse;

  return {
    featureProfile,
    features: {
      getModeProfile: getModeFeatureProfile,
    },
    backgroundProvider: options.backgroundProvider,
    providers: {
      ensureCliProvider: options.ensureCliProvider,
      resolveEffectiveCliProvider: (provider = options.provider) =>
        resolveEffectiveCliProvider(options.mode, provider, options.ensureCliProvider),
    },
    content: {
      generateFollowupsAi,
    },
    middleware: {
      assembly: directResponseAssembly,
      names: getDirectResponseMiddlewareNames,
      prepareContext: (input, assembly) => prepareDirectResponseContext(input, assembly),
    },
    storage: {
      buildHarnessStorageKeys,
      parsePersistedValue,
      snapshotMemoriesForPersistence,
      snapshotThreadsForPersistence,
    },
    panel: {
      buildViewModel: buildHarnessPanelViewModel,
      beginSubmission: beginHarnessSubmission,
      createNewCodingThread,
      insertThreadAtTop,
      removeThreadById,
      updateThreadById,
    },
    selection: {
      getRunnableSelectedTodos,
      toggleSelectionId,
    },
    submission: {
      buildWorkflowStartSeed,
      toConversationMessages,
      determineSubmissionRoute,
    },
    thread: {
      appendAssistantMessageToThread,
    },
    workflow: {
      DEFAULT_WORKFLOW,
      WORKFLOW_PRESETS,
      applyProviderToWorkflow,
      cloneWorkflowConfig,
      getWorkflowExecutionProfile,
    },
  };
}
