import {
  runCliPrompt,
  runSubAgent,
  type CliProvider,
  type DecomposedTask,
  type RuntimeSubTask,
} from './cliRuntime';
import type { WorkflowExecutionProfile } from './workflow';
import { extractArtifacts, type Artifact } from '../components/harness-utils';
import { abortLearningAgentLoop, beginLearningAgentLoop, formatLearningAgentLoopContext } from './learningAgentLoop';
import type { LearningProvider, LearningProviderRegistry } from './learningProviders';

export interface ExecuteDecomposedSubAgentsParams {
  userMessage: string;
  selectedTasks: DecomposedTask[];
  workDir: string;
  synthesisProvider: CliProvider;
  executionProfile: WorkflowExecutionProfile;
  threadSummary?: string;
  providersOrRegistry?: LearningProvider[] | LearningProviderRegistry;
  onPipelineUpdate?: (tasks: RuntimeSubTask[]) => void;
  onStreamingContent?: (text: string) => void;
}

export interface ExecuteDecomposedSubAgentsResult {
  pipeline: RuntimeSubTask[];
  mainContent: string;
  artifacts: Artifact[];
  durationMs: number;
  followupSource: string;
}

export async function executeDecomposedSubAgents(
  params: ExecuteDecomposedSubAgentsParams,
): Promise<ExecuteDecomposedSubAgentsResult> {
  const startTime = Date.now();
  const loopContext = await beginLearningAgentLoop({
    workDir: params.workDir,
    query: params.userMessage,
    threadSummary: params.threadSummary,
    providersOrRegistry: params.providersOrRegistry,
  });
  const learningContext = formatLearningAgentLoopContext(loopContext);
  const subTasks: RuntimeSubTask[] = params.selectedTasks.map((task, index) => ({
    id: `sub-${index}-${Date.now()}`,
    description: task.description,
    provider: task.provider,
    status: 'pending',
  }));

  try {
    params.onPipelineUpdate?.([...subTasks]);

    await Promise.all(params.selectedTasks.map(async (task, index) => {
      subTasks[index].status = 'running';
      subTasks[index].startedAt = Date.now();
      params.onPipelineUpdate?.([...subTasks]);
      try {
        const taskPrompt = learningContext
          ? `${task.prompt}\n\nRelevant self-improving recall:\n${learningContext}`
          : task.prompt;
        const result = await runSubAgent(
          { ...task, prompt: taskPrompt },
          params.workDir,
          params.executionProfile.subAgentTimeoutSecs,
        );
        subTasks[index].status = 'completed';
        subTasks[index].result = result;
        subTasks[index].durationMs = Date.now() - (subTasks[index].startedAt || Date.now());
      } catch (error) {
        subTasks[index].status = 'failed';
        subTasks[index].error = String(error);
        subTasks[index].durationMs = Date.now() - (subTasks[index].startedAt || Date.now());
      }
      params.onPipelineUpdate?.([...subTasks]);
    }));

    const successResults = subTasks.filter((task) => task.status === 'completed' && task.result);

    if (successResults.length === 0) {
      const rawSummary = subTasks
        .map((task, index) => `[${index + 1}] ${task.description}: ${task.error || '(failed)'}`)
        .join('\n');
      return {
        pipeline: [...subTasks],
        mainContent: rawSummary,
        artifacts: [],
        durationMs: Date.now() - startTime,
        followupSource: rawSummary,
      };
    }

    params.onStreamingContent?.('Synthesizing sub-agent results...');

    const truncatedSummary = successResults
      .map((task, index) => `[${index + 1}] ${task.description}: ${(task.result || '').slice(0, 800)}`)
      .join('\n\n');
    const synthPrompt = [
      `User asked: "${params.userMessage.slice(0, 200)}"`,
      learningContext ? `Relevant self-improving recall:\n${learningContext}` : '',
      `Results:\n${truncatedSummary}`,
      'Synthesize into one coherent response.',
    ].filter(Boolean).join('\n\n');

    let finalContent = '';
    try {
      finalContent = await runCliPrompt(
        params.synthesisProvider,
        synthPrompt,
        params.workDir,
        params.executionProfile.directConversationTimeoutSecs,
      );
    } catch {
      finalContent = truncatedSummary;
    }

    return {
      pipeline: [...subTasks],
      mainContent: finalContent || truncatedSummary,
      artifacts: extractArtifacts(finalContent || truncatedSummary),
      durationMs: Date.now() - startTime,
      followupSource: finalContent || truncatedSummary,
    };
  } finally {
    await abortLearningAgentLoop(loopContext);
  }
}
