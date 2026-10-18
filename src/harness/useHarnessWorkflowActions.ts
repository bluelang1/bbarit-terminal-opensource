import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { HarnessRuntime } from './runtimeFactory';
import type { AiProvider } from './panelTypes';
import { ATLAS_CN_STAGE_MODELS } from './workflow';
import type { WorkflowConfig, WorkflowEffort, WorkflowStage } from './workflow';

interface HarnessWorkflowActionsParams {
  harnessRuntime: Pick<HarnessRuntime, 'workflow'>;
  backgroundProvider: AiProvider;
  backgroundModel?: string;
  setWorkflow: Dispatch<SetStateAction<WorkflowConfig>>;
  genId: () => string;
}

export function useHarnessWorkflowActions(params: HarnessWorkflowActionsParams) {
  const moveStage = useCallback((index: number, dir: -1 | 1) => {
    params.setWorkflow((prev) => {
      const stages = [...prev.stages];
      const target = index + dir;
      if (target < 0 || target >= stages.length) return prev;
      [stages[index], stages[target]] = [stages[target], stages[index]];
      return { ...prev, id: 'custom', name: 'Custom', stages };
    });
  }, [params]);

  const addWorkflowStage = useCallback(() => {
    params.setWorkflow((prev) => ({
      ...prev,
      id: 'custom',
      name: 'Custom',
      stages: [
        ...prev.stages,
        {
          id: params.genId(),
          name: 'New Stage',
          provider: params.backgroundProvider,
          model: params.backgroundModel || ATLAS_CN_STAGE_MODELS.custom,
          role: 'custom',
          promptTemplate: 'implement',
          enabled: true,
        },
      ],
    }));
  }, [params]);

  const removeWorkflowStage = useCallback((index: number) => {
    params.setWorkflow((prev) => ({
      ...prev,
      id: 'custom',
      name: 'Custom',
      stages: prev.stages.filter((_, i) => i !== index),
    }));
  }, [params]);

  const updateWorkflowStage = useCallback((index: number, patch: Partial<WorkflowStage>) => {
    params.setWorkflow((prev) => ({
      ...prev,
      id: 'custom',
      name: 'Custom',
      stages: prev.stages.map((stage, i) => (i === index ? { ...stage, ...patch } : stage)),
    }));
  }, [params]);

  const applyWorkflowPreset = useCallback((preset: WorkflowConfig) => {
    params.setWorkflow(params.harnessRuntime.workflow.cloneWorkflowConfig(preset));
  }, [params]);

  const applyBackgroundProviderToWorkflow = useCallback(() => {
    params.setWorkflow(prev => params.harnessRuntime.workflow.applyProviderToWorkflow(prev, params.backgroundProvider, params.backgroundModel));
  }, [params]);

  const updateWorkflowEffort = useCallback((effort: WorkflowEffort) => {
    params.setWorkflow((prev) => ({
      ...prev,
      id: 'custom',
      name: effort === 'extreme' ? 'Extreme' : (prev.name === 'Extreme' ? 'Custom' : prev.name),
      effort,
    }));
  }, [params]);

  return {
    moveStage,
    addWorkflowStage,
    removeWorkflowStage,
    updateWorkflowStage,
    applyWorkflowPreset,
    applyBackgroundProviderToWorkflow,
    updateWorkflowEffort,
  };
}
