import {
  runHarnessAgentTurn,
  runHarnessModeTurn,
  runHarnessSubAgentTurn,
  runHarnessWorkflowTurn,
  type HarnessAgentLoopTurnParams,
} from './agentLoopRunner';
import type { HarnessRuntime } from './runtimeFactoryTypes';

export function createHarnessAgentLoopRuntime(runtime: HarnessRuntime): HarnessRuntime['agentLoop'] {
  return {
    runTurn: (params) => runHarnessAgentTurn({
      ...params,
      harnessRuntime: runtime,
    } as HarnessAgentLoopTurnParams<any>),
    runModeTurn: (params) => runHarnessModeTurn({
      ...params,
      harnessRuntime: runtime,
    }),
    runWorkflowTurn: (params) => runHarnessWorkflowTurn({
      ...params,
      harnessRuntime: runtime,
    }),
    runSubAgentTurn: (params) => runHarnessSubAgentTurn({
      ...params,
      harnessRuntime: runtime,
    }),
  };
}
