import { useCallback, useMemo, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { MemoryEntry } from '../harness/panelTypes';

interface UseAgentHarnessMemoryParams {
  memories: MemoryEntry[];
  setMemories: Dispatch<SetStateAction<MemoryEntry[]>>;
  genId: () => string;
}

export function useAgentHarnessMemory(params: UseAgentHarnessMemoryParams) {
  const [memoryInput, setMemoryInput] = useState('');

  const addMemory = useCallback((content: string, source: string) => {
    params.setMemories((prev) => [
      ...prev,
      { id: params.genId(), content, source, createdAt: Date.now() },
    ]);
  }, [params]);

  const deleteMemory = useCallback((id: string) => {
    params.setMemories((prev) => prev.filter((memory) => memory.id !== id));
  }, [params]);

  const togglePinMemory = useCallback((id: string) => {
    params.setMemories((prev) => prev.map((memory) => (
      memory.id === id ? { ...memory, pinned: !memory.pinned } : memory
    )));
  }, [params]);

  const submitMemoryInput = useCallback(() => {
    const nextValue = memoryInput.trim();
    if (!nextValue) return;

    addMemory(nextValue, 'manual');
    setMemoryInput('');
  }, [addMemory, memoryInput]);

  const sortedMemories = useMemo(() => {
    return [...params.memories].sort((left, right) => (
      Number(Boolean(right.pinned)) - Number(Boolean(left.pinned))
    ));
  }, [params.memories]);

  return {
    memoryInput,
    setMemoryInput,
    sortedMemories,
    addMemory,
    deleteMemory,
    togglePinMemory,
    submitMemoryInput,
  };
}
